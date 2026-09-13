/**
 * THE REPLAY CONTRACT — what a calling agent gets back.
 *
 * This module is the single owner of the result type. Nothing else declares a
 * variant, a failure kind, or an outcome shape; replay imports from here and
 * defines nothing of its own.
 *
 * The spec's most-warned-about mistake (§10 glossary: "the most common design
 * mistake here") is conflating a legitimate business answer with a crash. So the
 * three classes §3.3 names are three *variants*, and the caller's switch is
 * exhaustive:
 *
 *   success          — the capability did what it says, outputs attached
 *   business_outcome — the app gave a legitimate answer the caller must handle
 *                      ("no such member" is a RESULT, not an error)
 *   failed           — something broke; here is the step, the expectation, and
 *                      what was actually observed
 *
 * Escalation is deliberately NOT a fourth status: it is a transition *inside* a
 * run, recorded on the envelope. A run that escalated and could not finish comes
 * back `failed` with an escalation-flavoured kind. `controlAtExit` tells the
 * caller who holds the session without widening the union.
 */

/** Semantic identity of the capability that produced this result. */
export interface CapabilityRef {
  readonly id: string;
  readonly version: string;
}

/**
 * Who holds the live session when the result is returned (§3.6-e).
 *
 * TWO members, not three. MEASURED: every producer of this type reads
 * `lease.holder`, whose type is `Actor` — `"automation" | "human"` — so
 * `"released"` was structurally unproducible. A union member no producer can emit
 * is the same defect class as a hardcoded provenance field: it reads as a state
 * the system can be in, and a caller that switches on it writes a branch that can
 * never run. If the session ever genuinely becomes ownerless, `Actor` gains the
 * member first and this follows.
 */
export type ControlOwner = "automation" | "human";

/**
 * Whether the caller may safely try again.
 *
 * `reconcile_required` is the honest answer when a submit was issued but its
 * outcome could not be read: re-running risks a double side effect, so a human
 * or a declared read-only probe must establish the truth first.
 */
export type Remediation = "retry_safe" | "do_not_retry" | "reconcile_required";

/** What the run may have already changed in the target system. */
export type SideEffectRisk = "none" | "unknown" | "committed";

/**
 * Closed set of hard-failure kinds.
 *
 * The plan called for 12; this is 16. Three of the extras are the escalation
 * outcomes, which the same plan named separately and which are failures by
 * definition. The sixteenth is `contract_violation`, added when the executor
 * gained two ways to discover that the ARTIFACT and the RUN disagree. Every
 * member is a distinct thing a caller or an on-call engineer would act on
 * differently — that is the bar for adding one.
 */
export type FailureKind =
  /** Caller's arguments failed the capability's own input schema. Never touches the UI. */
  | "input_schema_violation"
  /**
   * The capability's own contract was violated — by the ARTIFACT or the
   * invocation, not by the caller's arguments and not by the application.
   *
   * Two live producers, both in `runSteps`:
   *   - a declared output was never populated, or the value read back could not
   *     be coerced to the type `contract.outputs[].type` declares;
   *   - a step interpolates `{{name}}` and no such parameter reached the
   *     executor, so the alternatives were to type the literal text `{{name}}`
   *     into a live application or to refuse. It refuses.
   *
   * DISTINCT FROM `postcondition_failed`, which would tell a caller the
   * application misbehaved and send an engineer to look at the app. Here the app
   * did nothing wrong.
   *
   * DISTINCT FROM `input_schema_violation`, whose contract is that it never
   * touched the UI. These are raised mid-run, after steps have executed, so they
   * must not borrow a kind that promises otherwise.
   */
  | "contract_violation"
  /** The step's precondition never became true (wrong screen, missing anchor). */
  | "precondition_failed"
  /** No strategy in the chain resolved the target, or more than one did. */
  | "target_unresolvable"
  /** The action was issued but the step's postcondition never became true. */
  | "postcondition_failed"
  /** Steps completed but the capability-level checkpoint did not hold. */
  | "checkpoint_failed"
  /** A native dialog appeared that no declared rule covers (§3.3 "unexpected dialogs"). */
  | "undeclared_dialog"
  /** The app's session expired or demanded re-authentication mid-run. */
  | "session_expired"
  /** The allowlist or a risk rule refused the action (§3.4-a/b). */
  | "policy_denied"
  /** The app itself failed — abend, 500, error screen. */
  | "app_error"
  /** A budget expired: step cap, wall clock, or settle budget. */
  | "timeout"
  /** A mutating step was submitted and its result could not be established. */
  | "outcome_unknown"
  /** The surface no longer matches the recorded flow beyond what a binding can absorb (§3.7-d). */
  | "drift_suspected"
  /**
   * Escalated, but no human took control before the TTL expired.
   * Produced by `runSteps` on a `timeout` disposition, and on a run that needed a
   * person with no operator channel attached at all.
   */
  | "escalation_timeout"
  /**
   * A human took control and chose to abort.
   * Produced by `runSteps` on an `abort` disposition.
   */
  | "operator_abort"
  /**
   * A human handed control back but the run could not re-establish its position.
   * Produced by `runSteps` when the step's postcondition still does not hold
   * after the turn, and when a step that already had its turn asks for another.
   */
  | "unresolved_after_handoff";

