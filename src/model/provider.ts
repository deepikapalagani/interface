/**
 * THE PROVIDER SEAM — one interface, any model, and none of them in replay.
 *
 * §4 puts "LLM provider / model" explicitly in the candidate's hands, and this
 * project takes that seriously in a specific way: development runs on a free
 * tier, the graded discovery run can move to whatever is most reliable, and
 * neither decision touches a line of the system above this file.
 *
 * This module imports NO SDK. That is deliberate and load-bearing — it is what
 * lets `verify-no-llm.ts` forbid `src/model/**` from the replay import graph
 * while the interface itself stays free of dependencies.
 *
 * THE OPAQUE `raw` IS THE KEY DESIGN CHOICE. A provider-neutral history that
 * flattened every turn to `{role, text}` would be a lowest-common-denominator
 * format, and it would quietly break both providers: Anthropic requires thinking
 * blocks echoed back verbatim on the next turn, while an OpenAI-compatible
 * endpoint needs its own `tool_calls` shape preserved. So each assistant turn
 * carries an opaque payload that ONLY the adapter which produced it ever
 * deserializes. The loop moves turns around without understanding them.
 *
 * MEASURED (2026-09-12, GLM-4.7-Flash via Z.ai) and encoded in this contract:
 *   - tool calling works under both `auto` and `required`;
 *   - `json_schema` with `strict: true` is NOT honoured — it returned fenced
 *     markdown AND ignored the schema — so `parseJson` promises only that it
 *     returns parsed JSON, and callers MUST validate with their own schema;
 *   - roughly 2 in 8 calls return a 429, so retry-with-backoff is part of the
 *     adapter's contract rather than a caller's problem;
 *   - reasoning models spend output tokens before emitting anything, so a tight
 *     `maxTokens` yields an empty response rather than an error.
 */

/** A tool the model may call. Arguments are described by a JSON Schema object. */
export interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
}

/** One call the model asked for. `args` is raw — the caller validates it. */
export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export type Turn =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string;
      readonly toolCalls: readonly ToolCall[];
      /**
       * Provider-specific payload for this exact turn. Opaque by contract: only
       * the adapter that produced it may interpret it, and the loop must pass it
       * back unchanged.
       */
      readonly raw: unknown;
    }
  | { readonly role: "tool"; readonly callId: string; readonly content: string };

export interface Usage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  /** Reasoning models bill thinking as output; surfaced so cost stays measurable. */
  readonly reasoningChars?: number;
}

export type StopReason = "tool_calls" | "end_turn" | "max_tokens" | "refusal" | "other";

export interface ConverseResponse {
  readonly text: string;
  readonly toolCalls: readonly ToolCall[];
  readonly raw: unknown;
  readonly usage: Usage;
  readonly stopReason: StopReason;
}

export interface ConverseOptions {
  readonly tools: readonly ToolSpec[];
  /** `required` forces an action every turn, which the discovery loop relies on. */
  readonly toolChoice: "auto" | "required";
  /** Generous by necessity: a reasoning model spends output before it speaks. */
  readonly maxTokens: number;
  /** Off for the mechanical compile pass, on for the decision loop. */
  readonly reasoning: boolean;
}

/**
 * Everything the system needs from a model. Two methods, because the loop and
 * the compile step want genuinely different things: a conversation that calls
 * tools, and a single structured extraction.
 */
export interface ModelProvider {
  /** Stable identifier for the manifest, so a run records what actually drove it. */
  readonly id: string;

  /**
   * How many requests this provider has actually made.
   *
   * Optional so a fake (cassette, test double) need not implement it, but a real
   * adapter must: a run manifest reporting a hardcoded count is worse than none,
   * because `model.calls` is the field carrying the replay path's central claim.
   * A discovery manifest that falsely says zero devalues the replay manifest that
   * truthfully says zero.
   */
  readonly calls?: number;

  converse(history: readonly Turn[], options: ConverseOptions): Promise<ConverseResponse>;

  /**
   * One structured extraction.
   *
   * Returns parsed JSON and nothing stronger: schema enforcement is NOT
   * guaranteed by any provider we target, so the caller validates with Zod and
   * retries with the validation error appended. Promising more here would be a
   * contract the measurements do not support.
   */
  parseJson(prompt: string, options: { maxTokens: number }): Promise<{ value: unknown; usage: Usage }>;
}

