/**
 * THE DISCOVERY LOOP — observe, decide, act, until the goal or a stop condition.
 *
 * This is the only place a model drives anything, and §4 calls a genuine run of
 * it "the heart of the project". Everything it produces is a TRACE of typed,
 * executed steps; the artifact is compiled from that trace afterwards, never
 * from this conversation. The transcript is evidence, not input.
 *
 * HISTORY PRUNING IS THE LOAD-BEARING DETAIL. Measured on this surface: keeping
 * every snapshot costs ~686K input tokens over 30 turns, against ~136K when only
 * the latest is kept — and cost is the smaller half. A model re-reading six stale
 * copies of a screen loses track of which one is current, so pruning buys
 * coherence as much as money.
 *
 * Older tool results cannot simply be deleted: the wire format pairs each
 * assistant tool call with its result, and orphaning one breaks the request. So
 * they are COLLAPSED to a single summary line instead. The protocol stays valid,
 * the action history stays legible, and only the latest screen is rendered in
 * full.
 */
import type { EventSequencer } from "../evidence/events.js";
import type { ModelProvider, Turn } from "../model/provider.js";
import { observationSummary, observationToText } from "../surface/serialize.js";
import type { Surface } from "../surface/types.js";
import { execute, type TraceEntry } from "./executor.js";
import { StopController, type StopLimits, type StopReason } from "./stops.js";
import { TOOL_SPECS } from "./tools.js";

/**
 * Frozen, and first in the request. Byte-stability is what makes the prefix
 * cacheable; editing this string per run would silently forfeit that.
 */
export const SYSTEM_PROMPT = `You are operating a legacy back-office banking application through its user interface, the way a human clerk would. You cannot call APIs. You can only look at the screen and act on what is there.

HOW TO ACT
- Every turn, call exactly one tool. Never answer in prose.
- To act on a control, give the [ref=...] shown for it in the CONTROLS list of the most recent observation. Refs change every time the screen changes, so only ever use refs from the latest observation.
- Controls on this application often have no name of their own. Use the label shown beside them and the frame they are in to tell them apart.
- Also restate the screen id you believe you are on. If it disagrees with what the system sees, you will be told, and you should observe again rather than guess.
- For each target, give one sentence on why that control will still be findable later. Describe what anchors it on the screen, such as the label beside it.

WHAT YOU ARE PRODUCING
Your run is being recorded as a reusable capability that will later be replayed without you. So prefer the stable, obvious route over a clever shortcut, and act only on controls you can justify.

WHEN TO STOP
- Call finish when the screen itself proves the goal is met, and say what on screen proves it.
- Call stuck if you cannot proceed. Saying you are stuck is a correct answer; guessing is not.`;

export interface DiscoveryDeps {
  readonly provider: ModelProvider;
  readonly surface: Surface;
  readonly actor: () => "automation" | "human";
  /** The lease epoch as each action is built, carried to the gate's fence. */
  readonly epoch: () => number;
  /**
   * The structured log §3.5 asks for. Optional so tests need not supply one, but
   * a real run must: this is the only place the `model_decision` arm is ever
   * written, and without it a discovery run produces no record of WHY it acted.
   */
  readonly log?: EventSequencer;
  readonly limits?: StopLimits;
  readonly maxTokensPerTurn?: number;
  readonly now?: () => number;
  /** Progress for a human watching a real run. */
  readonly onTurn?: (turn: number, note: string) => void;
}

export interface DiscoveryResult {
  readonly stopped: StopReason;
  readonly detail: string;
  /** Typed, executed steps — the ONLY input the compiler is allowed to read. */
  readonly trace: readonly TraceEntry[];
  /** The raw conversation. Evidence for a reviewer; never compiled from. */
  readonly transcript: readonly Turn[];
  /**
   * Every tool error the run recovered from.
   *
   * Surfaced rather than buried in the transcript: a run that declares success
   * while recording nothing is the most confusing failure this loop has, and the
   * reason is always in here.
   */
  readonly errors: readonly string[];
  readonly usage: { readonly promptTokens: number; readonly completionTokens: number };
  readonly summary: string;
}

/** Collapse every tool result except the newest, keeping the pairing intact. */
const prune = (history: Turn[], summaries: Map<number, string>): void => {
  const toolTurns = history.map((t, i) => ({ t, i })).filter((x) => x.t.role === "tool");
  for (const { i } of toolTurns.slice(0, -1)) {
    const summary = summaries.get(i);
    const turn = history[i];
    if (summary && turn && turn.role === "tool" && turn.content.length > summary.length) {
      history[i] = { role: "tool", callId: turn.callId, content: summary };
    }
  }
};

/** The model's own stated reason for a call — recorded as a belief, never as fact. */
const statedReason = (args: Readonly<Record<string, unknown>>): string => {
  for (const key of ["why_stable", "reason", "summary"]) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return "(no reason given)";
};