/** One predicate evaluation, kept so a reviewer can check a claim rather than trust it. */
export interface Evidence {
  readonly expected: string;
  readonly observed: string;
  /** Path, relative to the run directory, of a richer signal (§3.5-b). */
  readonly bundle?: string;
}

/** A recoverable condition that was handled — recorded even on a successful run. */
export interface RecoveryRecord {
  readonly stepRef: string;
  /** Which declared `plan.recovery[]` rule fired. */
  readonly ruleId: string;
  readonly observed: string;
  readonly attempts: number;
}

/** A target that resolved by a non-primary strategy: the per-tenant drift signal (§3.7-d). */
export interface DegradationRecord {
  readonly stepRef: string;
  readonly strategyUsed: string;
  readonly strategyExpected: string;
}

/** A human turn that happened during this run (§3.6-d). */
export interface EscalationRecord {
  readonly stepRef: string;
  readonly reason: string;
  readonly requestedAt: string;
  readonly resolvedAt?: string;
  readonly disposition: "resolved" | "abort" | "timeout";
  readonly operator?: string;
  /**
   * What the human did, reconstructed from DOM effects and the app's own audit
   * log. The automation cannot observe a human's raw input, and this field is
   * named to keep that limitation visible rather than implied.
   */
  readonly reconstructedActions: readonly string[];
}

/** Carried by every variant, so a caller never has to branch to learn these. */
export interface ResultEnvelope {
  readonly capability: CapabilityRef;
  readonly runId: string;
  readonly tenant: string;
  readonly recoveries: readonly RecoveryRecord[];
  readonly degradations: readonly DegradationRecord[];
  readonly interventions: readonly EscalationRecord[];
  readonly controlAtExit: ControlOwner;
  /** Model calls made on this path. Replay asserts 0 (§3.3-a). */
  readonly modelCalls: number;
}

export interface ReplaySuccess extends ResultEnvelope {
  readonly status: "success";
  /**
   * The capability's declared outputs.
   *
   * BE PRECISE ABOUT WHAT IS GUARANTEED HERE, because this comment used to read
   * "already validated against its schema" and nothing anywhere validated
   * anything: the executor wrote the raw string it read off the screen and
   * `Output.type` had no consumer in the repo.
   *
   * What IS now enforced, at the read site in `runSteps` and again after the step
   * loop, and what a `success` therefore means:
   *   - PRESENCE — every output the contract declares was populated by its
   *     producing step. A run that reached its checkpoint with a declared output
   *     missing is a `contract_violation`, not a success.
   *   - DECLARED TYPE — the value read back was coerced to `Output.type`
   *     (string | integer | boolean) or the run failed. So an `integer` output
   *     arrives as a number here, not as the digits that were on screen.
   *
   * What is NOT enforced, and is not implied: `Output.sensitivity` has no
   * consumer anywhere in the system. It is documentation for a reviewer, and it
   * does not cause this value to be redacted, masked, or withheld.
   */
  readonly outputs: Readonly<Record<string, unknown>>;
  /** Each checkpoint clause with what was expected and what was seen. */
  readonly checkpoint: readonly Evidence[];
}

export interface ReplayBusinessOutcome extends ResultEnvelope {
  readonly status: "business_outcome";
  /** A code the capability declared in `contract.outcomes[]` — never ad hoc. */
  readonly code: string;
  readonly message: string;
  /** Which declared signal matched, so the classification can be audited. */
  readonly matchedSignal: string;
  readonly evidence: Evidence;
}

export interface ReplayFailure extends ResultEnvelope {
  readonly status: "failed";
  readonly kind: FailureKind;
  /** Null only when the run failed before any step ran (e.g. input validation). */
  readonly stepRef: string | null;
  readonly evidence: Evidence;
  readonly remediation: Remediation;
  readonly sideEffectRisk: SideEffectRisk;
  /** Every strategy tried and what each observed — the debuggable part of §3.3-g. */
  readonly attempted?: readonly string[];
}

export type ReplayResult = ReplaySuccess | ReplayBusinessOutcome | ReplayFailure;

/* ------------------------------------------------------------------ helpers */

export const isSuccess = (r: ReplayResult): r is ReplaySuccess => r.status === "success";

export const isBusinessOutcome = (r: ReplayResult): r is ReplayBusinessOutcome =>
  r.status === "business_outcome";

export const isFailure = (r: ReplayResult): r is ReplayFailure => r.status === "failed";

/**
 * A run "completed" when the system did its job — which includes returning a
 * business outcome. Only `failed` means the system itself could not answer.
 */
export const completed = (r: ReplayResult): boolean => r.status !== "failed";

/** Exhaustiveness guard: adding a variant without handling it becomes a type error. */
export const assertNever = (x: never): never => {
  throw new Error(`unhandled result variant: ${JSON.stringify(x)}`);
};
