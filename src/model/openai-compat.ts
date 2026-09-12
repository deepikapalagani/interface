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
 *   STRICT SCHEMAS ARE NOT HONOURED. `json_schema` with `strict: true` returned
 *   fenced markdown AND ignored the schema. `json_object` returned exactly the
 *   requested shape, so that is what `parseJson` uses — and it still strips
 *   fences defensively and leaves validation to the caller's Zod schema.
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
  /** Retries on 429 and 5xx. Measured need: ~25% of calls on the free tier. */
  readonly maxRetries?: number;
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

/** Some providers wrap JSON in a markdown fence despite being asked not to. */
const stripFence = (s: string): string => {
  const fenced = /^[\s\S]*?```(?:json)?\s*([\s\S]*?)```[\s\S]*$/.exec(s);
  return (fenced?.[1] ?? s).trim();
};

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

export class OpenAICompatProvider implements ModelProvider {
  readonly id: string;
  /** Real requests made, for the run manifest. Counted, never assumed. */
  private requests = 0;
  private readonly maxRetries: number;

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
    this.sleep = config.sleep ?? defaultSleep;
    this.doFetch = config.fetchImpl ?? fetch;
  }

  /** Never interpolates the key into a message, so it cannot reach a log. */
  private async post(body: Readonly<Record<string, unknown>>): Promise<Record<string, unknown>> {
    let lastStatus = 0;
    let lastBody = "";

    this.requests += 1;
    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const res = await this.doFetch(`${this.config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify({ model: this.config.model, ...body }),
      });
      const text = await res.text();

      if (res.ok) return JSON.parse(text) as Record<string, unknown>;

      lastStatus = res.status;
      lastBody = text.slice(0, 300);

      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === this.maxRetries) break;

      // Exponential, capped. The first version waited attempt*2s over 4 tries —
      // 12 seconds total — which was tuned against isolated calls seconds apart.
      // A discovery loop fires back to back, and the free tier pushes back much
      // harder under that pattern: four consecutive 429s ended a whole run.
      await this.sleep(Math.min(1000 * 2 ** attempt, 15_000));
    }

    throw new Error(`${this.config.id}: ${lastStatus} after ${this.maxRetries} attempt(s) — ${lastBody}`);
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
    // Disabling reasoning takes a call from ~3-8s to ~0.8s. Used for mechanical
    // work; left on where the model actually has to decide something.
    if (!options.reasoning) payload["thinking"] = { type: "disabled" };

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

  async parseJson(prompt: string, options: { maxTokens: number }): Promise<{ value: unknown; usage: Usage }> {
    const json = await this.post({
      messages: [{ role: "user", content: prompt }],
      max_tokens: options.maxTokens,
      // Measured: this mode returns the requested shape; `json_schema` + strict
      // does not. The caller still validates — this only guarantees JSON.
      response_format: { type: "json_object" },
    });

    const choice = (json["choices"] as { message?: WireMessage }[] | undefined)?.[0];
    const content = choice?.message?.content ?? "";

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      value = JSON.parse(stripFence(content));
    }
    return { value, usage: readUsage(json, choice?.message) };
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
