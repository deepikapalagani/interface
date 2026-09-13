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
import type { RiskProfile } from "../compile/risk-profile.js";
import type { EventSequencer } from "../evidence/events.js";
import type { ModelProvider, Turn } from "../model/provider.js";
import { observationSummary, observationToText } from "../surface/serialize.js";
import type { Surface } from "../surface/types.js";
import { execute, isStepEntry, MOVES_SCREEN, stepRefOf, type TraceEntry } from "./executor.js";
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
   * What acting on each screen can do to the application, passed straight to the
   * executor. Discovery acts without a recorded plan, so an unrated screen is
   * refused rather than acted on at the least conservative label.
   */
  readonly riskProfile: RiskProfile;
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
  const { provider, surface, actor, epoch, log, riskProfile } = deps;
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
    });

    promptTokens += response.usage.promptTokens;
    completionTokens += response.usage.completionTokens;
    stops.recordTokens(response.usage.completionTokens);

    history.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls, raw: response.raw });

    const [call, ...extra] = response.toolCalls;
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

    /**
     * THE MODEL BATCHED SEVERAL CALLS INTO ONE TURN. Exactly one runs, and the
     * rest are RECORDED rather than silently dropped.
     *
     * One action per turn is deliberate and not a limitation to route around. The
     * second call's `ref` was chosen from the observation taken BEFORE the first
     * action ran, and refs are only valid for the latest observation — so
     * executing it would act on a control chosen from a stale snapshot, on a
     * screen that may now rate `irreversible`. It would also make actions-per-turn
     * a property of the endpoint's batching config, and the trace is the sole
     * input to the compiler.
     *
     * What was wrong was the SILENCE. The discarded call still sits in the
     * assistant turn's opaque `raw`, which the adapter replays verbatim, so the
     * next request declared a `tool_call` nothing answered. Measured against an
     * endpoint applying the real rule: HTTP 400, "The following tool_call_ids did
     * not have response messages: call_B" — and `post()` does not retry a 400, so
     * the run died. Worse, `discover/main.ts` writes `trace.jsonl` and
     * `transcript.jsonl` AFTER `runDiscovery` returns, so the throw destroyed the
     * evidence of the one run the brief requires to be genuine.
     *
     * The wire is made valid in the ADAPTER, which reconciles declared calls
     * against answered ones before POSTing. That keeps this history — and so the
     * recorded transcript the cassette replays — exactly the shape it has always
     * been. Answering the extras with synthetic tool turns would have fixed the
     * wire and re-broken the cassette, whose pairing assumes one tool turn per
     * assistant turn; both were measured.
     *
     * Not routed through `recordToolError`: the executed call SUCCEEDS and clears
     * the error streak anyway, and ending a healthy run over a provider-side
     * batching quirk would be the wrong stop.
     */
    if (extra.length > 0) {
      const skipped = extra
        .map((x, i) => `call ${i + 2} of ${response.toolCalls.length} (${x.name})`)
        .join(", ");
      const note = `the model called ${response.toolCalls.length} tools in one turn; only call 1 (${call.name}) ran — ${skipped} did not`;
      errors.push(note);
      log?.emit(
        "model.extra_tool_calls",
        { as: "model_decision", stated: statedReason(call.args), model: provider.id, turn: stops.stepCount },
        { observed: note },
      );
    }

    /**
     * The step ref this call will carry IF it becomes an ordered step, computed
     * from the SAME filter the compiler uses. The evidence used to cite
     * `s0{trace.length}` — counting dialog entries, which the compiler drops from
     * the step list — so after any dialog every citation named a different step
     * than the artifact has.
     */
    const stepRef = stepRefOf(trace.filter(isStepEntry).length + 1);
    const outcome = await execute({ index: trace.length + 1, stepRef }, call.name, call.args, {
      surface,
      actor,
      epoch,
      riskProfile,
    });

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
      // Through `declared()` rather than mapping inline here: the controller owns
      // every stop reason in this system, and two copies of one mapping drift.
      const verdict = stops.declared(outcome.tool, outcome.detail);
      stopped = verdict.reason ?? "gave_up";
      detail = verdict.detail;
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
      resultText = observationToText(outcome.observation);
      summary = `(${call.name} ok) ${observationSummary(outcome.observation)}`;

      if (outcome.kind === "acted") {
        trace.push(outcome.entry);
        record(observationSummary(outcome.observation), isStepEntry(outcome.entry) ? stepRef : undefined);

        /**
         * Only a SCREEN-CHANGING turn feeds the dead-end detector, because its
         * verdict says the application did not respond to an action.
         *
         * This gated on the outcome KIND until it was measured, and `acted` covers
         * four tools rather than the two that move a screen. So four consecutive
         * reads — a model extracting five values from one servicing screen, which
         * §3.2 asks for — ended the run as `no_progress`, reporting that the model
         * was acting when a `read` issues no surface action whatsoever. Four fills
         * on one form did the same: the digest is built from `innerText`, which
         * does not carry input values, so a fill that lands is byte-identical to
         * one that does nothing.
         *
         * An earlier version of this comment made the same claim one level up
         * ("only an ACTING turn feeds it") and was already false when written; the
         * rule now lives in `MOVES_SCREEN` beside `STEP_ACTION`, where the tool
         * list it describes actually is.
         *
         * WHAT THIS GIVES UP, stated plainly: a model that only ever reads or
         * fills is no longer stopped after four turns. A pathological read loop now
         * runs to the 40-step ceiling instead — roughly ten times the turns, still
         * bounded by `maxSteps`, `maxSeconds` and `maxTokens`. That is the right
         * trade only because the alternative aborts correct runs, but it is a real
         * cost on a project whose standing constraint is that a run costs nothing.
         */
        if (MOVES_SCREEN[outcome.entry.tool] !== undefined) {
          const progress = stops.recordObservation(outcome.observation.digest);
          if (progress.stop && progress.reason) {
            history.push({ role: "tool", callId: call.id, content: resultText });
            stopped = progress.reason;
            detail = progress.detail;
            break;
          }
        }
      } else {
        record(observationSummary(outcome.observation));
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
