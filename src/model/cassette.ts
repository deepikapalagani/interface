/**
 * THE CASSETTE — replaying a recorded run without a model.
 *
 * §6 asks for a way to run the system "without live services". This is it: the
 * provider hands back the assistant turns a real run produced, in order, so the
 * REAL loop drives the REAL browser against the REAL mock with no API key and no
 * cost. Only the model is substituted.
 *
 * It is a labelled fake, not a simulation, and the check below is what keeps it
 * honest — at SCREEN LEVEL, which is the scope worth stating precisely because
 * the previous version of this sentence claimed the whole tool result. Each turn
 * extracts the screen id from the result this run just produced and compares it
 * with the screen id the recording saw at the same point (`screenOf`, then the
 * comparison in `converse`). A run that has walked onto a different screen stops
 * loudly. A renamed field, a removed control, a changed row count or different
 * markup on the SAME screen all pass — this guard does not see them.
 *
 * That is still the difference between an offline path that proves something and
 * one that passes forever regardless of the code it is supposed to exercise: the
 * flows here are screen-to-screen walks, so a break in targeting shows up as a
 * screen that never advances. It is not a general drift detector.
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
  /**
   * The tool result that followed each assistant turn, INDEXED BY ASSISTANT
   * ORDINAL — `undefined` where that turn called nothing.
   *
   * MEASURED 2026-09-13. This used to be a second independent filter
   * (`transcript.filter(t => t.role === "tool")`), paired with `assistant` by
   * position at the lookup below. That holds only while every assistant turn is
   * followed by exactly one `tool` turn, and the loop breaks that alternation on
   * purpose: when the model calls nothing, `discover/loop.ts` answers with a
   * **user** note, not a tool result. One such turn shifted every later pairing by
   * one, so a faithful replay was accused of drift —
   * `CassetteDiverged(turn=2, expected="MEMBER_RESULTS", actual="MEMBER_SEARCH")`
   * against a surface that had not moved at all. The mirror case is worse: after
   * the shift, a REAL drift is compared against the wrong recorded screen and can
   * pass in silence.
   *
   * It is not a hypothetical shape. `model/provider.ts` records as measured that a
   * reasoning model spends its output budget thinking and returns an empty reply,
   * and the full history — user notes included — is what gets written to
   * `transcript.jsonl` and read straight back into this cassette. So the first
   * real discovery run with one truncated turn would have poisoned its own offline
   * replay. The committed transcripts are strictly alternating, which is the only
   * reason `demo:offline` never showed it.
   *
   * Pairing is now structural: one ordered walk, each assistant turn carrying the
   * turn that follows it only when that turn is a `tool` turn. No comparison
   * coverage is lost — every recorded tool result is still compared exactly once,
   * and the skipped slot is one where the recording holds nothing to compare.
   */
  private readonly recordedResults: (string | undefined)[];

  constructor(transcript: readonly Turn[], label = "cassette") {
    this.id = label;
    const assistant: Extract<Turn, { role: "assistant" }>[] = [];
    const results: (string | undefined)[] = [];
    transcript.forEach((turn, i) => {
      if (turn.role !== "assistant") return;
      assistant.push(turn);
      const next = transcript[i + 1];
      results.push(next?.role === "tool" ? next.content : undefined);
    });
    this.assistant = assistant;
    this.recordedResults = results;
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

}
