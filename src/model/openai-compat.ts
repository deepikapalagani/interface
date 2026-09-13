/**
 * THE DEFAULT ADAPTER — any OpenAI-compatible endpoint.
 *
 * One adapter covers Z.ai (GLM), Google's Gemini free tier, Ollama and LM Studio,
 * because they all speak the same wire format. Switching provider is a base URL
 * and a model name, which is what makes "this project costs nothing to run" a
 * configuration choice rather than an architectural one.
 *
 * Everything unusual in here is a measured finding (2026-09-12, GLM-4.7-Flash
 * via Z.ai), not defensive habit:
 *
 *   429s ARE ROUTINE. Roughly 2 in 8 calls returned "service temporarily
 *   overloaded", including on a first call, and every one cleared on retry. A
 *   bare 429 partway through a 30-turn discovery run would derail the one run
 *   that has to be genuine, so backoff lives here rather than in the caller.
 *
 *   REASONING MODELS SPEND OUTPUT BEFORE THEY SPEAK. A 16-token cap returned
 *   `finish_reason: "length"` with EMPTY content and a full `reasoning_content`.
 *   That reads as "the model refuses to use tools" when it is really truncation,
 *   so `max_tokens` is generous by default and truncation is reported explicitly.
 *
 * ── EVERY FAILURE OF ONE ATTEMPT IS RETRIED, NOT JUST AN HTTP STATUS ────────
 *
 * The retry loop used to cover exactly two cases — a 429 and a 5xx — while three
 * others escaped it unretried on the very first attempt:
 *
 *   - a TRANSPORT error (`TypeError: fetch failed` from a reset connection, a DNS
 *     blip, a TLS failure) threw straight out of `post`;
 *   - a 200 carrying an HTML body threw `SyntaxError` out of `JSON.parse`;
 *   - a HUNG endpoint blocked forever, because `fetch` was given no signal and
 *     the run's 300-second ceiling is only consulted between turns.
 *
 * All three have the same blast radius as the 429 this module was written for, on
 * the one run the brief requires to be genuine. So each attempt now carries an
 * `AbortSignal` deadline and is wrapped: anything that leaves one attempt without
 * a usable body is retried with the same backoff, and the final throw names what
 * actually went wrong.
 *
 * THE STEP BUDGET IS A BETWEEN-TURNS CHECK, and this adapter's own timeout is the
 * only thing bounding a single call. `StopController.beginStep` evaluates elapsed
 * time before a turn starts; it cannot fire while the loop is parked inside an
 * await. `requestTimeoutMs` x `maxRetries` is therefore the real worst case for
 * one turn, and it is a configuration choice rather than an accident.
 */
import type {
  ConverseOptions,
  ConverseResponse,
  ModelProvider,
  StopReason,
  ToolCall,
  Turn,
  Usage,
} from "./provider.js";

export interface OpenAICompatConfig {
  readonly id: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  /** Retries on 429, 5xx, a transport error and an unparseable body. Measured need: ~25% of calls on the free tier. */
  readonly maxRetries?: number;
  /** Per-ATTEMPT deadline. The loop's own ceiling cannot interrupt an in-flight call. */
  readonly requestTimeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly fetchImpl?: typeof fetch;
}

interface WireMessage {
  role: string;
  content?: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const toStopReason = (finish: string | undefined): StopReason => {
  switch (finish) {
    case "tool_calls":
      return "tool_calls";
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
};

/** Assistant turns are replayed from their opaque payload, never reconstructed. */
const toWire = (turn: Turn): WireMessage => {
  switch (turn.role) {
    case "system":
    case "user":
      return { role: turn.role, content: turn.content };
    case "assistant":
      // The raw payload is this adapter's own earlier message. Passing it back
      // unchanged is what preserves provider-specific fields the loop never sees.
      return (turn.raw as WireMessage | undefined) ?? { role: "assistant", content: turn.content };
    case "tool":
      return { role: "tool", tool_call_id: turn.callId, content: turn.content };
  }
};

/** What one attempt produced: a usable body, or a reason to try again. */
type Attempt =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly retryable: boolean; readonly why: string };

export class OpenAICompatProvider implements ModelProvider {
  readonly id: string;
  /**
   * HTTP requests made, for the run manifest. Incremented once per ATTEMPT,
   * which is what the field claims: one `converse()` that cleared on the fifth
   * try made five requests, and reporting 1 under-counts exactly the traffic a
   * reviewer would check a rate limit against.
   */
  private requests = 0;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  get calls(): number {
    return this.requests;
  }
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly doFetch: typeof fetch;

