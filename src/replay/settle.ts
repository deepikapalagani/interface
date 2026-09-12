/**
 * SETTLE — the engine's only perception primitive, and the ONLY module in the
 * replay path permitted to reference a timer.
 *
 * "How do you wait?" is where deterministic replay usually dies. Arbitrary
 * sleeps make a run pass on a fast machine and fail on a slow one; waiting for
 * "network idle" couples the run to a page's incidental chatter. Neither is a
 * statement about the application.
 *
 * So there are no sleeps in this system and no idle heuristics. Every wait is
 * bounded by a DECLARED condition from the artifact: settle polls the surface
 * and returns the instant one of the given expectations matches, or reports that
 * the budget expired with the full expected-versus-observed detail attached.
 * `tests/source-invariants.test.ts` walks `src/replay/**` and asserts that this
 * is the only module in it referencing a timer, so the claim stays true as the
 * engine grows — and in particular keeps the escalation TTL, which is a
 * wall-clock deadline, out of the engine.
 *
 * Several requirements collapse onto this one call, which is the point:
 *   - a step's precondition            (§3.3)
 *   - a step's postcondition           (§3.3)
 *   - the capability checkpoint        (§3.2)
 *   - business-outcome detection       (§3.3-f)
 *   - recoverable-condition detection  (§3.3-f)
 */
import type { Predicate } from "../capability/schema.js";
import type { Observation, Surface } from "../surface/types.js";
import { evaluatePredicate, type EvalContext, type PredicateResult } from "./predicate.js";

/** A named condition settle is racing. The first to hold wins. */
export interface Expectation {
  readonly id: string;
  readonly predicate: Predicate;
}

export interface SettleResult {
  /** The id of the expectation that held, or null when the budget expired. */
  readonly matched: string | null;
  readonly observation: Observation;
  /** Every expectation's last evaluation — the debuggable part of a timeout. */
  readonly evaluations: Readonly<Record<string, PredicateResult>>;
  readonly elapsedMs: number;
  readonly polls: number;
}

export interface SettleOptions {
  /** Wall-clock ceiling. Exceeding it is a typed outcome, never a hang. */
  readonly budgetMs: number;
  readonly intervalMs?: number;
  /** Injectable so tests need neither a real clock nor real elapsed time. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll until a declared expectation holds. Returns on the FIRST match, so a fast
 * app is never made slow by a fixed wait, and a slow one is never cut short by a
 * guess — the only thing that ends the wait is the application's own state.
 */
export const settle = async (
  surface: Surface,
  expectations: readonly Expectation[],
  ctx: EvalContext,
  options: SettleOptions,
): Promise<SettleResult> => {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  const interval = options.intervalMs ?? 100;
  const started = now();

  let polls = 0;
  let observation = await surface.observe();
  let evaluations: Record<string, PredicateResult> = {};

  for (;;) {
    polls += 1;
    evaluations = {};
    for (const e of expectations) {
      const result = await evaluatePredicate(e.predicate, observation, ctx);
      evaluations[e.id] = result;
      if (result.ok) {
        return { matched: e.id, observation, evaluations, elapsedMs: now() - started, polls };
      }
    }

    if (now() - started >= options.budgetMs) {
      return { matched: null, observation, evaluations, elapsedMs: now() - started, polls };
    }

    await sleep(interval);
    observation = await surface.observe();
  }
};

/** Convenience for the common case of racing exactly one condition. */
export const settleOne = async (
  surface: Surface,
  id: string,
  predicate: Predicate,
  ctx: EvalContext,
  options: SettleOptions,
): Promise<SettleResult> => settle(surface, [{ id, predicate }], ctx, options);
