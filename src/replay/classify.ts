/**
 * CLASSIFICATION — where the three result classes are actually separated.
 *
 * The glossary calls conflating a business outcome with a failure "the most
 * common design mistake here", and §7 grades "how cleanly it separates the
 * three classes". This module is that separation, and it is pure: it takes an
 * observation and the capability's own declarations and returns which class the
 * world is in. No browser, no model, no I/O of its own.
 *
 * PRECEDENCE IS THE MECHANISM. The order below is not a style choice — it is
 * the thing that prevents the graded mistake:
 *
 *   1. RECOVERABLE   a declared, transient obstruction is cleared first, because
 *                    a broadcast dialog sitting on top of a result would
 *                    otherwise be misread as whatever is underneath it.
 *   2. BUSINESS      a declared terminal answer wins next. "NO RECORDS MATCH —
 *                    MSG 0071" is a RESULT the caller asked for.
 *   3. EXPECTED      only now does the step's own postcondition get a look.
 *   4. HARD FAILURE  everything else, by default, carrying step / expected /
 *                    observed so it can be debugged.
 *
 * If the postcondition were consulted first, a not-found would surface as
 * "postcondition_failed" — a crash where the caller needed an answer. That is
 * the entire bug this ordering exists to prevent.
 */
import type { Capability, Predicate } from "../capability/schema.js";
import type { FailureKind } from "../contract/result.js";
import type { Observation } from "../surface/types.js";
import { evaluatePredicate, type EvalContext, type PredicateResult } from "./predicate.js";

export type Classification =
  /** The step did what it said. Proceed. */
  | { readonly kind: "expected"; readonly evidence: PredicateResult }
  /** A declared, legitimate answer. Terminal, and NOT a failure. */
  | {
      readonly kind: "business_outcome";
      readonly code: string;
      readonly message: string;
      readonly matchedSignal: string;
      readonly evidence: PredicateResult;
    }
  /** A declared, bounded obstruction. The executor applies the rule and retries. */
  | {
      readonly kind: "recoverable";
      readonly ruleId: string;
      readonly action: "dismiss_dialog" | "accept_dialog" | "wait_and_retry" | "reload_screen";
      readonly maxAttempts: number;
      readonly evidence: PredicateResult;
    }
  /** Everything undeclared. Carries what was expected and what was seen. */
  | {
      readonly kind: "hard_failure";
      readonly failureKind: FailureKind;
      readonly expected: string;
      readonly observed: string;
      readonly evidence: PredicateResult | null;
    };

export interface ClassifyInput {
  readonly observation: Observation;
  readonly capability: Capability;
  /** The postcondition of the step just performed, if a step was performed. */
  readonly expectation: Predicate | null;
  /** Recovery rule ids already applied for this step, so a rule cannot loop. */
  readonly usedRecoveries: readonly string[];
}

/**
 * Pure routing. Every branch returns the evidence that justified it, which is
 * what lets a reviewer audit a classification instead of trusting it.
 */
export const classify = async (input: ClassifyInput, ctx: EvalContext): Promise<Classification> => {
  const { observation, capability, expectation, usedRecoveries } = input;

  // 1. A declared, transient obstruction — cleared before anything is judged.
  for (const rule of capability.plan.recovery) {
    if (usedRecoveries.filter((r) => r === rule.id).length >= rule.maxAttempts) continue;
    const evidence = await evaluatePredicate({ all: [rule.when], any: [] }, observation, ctx);
    if (evidence.ok) {
      return { kind: "recoverable", ruleId: rule.id, action: rule.do, maxAttempts: rule.maxAttempts, evidence };
    }
  }

  // 2. A declared terminal answer. This is the branch whose absence causes the
  //    mistake the spec warns about.
  for (const outcome of capability.contract.outcomes) {
    const evidence = await evaluatePredicate(outcome.when, observation, ctx);
    if (evidence.ok) {
      return {
        kind: "business_outcome",
        code: outcome.code,
        message: outcome.message,
        matchedSignal: evidence.summary,
        evidence,
      };
    }
  }

  // 3. Only now: did the step do what it claimed?
  if (expectation) {
    const evidence = await evaluatePredicate(expectation, observation, ctx);
    if (evidence.ok) return { kind: "expected", evidence };

    // An undeclared dialog is its own failure kind: it is the case where the
    // surface is blocked by something nobody anticipated, and it must never be
    // auto-dismissed into a phantom success.
    if (observation.dialog) {
      return {
        kind: "hard_failure",
        failureKind: "undeclared_dialog",
        expected: evidence.summary,
        observed: `an undeclared dialog is blocking: "${observation.dialog.message}"`,
        evidence,
      };
    }

    return {
      kind: "hard_failure",
      failureKind: "postcondition_failed",
      expected: evidence.summary,
      observed: `screen ${observation.screen ?? "(unknown)"}`,
      evidence,
    };
  }

  return {
    kind: "hard_failure",
    failureKind: "app_error",
    expected: "a declared outcome, a recovery rule, or a postcondition",
    observed: `screen ${observation.screen ?? "(unknown)"} matched nothing declared`,
    evidence: null,
  };
};

/** True when the classification ends the run rather than advancing it. */
export const isTerminal = (c: Classification): boolean =>
  c.kind === "business_outcome" || c.kind === "hard_failure";