  constructor(private readonly config: OpenAICompatConfig) {
    this.id = config.id;
    // Six attempts with capped exponential backoff is roughly a minute of
    // patience — the right trade for a free tier where a run costs nothing but
    // losing one costs a whole discovery.
    this.maxRetries = config.maxRetries ?? 6;
    this.timeoutMs = config.requestTimeoutMs ?? 60_000;
    this.sleep = config.sleep ?? defaultSleep;
    this.doFetch = config.fetchImpl ?? fetch;
  }

  /** One attempt, bounded by its own deadline. Never throws: it classifies. */
  private async attempt(body: Readonly<Record<string, unknown>>): Promise<Attempt> {
    this.requests += 1;
    // A hung endpoint is the failure a timeout exists for, and the only thing
    // that can end one from inside the adapter.
    const signal = AbortSignal.timeout(this.timeoutMs);

    let res: Response;
    try {
      res = await this.doFetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({ model: this.config.model, ...body }),
        signal,
      });
    } catch (e) {
      // A transport failure or the deadline above. Both are transient by nature,
      // and both used to end a run on their first occurrence.
      const why = e instanceof Error ? e.message : String(e);
      return { ok: false, retryable: true, why: signal.aborted ? `no response within ${this.timeoutMs}ms` : `transport error: ${why}` };
    }

    let text: string;
    try {
      text = await res.text();
    } catch (e) {
      return { ok: false, retryable: true, why: `body could not be read: ${e instanceof Error ? e.message : String(e)}` };
    }

    if (!res.ok) {
      return { ok: false, retryable: res.status === 429 || res.status >= 500, why: `HTTP ${res.status} — ${text.slice(0, 300)}` };
    }

    try {
      return { ok: true, body: JSON.parse(text) as Record<string, unknown> };
    } catch {
      // MEASURED as reachable: a gateway can answer 200 with an HTML error page,
      // and this used to throw past the retry loop as a SyntaxError.
      return { ok: false, retryable: true, why: `a 200 whose body is not JSON — ${text.slice(0, 300)}` };
    }
  }

  /** Never interpolates the key into a message, so it cannot reach a log. */
  private async post(body: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    let last = "no attempt was made";
    // Counted for THIS call. `this.requests` is the provider's lifetime total —
    // the number `calls` exists to report — and interpolating it here made the
    // message over-report: measured, a provider at `maxRetries: 2` whose second
    // call failed said "giving up after 4 HTTP attempt(s)" for a call that made
    // two. A fresh provider per test is what hid it.
    let attempts = 0;

    for (let n = 1; n <= this.maxRetries; n++) {
      attempts = n;
      const result = await this.attempt(body);
      if (result.ok) return result.body;

      last = result.why;
      if (!result.retryable || n === this.maxRetries) break;

      // Exponential, capped. The first version waited attempt*2s over 4 tries —
      // 12 seconds total — which was tuned against isolated calls seconds apart.
      // A discovery loop fires back to back, and the free tier pushes back much
      // harder under that pattern: four consecutive 429s ended a whole run.
      await this.sleep(Math.min(1000 * 2 ** n, 15_000));
    }

    throw new Error(`${this.config.id}: giving up after ${attempts} HTTP attempt(s) for this call — ${last}`);
  }

  async converse(history: readonly Turn[], options: ConverseOptions): Promise<ConverseResponse> {
    const payload: Record<string, unknown> = {
      messages: history.map(toWire),
      max_tokens: options.maxTokens,
    };

    if (options.tools.length > 0) {
      payload["tools"] = options.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      payload["tool_choice"] = options.toolChoice;
    }

    const json = await this.post(payload);
    const choice = (json["choices"] as { message?: WireMessage; finish_reason?: string }[] | undefined)?.[0];
    const message = choice?.message;

    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function.name,
      // Arguments arrive as a JSON string and are NOT schema-guaranteed. Parsing
      // failure is surfaced as empty args so the caller can retry with the
      // validation error rather than crash on malformed output.
      args: safeParseArgs(c.function.arguments),
    }));

    return {
      text: message?.content ?? "",
      toolCalls,
      raw: message,
      usage: readUsage(json, message),
      stopReason: toStopReason(choice?.finish_reason),
    };
  }
}

const safeParseArgs = (raw: string): Readonly<Record<string, unknown>> => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const readUsage = (json: Record<string, unknown>, message: WireMessage | undefined): Usage => {
  const u = json["usage"] as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  const reasoning = (message as { reasoning_content?: string } | undefined)?.reasoning_content;
  return {
    promptTokens: u?.prompt_tokens ?? 0,
    completionTokens: u?.completion_tokens ?? 0,
    ...(reasoning ? { reasoningChars: reasoning.length } : {}),
  };
};
