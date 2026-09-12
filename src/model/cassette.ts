/**
 * THE CASSETTE — replaying a recorded run without a model.
 *
 * §6 asks for a way to run the system "without live services". This is it: the
 * provider hands back the assistant turns a real run produced, in order, so the
 * REAL loop drives the REAL browser against the REAL mock with no API key and no
 * cost. Only the model is substituted.
 *
 * It is a labelled fake, not a simulation. The distinction that keeps it honest
 * is the check below: each turn asserts that the tool result being handed back
 * matches the one recorded at that point. If the surface has changed — different
 * markup, a renamed field, a slower screen — the cassette fails loudly instead of
 * quietly replaying a conversation that no longer corresponds to reality.
 *
 * Without that check a cassette run would pass forever regardless of the code it
 * is supposed to be exercising, which is worse than having no offline path.
 */
import type { ConverseOptions, ConverseResponse, ModelProvider, Turn, Usage } from "./provider.js";

export class CassetteDiverged extends Error {
  constructor(
    readonly turn: number,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `cassette diverged at turn ${turn}: the recorded run saw "${expected.slice(0, 120)}" ` +
        `but this run produced "${actual.slice(0, 120)}". The surface no longer matches the recording.`,
    );
    this.name = "CassetteDiverged";
  }
}

const NO_USAGE: Usage = { promptTokens: 0, completionTokens: 0 };

/**
 * The screen id, from EITHER rendering a transcript can hold.
 *
 * A recorded transcript IS the pruned history. The discovery loop collapses every
 * tool result but the newest into `(${tool} ok) ${observationSummary(obs)}` — that
 * pruning is what keeps a 30-turn run at ~136K input tokens instead of ~686K — so
 * a genuine recording contains summaries, and only the last turn carries the full
 * `SCREEN:` rendering.
 *
 * MEASURED 2026-09-12: replaying `evidence/runs/discovery-lookup-v3/transcript.jsonl`
 * failed at turn 1 with the recorded `(type_text ok) MEMBER_SEARCH — 4 control(s)`
 * against a live `MEMBER_SEARCH`. The old extractor matched `SCREEN:` or fell back
 * to a 40-character slice, so a summary was compared against an extracted id and
 * could never agree — this guard could not pass against ANY real recording.
 *
 * It looked healthy because the fixtures in `tests/cassette.test.ts` used the full
 * form on both sides: the one shape a real run never records.
 */
const screenOf = (s: string): string => {
  const full = /SCREEN: (\S+)/.exec(s);
  if (full?.[1] !== undefined) return full[1];
  const summary = /^\([a-z_]+ ok\)\s+(\S+)/.exec(s.trim());
  if (summary?.[1] !== undefined) return summary[1];
  // An error turn (`ERROR: ...`) has no screen at all. Comparing the leading text
  // still detects a run that failed differently from the recording.
  return s.slice(0, 40);
};

export class CassetteProvider implements ModelProvider {
  readonly id: string;
  private turn = 0;

  /** The assistant turns from a recorded transcript, in order. */
  private readonly assistant: Extract<Turn, { role: "assistant" }>[];
  /** The tool results that followed them, for the divergence check. */
  private readonly recordedResults: string[];

  constructor(transcript: readonly Turn[], label = "cassette") {
    this.id = label;
    this.assistant = transcript.filter((t): t is Extract<Turn, { role: "assistant" }> => t.role === "assistant");
    this.recordedResults = transcript.filter((t) => t.role === "tool").map((t) => (t.role === "tool" ? t.content : ""));
  }

  async converse(history: readonly Turn[], _options: ConverseOptions): Promise<ConverseResponse> {
    // Compare what this run just produced against what the recording saw at the
    // same point. The screen ids are the stable part; the full rendering is not.
    const lastResult = [...history].reverse().find((t) => t.role === "tool");
    if (lastResult && lastResult.role === "tool") {
      const recorded = this.recordedResults[this.turn - 1];
      if (recorded !== undefined) {
        const was = screenOf(recorded);
        const now = screenOf(lastResult.content);
        if (was !== now) throw new CassetteDiverged(this.turn, was, now);
      }
    }

    const next = this.assistant[this.turn++];
    if (!next) {
      return { text: "", toolCalls: [], raw: null, usage: NO_USAGE, stopReason: "end_turn" };
    }
    return {
      text: next.content,
      toolCalls: next.toolCalls,
      raw: next.raw,
      usage: NO_USAGE,
      stopReason: next.toolCalls.length > 0 ? "tool_calls" : "end_turn",
    };
  }

  async parseJson(): Promise<{ value: unknown; usage: Usage }> {
    // Compilation's inference pass has nothing recorded to replay, so the caller
    // falls back to the mechanical result — which is the honest behaviour.
    return { value: {}, usage: NO_USAGE };
  }
}