export const runDiscovery = async (goal: string, deps: DiscoveryDeps): Promise<DiscoveryResult> => {
  const { provider, surface, actor, epoch, log } = deps;
  const stops = new StopController(deps.limits, deps.now);
  const maxTokens = deps.maxTokensPerTurn ?? 2048;

  const trace: TraceEntry[] = [];
  const errors: string[] = [];
  const summaries = new Map<number, string>();
  let promptTokens = 0;
  let completionTokens = 0;

  const first = await surface.observe();
  const history: Turn[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: `GOAL: ${goal}\n\n${observationToText(first)}` },
  ];

  let stopped: StopReason = "gave_up";
  let detail = "the loop ended without a declared outcome";

  for (;;) {
    const budget = stops.beginStep();
    if (budget.stop && budget.reason) {
      stopped = budget.reason;
      detail = budget.detail;
      break;
    }

    const response = await provider.converse(history, {
      tools: TOOL_SPECS,
      // Forced: the model's job is to act, and a turn of prose is a wasted turn.
      toolChoice: "required",
      maxTokens,
      // Reasoning stays ON here — this is the half of the system where the model
      // is genuinely deciding something. It is disabled for the mechanical
      // compile pass instead.
      reasoning: true,
    });

    promptTokens += response.usage.promptTokens;
    completionTokens += response.usage.completionTokens;
    stops.recordTokens(response.usage.completionTokens);

    history.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls, raw: response.raw });

    const call = response.toolCalls[0];
    if (!call) {
      // A reasoning model that spends its whole budget thinking returns empty —
      // which looks like refusal and is really truncation. Say so plainly.
      const note =
        response.stopReason === "max_tokens"
          ? "your reply was cut off before you called a tool; be brief and call exactly one tool"
          : "you must act by calling exactly one tool";
      errors.push(note);
      log?.emit(
        "model.no_tool_call",
        { as: "model_decision", stated: "(none — the model did not call a tool)", model: provider.id, turn: stops.stepCount },
        { observed: note },
      );
      history.push({ role: "user", content: note });
      const verdict = stops.recordToolError(note);
      if (verdict.stop && verdict.reason) {
        stopped = verdict.reason;
        detail = verdict.detail;
        break;
      }
      continue;
    }

    const outcome = await execute(trace.length + 1, call.name, call.args, { surface, actor, epoch });

    /**
     * ONE event per turn, emitted AFTER the call has run so a single line can
     * carry both halves §3.5 asks for: the reason the model stated, and what
     * actually happened. Emitting before execution forces a second line for the
     * outcome, and the pair then duplicates the reason.
     *
     * The arm is always `model_decision`, because during discovery that is the
     * only true one. A tool call here is NOT an `artifact_step`: that arm is a
     * citation into a capability file a reviewer can open, and no such file
     * exists yet — labelling one `capability: "(discovery)"` would be a
     * fabricated citation. A tool error is likewise not a `handler`, which means
     * a DECLARED recovery rule fired; discovery has no recovery table.
     */
    const record = (observed: string, stepRef?: string): void => {
      log?.emit(
        `model.${call.name}`,
        { as: "model_decision", stated: statedReason(call.args), model: provider.id, turn: stops.stepCount },
        { observed, ...(stepRef ? { stepRef } : {}) },
      );
    };

    let resultText: string;
    let summary: string;

    if (outcome.kind === "terminal") {
      stopped = outcome.tool === "finish" ? "goal_reached" : "gave_up";
      detail = outcome.detail;
      record(outcome.detail);
      deps.onTurn?.(stops.stepCount, `${outcome.tool}: ${outcome.detail}`);
      break;
    }

    if (outcome.kind === "error") {
      errors.push(`${call.name}: ${outcome.message}`);
      resultText = `ERROR: ${outcome.message}`;
      summary = resultText;
      record(resultText);
      const verdict = stops.recordToolError(outcome.message);
      if (verdict.stop && verdict.reason) {
        history.push({ role: "tool", callId: call.id, content: resultText });
        stopped = verdict.reason;
        detail = verdict.detail;
        break;
      }
    } else {
      stops.recordToolSuccess();
      if (outcome.kind === "acted") trace.push(outcome.entry);
      resultText = observationToText(outcome.observation);
      summary = `(${call.name} ok) ${observationSummary(outcome.observation)}`;
      record(
        observationSummary(outcome.observation),
        outcome.kind === "acted" ? `s${String(trace.length).padStart(2, "0")}` : undefined,
      );

      const progress = stops.recordObservation(outcome.observation.digest);
      if (progress.stop && progress.reason) {
        history.push({ role: "tool", callId: call.id, content: resultText });
        stopped = progress.reason;
        detail = progress.detail;
        break;
      }
    }

    history.push({ role: "tool", callId: call.id, content: resultText });
    summaries.set(history.length - 1, summary);
    prune(history, summaries);

    deps.onTurn?.(stops.stepCount, `${call.name} -> ${summary}`);
  }

  return {
    stopped,
    detail,
    trace,
    transcript: history,
    errors,
    usage: { promptTokens, completionTokens },
    summary:
      `${stopped}: ${detail} (${stops.summary()}, ${trace.length} recorded step(s)` +
      `${errors.length > 0 ? `, ${errors.length} tool error(s)` : ""})`,
  };
};
