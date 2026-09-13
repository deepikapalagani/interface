/**
 * THE STEP LOOP — the production execution path.
 *
 * This is what an AI agent actually triggers, and the thing §3.3 cares about: it
 * walks a recorded plan with NO model deciding anything. Nothing in this file's
 * import graph reaches a model SDK, and a CI check asserts that stays true.
 *
 * The loop composes the two primitives rather than reimplementing them, and the
 * division between them is deliberate:
 *
 *   settle()    decides WHEN to stop waiting — it races every declared condition
 *               and returns the instant one holds, so a wait is bounded by the
 *               application's own state instead of a sleep.
 *   classify()  decides WHAT THAT MEANS — applying the precedence that keeps a
 *               business outcome from being reported as a crash.
 *
 * Both run over the same observation. settle answers "has something happened?",
 * classify answers "which of the three classes is it?". Keeping those separate is
 * why neither has to know about the other's concerns.
 */
import type { Capability, Step } from "../capability/schema.js";
import type { EscalationRecord, FailureKind, Remediation, SideEffectRisk } from "../contract/result.js";
import type { Escalate, InterventionDraft } from "../control/escalation.js";
import type { ControlLease } from "../control/lease.js";
import type { EventSequencer } from "../evidence/events.js";
import type { HandoffRecord } from "../evidence/log.js";
import { redactText } from "../safety/redact.js";
import { SurfaceRefused, type ActionContext, type Resolution, type Surface, type SurfaceAction } from "../surface/types.js";
import { classify, type Classification } from "./classify.js";
import { substituteParams, type EvalContext, type PredicateResult } from "./predicate.js";
import { settle, type Expectation } from "./settle.js";

export interface ExecutorDeps {
  /** Already wrapped in the gate — the executor never holds a raw driver. */
  readonly surface: Surface;
  readonly lease: ControlLease;
  readonly log: EventSequencer;
  readonly budgets: { readonly stepMs: number; readonly runMs: number };
  readonly now: () => number;
  /**
   * Stamped onto an intervention request so a console can name the run it is
   * being asked about. Optional because `runSteps` is also driven directly by
   * unit tests with no run identity; `replay()` always supplies it.
   */
  readonly runId?: string;
  /**
   * The escalation orchestrator, when one is wired. OPTIONAL deliberately: a run
   * with no operator channel is a normal configuration, and it reports that it
   * needed a person and could not reach one rather than pretending the action
   * was forbidden.
   */
  readonly escalate?: Escalate;
  /**
   * Called once per COMPLETED human turn, with the settled record (§3.6-d).
   *
   * A sink rather than a return value because only this function ever holds all
   * of it at once: `EscalationRecord` carries the disposition and the timings,
   * while the capability, the goal, the screen and the observed text are the
   * executor's own context at the moment it escalated. Assembling the row here
   * is what lets `replay/main.ts` write `handoff.jsonl` without the result
   * contract growing a field for it.
   *
   * OPTIONAL: a caller that does not want the file simply does not pass one, and
   * a run with no escalation never calls it.
   */
  readonly onHandoff?: (record: HandoffRecord) => void;
}

export interface RecoveryApplied {
  readonly stepRef: string;
  readonly ruleId: string;
  /** What was actually seen that triggered the rule — evidence, not just a count. */
  readonly observed: string;
  readonly attempts: number;
}

export interface DegradationSeen {
  readonly stepRef: string;
  readonly strategyUsed: string;
  readonly strategyExpected: string;
}

export type RunOutcome =
  | { readonly kind: "completed"; readonly checkpoint: PredicateResult }
  | { readonly kind: "business_outcome"; readonly code: string; readonly message: string; readonly matchedSignal: string; readonly evidence: PredicateResult }
  | {
      readonly kind: "failed";
      readonly stepRef: string | null;
      readonly failureKind: FailureKind;
      readonly expected: string;
      readonly observed: string;
      readonly remediation: Remediation;
      readonly sideEffectRisk: SideEffectRisk;
      readonly attempted?: readonly string[];
    };

export interface RunReport {
  readonly outcome: RunOutcome;
  readonly stepsCompleted: number;
  readonly recoveries: readonly RecoveryApplied[];
  readonly degradations: readonly DegradationSeen[];
  /** Every human turn this run took (§3.6-d), carried like recoveries and degradations. */
  readonly interventions: readonly EscalationRecord[];
  readonly outputs: Readonly<Record<string, OutputValue>>;
}

/**
 * What a declared output can be after coercion.
 *
 * WIDENED FROM `string`, deliberately, and the cost is stated because it was the
 * alternative to leaving `Output.type` with no consumer at all: the surface can
 * only ever hand back text, so an `integer` output was previously the DIGITS off
 * the screen and a caller had to know to parse them. Every consumer of this
 * field goes through `ReplaySuccess.outputs`, which is already
 * `Record<string, unknown>`, so the widening reaches no existing caller — the one
 * assertion in the suite (`outputs["confirmation_number"]` on a `string` output)
 * is unaffected because a string output still yields a string.
 */
export type OutputValue = string | number | boolean;

/**
 * Two per run, one per step.
 *
 * A cap rather than a loop guard: the policy that refused a step is unchanged by
 * a human turn, so a step that escalated and then asks again would escalate
 * forever. The per-run ceiling bounds the damage of a plan that trips the gate on
 * several steps — a capability that needs a person three times is a capability
 * that should be re-recorded, not one that should keep paging an operator.
 */
const MAX_ESCALATIONS_PER_RUN = 2;

/** The verbs that touch the application and therefore must have something to touch. */
const ACTING_VERBS: readonly Step["action"][] = ["navigate", "fill", "click"];

/**
 * Coerce a value read off the screen to the type the contract declares.
 *
 * `Output.type` had NO consumer anywhere in the system: the executor wrote the
 * raw string and `ReplaySuccess.outputs` claimed the values were "already
 * validated against its schema". This is the site that makes the declaration
 * mean something — a capability declaring an `integer` output now either returns
 * a number or fails, rather than returning digits and hoping.
 *
 * Booleans accept the spellings a green-screen actually renders. Anything else
 * is a `contract_violation`, because the artifact promised a shape the
 * application did not produce.
 */
const coerceOutput = (
  declared: Capability["contract"]["outputs"][number],
  raw: string,
): { readonly ok: true; readonly value: OutputValue } | { readonly ok: false; readonly why: string } => {
  switch (declared.type) {
    case "string":
      return { ok: true, value: raw };
    case "integer": {
      const trimmed = raw.trim();
      if (!/^-?\d+$/.test(trimmed)) return { ok: false, why: `read "${raw}", which is not an integer` };
      return { ok: true, value: Number(trimmed) };
    }
    case "boolean": {
      const t = raw.trim().toLowerCase();
      if (["true", "yes", "y"].includes(t)) return { ok: true, value: true };
      if (["false", "no", "n"].includes(t)) return { ok: true, value: false };
      return { ok: false, why: `read "${raw}", which is not a boolean` };
    }
  }
};

/**
 * At a PRECONDITION, `classify()`'s generic `postcondition_failed` means "we
 * never reached where this step expected to be", which is `precondition_failed`.
 * Every other kind it can return is already specific and survives untouched.
 *
 * The expression this replaced was `timedOut ? "precondition_failed" :
 * c.failureKind`, which relabelled on the wrong axis: it overwrote a genuine
 * `undeclared_dialog` whenever settle had timed out — and a blocking dialog
 * makes settle time out by construction, since nothing declared matches it. The
 * one kind that branch existed to surface was the one kind it destroyed.
 */
const preconditionKind = (kind: FailureKind): FailureKind =>
  kind === "postcondition_failed" ? "precondition_failed" : kind;

/**
 * Could this step have changed something the caller must now reconcile?
 *
 * Keyed on the step's DECLARED RISK, not on its verb. A `read_only` step cannot
 * have committed anything however it failed, while a reversible or irreversible
 * one may have — and the artifact already states which it is.
 *
 * The verb list this replaced was both redundant and wrong: it classed `fill` as
 * mutating, so typing a member id into a search box and then failing to read it
 * back came out as `reconcile_required` / `sideEffectRisk: unknown`. That would
 * tell a caller to go and check whether money moved, over a search form.
 */
const couldHaveCommitted = (step: Step): boolean => step.risk !== "read_only";

/**
 * Everything declared that we are prepared to see right now. Racing them
 * together is what lets a not-found arrive as an ANSWER rather than as a
 * timeout waiting for a success that was never coming.
 */
const expectationsFor = (capability: Capability, expect: Step["post"] | null): Expectation[] => {
  const list: Expectation[] = [];
  if (expect) list.push({ id: "expected", predicate: expect });
  for (const o of capability.contract.outcomes) list.push({ id: `outcome:${o.code}`, predicate: o.when });
  /**
   * ONLY THE RECOVERY VERBS THAT ACT BELONG IN THE RACE.
   *
   * `settle` returns the instant any raced expectation holds. Racing a rule the
   * engine answers by DOING NOTHING therefore inverts that rule's meaning:
   * `wait_and_retry`, declared against a transient load, ENDED the wait the
   * moment the load appeared — `applyRecovery` issued nothing, the loop
   * re-observed, and `maxAttempts` burned in microseconds before a hard failure.
   *
   * MEASURED, same plan, same surface, load clearing after 1200ms, step budget
   * 5000ms: with NO recovery rule declared the step completes in ~1229ms; with
   * `wait_and_retry` x3 declared it FAILS in ~1ms, `postcondition_failed`, three
   * recovery attempts recorded. Declaring the spec's own named example of a
   * recoverable condition (§3.3-f, "wait/retry a transient load") made the run
   * strictly worse than declaring nothing at all.
   *
   * A dialog verb still belongs here, and the asymmetry is the whole point: a
   * dialog BLOCKS the page, so the postcondition cannot come true underneath it
   * and noticing it promptly is what lets the engine dismiss it instead of
   * waiting out the entire budget first. The non-acting verbs are the opposite
   * case — they need MORE time, not less. Leaving them out of the race costs
   * them nothing, because `classify` evaluates every rule in `plan.recovery`
   * independently against the observation (classify.ts, step 1) rather than
   * reading whatever `settle` matched.
   */
  for (const r of capability.plan.recovery) {
    if (r.do === "dismiss_dialog" || r.do === "accept_dialog") {
      list.push({ id: `recovery:${r.id}`, predicate: { all: [r.when], any: [] } });
    }
  }
  return list;
};

/** The one classify() arm that both business-outcome exits below carry. */
type BusinessOutcome = Extract<Classification, { kind: "business_outcome" }>;
/** The arm the recovery table answers, applied identically at all three observation points. */
type Recoverable = Extract<Classification, { kind: "recoverable" }>;

export const runSteps = async (
  capability: Capability,
  params: Readonly<Record<string, string>>,
  deps: ExecutorDeps,
): Promise<RunReport> => {
  const { surface, lease, log, budgets, now } = deps;
  const targets = new Map(capability.plan.targets.map((t) => [t.id, t]));
  const ctx: EvalContext = { surface, targets, params };

  const recoveries: RecoveryApplied[] = [];
  const degradations: DegradationSeen[] = [];
  const interventions: EscalationRecord[] = [];
  const escalated = new Set<string>();
  const outputs: Record<string, OutputValue> = {};
  const startedAt = now();

  let stepsCompleted = 0;
  /**
   * Wall time a PERSON held the session, which the run must not be charged for.
   *
   * Without this the human's minutes come out of the run budget and the run dies
   * `timeout` at the next step boundary — reporting the deadline as the cause
   * when the actual cause was a handoff that worked. `startedAt` is left alone
   * rather than advanced: it means "when the run started", and moving it would
   * make it a lie to save an arithmetic operation.
   */
  let pausedMs = 0;

  /**
   * HAS THIS RUN ALREADY CHANGED THE TARGET SYSTEM?
   *
   * Run-scoped rather than per-step, because the question a caller asks is about
   * the RUN: "is it safe to invoke this capability again?" A later step that
   * cannot confirm itself does not make an earlier freeze un-issued.
   *
   * Three exits used to answer that question with the constant `none`, and each
   * was only correct because the target app had no mutating route: nothing a
   * replay did could commit anything, so "nothing was committed" was true by
   * construction rather than by reasoning. `POST /screen/card-action` ends that,
   * and a constant that was true for an accidental reason becomes a lie the day
   * the reason goes away. Telling a caller `retry_safe` after a card was actually
   * frozen is an invitation to double-commit — the §3.3 conflation the whole
   * result contract exists to prevent.
   *
   * Set AFTER `surface.act` returns, never before: an action the gate refused
   * never reached the application, so a refusal must not arm this.
   */
  let committed = false;

  const outOfTime = (): boolean => now() - startedAt - pausedMs >= budgets.runMs;

  const report = (outcome: RunOutcome): RunReport => ({ outcome, stepsCompleted, recoveries, degradations, interventions, outputs });

  /**
   * EVERY hard failure leaves a line in the log, and this is the only place that
   * can guarantee it.
   *
   * MEASURED: `fail()` emitted NOTHING. Every typed failure this engine produces
   * — a refused action, an unresolvable target, a failed postcondition, an
   * expired budget, the capability checkpoint — returned a result and wrote no
   * evidence at all. A run that died on its first step therefore left an EMPTY
   * events.jsonl, which `scripts/verify-evidence.ts` rejects outright ("no
   * events.jsonl — §3.5 requires a structured log of what the agent did and
   * why"): the shipped CLI could produce evidence the shipped evidence gate
   * fails. §3.3-g asks a failure to say which step, what was expected and what
   * was observed, and until now it said so only to the caller.
   *
   * The `artifact_step` arm and the clause-as-stepRef convention are the ones
   * `replay/index.ts` already set for its pre-flight rejections: a citation has
   * to RESOLVE, so when no step decided the failure the clause that did is named
   * instead. The event's own `stepRef` stays null in that case, matching the
   * result's.
   */
  const fail = (
    stepRef: string | null,
    failureKind: FailureKind,
    expected: string,
    observed: string,
    remediation: Remediation,
    sideEffectRisk: SideEffectRisk,
    attempted?: readonly string[],
  ): RunReport => {
    log.emit(
      "run.failed",
      {
        as: "artifact_step",
        capability: capability.contract.id,
        version: capability.contract.version,
        stepRef: stepRef ?? "plan.checkpoint",
      },
      { stepRef, expected, observed, detail: { failureKind, remediation, sideEffectRisk } },
    );
    return report({ kind: "failed", stepRef, failureKind, expected, observed, remediation, sideEffectRisk, ...(attempted ? { attempted } : {}) });
  };

  /**
   * THE ONLY EXIT FOR A DECLARED BUSINESS OUTCOME.
   *
   * An outcome can be detected at two moments — a step's precondition and its
   * postcondition — and the citation was emitted from the precondition one
   * alone. MEASURED on lookup@1.0.0: a MEMBER_NOT_FOUND replay wrote an
   * events.jsonl of exactly two `step.acted` lines and nothing else, because on
   * that capability the not-found arrives in s02's postcondition settle. The
   * classification was recoverable from the returned value and absent from the
   * evidence — which is the one thing events.ts's `outcome_signal` arm exists to
   * prevent: it is "how a business-outcome classification becomes auditable
   * rather than asserted", and this is the §3.3 class the spec calls the most
   * common design mistake. Routing both exits through one function is why they
   * cannot drift apart again.
   */
  const businessOutcome = (stepRef: string | null, c: BusinessOutcome): RunReport => {
    log.emit(
      "outcome.matched",
      { as: "outcome_signal", code: c.code, matched: c.matchedSignal },
      // `stepRef` is null when the capability CHECKPOINT is where the declared
      // outcome was recognised — no step decided it, and inventing one would be
      // a citation to something that did not happen.
      { stepRef },
    );
    return report({ kind: "business_outcome", code: c.code, message: c.message, matchedSignal: c.matchedSignal, evidence: c.evidence });
  };

  /**
   * Wait for anything declared, then let precedence decide what it was.
   * `settle` chooses the moment; `classify` is authoritative about the meaning.
   */
  const observeAndClassify = async (
    expect: Step["post"] | null,
    used: readonly string[],
  ): Promise<{ c: Classification; location: string; screen: string | null }> => {
    const settled = await settle(surface, expectationsFor(capability, expect), ctx, { budgetMs: budgets.stepMs, now });
    const c = await classify({ observation: settled.observation, capability, expectation: expect, usedRecoveries: used }, ctx);
    return { c, location: settled.observation.location, screen: settled.observation.screen };
  };

  /**
   * APPLY ONE DECLARED RECOVERY RULE — at whichever observation point saw it.
   *
   * THIS IS THE FIX AT THE HEART OF THE THIRD RESULT CLASS. `plan.recovery[]`
   * used to be applied in the PRECONDITION loop only. At a step's postcondition
   * the identical `recoverable` classification fell straight through to
   * `fail(..., "postcondition_failed")` with `recoveries: []` — no rule applied,
   * no action issued, nothing logged — and at the capability checkpoint it was
   * never consulted at all. So the class §3.3 requires be kept distinct was
   * implemented at one of three places it can be observed.
   *
   * That is not a corner: the shipped `broadcast` fault queues its alert on the
   * CARD SERVICES render, which the flagship plan reaches by CLICKING at s04 —
   * so the dialog arrives at s04's POSTCONDITION, on exactly the broken path,
   * while `scripts/fault.ts`, `README.md` and `mock/seed.ts` all promised the
   * declared `dismiss_dialog` rule would clear it and the run would continue.
   *
   * Returns a RunReport when the ATTEMPT ITSELF failed, and null when the rule
   * was applied and the caller should re-observe.
   */
  const applyRecovery = async (
    c: Recoverable,
    step: Step | null,
    used: string[],
    location: string,
    screen: string | null,
  ): Promise<RunReport | null> => {
    used.push(c.ruleId);
    const attempts = used.filter((u) => u === c.ruleId).length;
    const citedRef = step?.ref ?? "plan.checkpoint";
    recoveries.push({ stepRef: citedRef, ruleId: c.ruleId, observed: c.evidence.summary, attempts });

    if (c.action !== "dismiss_dialog" && c.action !== "accept_dialog") {
      /**
       * `wait_and_retry` and `reload_screen` PERFORM NOTHING — the engine simply
       * re-enters the step, which is declared scope rather than an oversight
       * (DECISIONS.md records that `observe()` issues no HTTP request, so a
       * screen-shaped interstitial is unrecoverable by this engine).
       *
       * What was wrong was the LINE: `recovery.applied` on the `handler` arm,
       * which `evidence/events.ts` defines as "a declared recovery rule FIRED".
       * Nothing fired. The rule MATCHED and the engine did nothing, and the
       * event now says that in as many words rather than claiming an action.
       */
      log.emit(
        "recovery.matched",
        { as: "handler", ruleId: c.ruleId, attempt: attempts },
        {
          stepRef: citedRef,
          expected: `recovery "${c.ruleId}" to clear: ${c.evidence.summary}`,
          observed: `rule matched and the engine issued NO action — "${c.action}" only re-enters the step, it does not touch the surface`,
        },
      );
      return null;
    }

    const action: SurfaceAction = c.action === "accept_dialog" ? { kind: "accept_dialog" } : { kind: "dismiss_dialog" };
    try {
      await surface.act(action, {
        stepRef: step?.ref ?? null,
        /**
         * THE STEP'S OWN RISK, not the constant `read_only` this used to pass.
         * The gate rates an action by what the caller declares, so hardcoding
         * `read_only` meant a dialog action during an irreversible step could
         * never be rated above `read_only` and `riskHandling` could not reach it.
         * A recovery taken in the middle of a committing step carries that
         * step's risk, because that is the context it is acting in.
         */
        risk: step?.risk ?? "read_only",
        actor: lease.holder,
        epoch: lease.epoch,
        url: location,
        screen,
      });
    } catch (e) {
      /**
       * A refusal HERE used to escape `runSteps` entirely: this `surface.act`
       * sat outside the try/catch that guards the main action path, so a policy
       * whose `allowedActions` omits `dismiss_dialog` — an ordinary per-tenant
       * configuration difference — turned a declared recovery into an uncaught
       * exception, and the CLI exited 1 with no result and no evidence.
       */
      if (!(e instanceof SurfaceRefused)) throw e;
      return fail(
        step?.ref ?? null,
        e.reason === "target_unresolvable" ? "target_unresolvable" : "policy_denied",
        `the declared recovery "${c.ruleId}" (${c.action}) to be permitted`,
        e.message,
        "do_not_retry",
        committed ? "unknown" : "none",
      );
    }

    /**
     * ARMED ON THE ACTION'S OWN COMMIT POTENTIAL, not on the step's risk.
     * ACCEPTING a dialog can commit; DISMISSING one cancels. Keying this on
     * `couldHaveCommitted(step)` meant accepting a committing confirm() during a
     * step the artifact called `read_only` left the flag false, and the caller
     * was told nothing had changed.
     */
    if (c.action === "accept_dialog") committed = true;

    log.emit(
      "recovery.applied",
      { as: "handler", ruleId: c.ruleId, attempt: attempts },
      { stepRef: citedRef, expected: `recovery "${c.ruleId}" to clear: ${c.evidence.summary}`, observed: `issued ${c.action}` },
    );
    return null;
  };

  for (const step of capability.plan.steps) {
    if (outOfTime()) {
      // A deadline that expires BETWEEN steps says nothing about whether the
      // steps already taken landed. If one of them did, "retry_safe" would tell
      // the caller to re-run a capability that has already frozen a card.
      return fail(
        step.ref,
        "timeout",
        `run to complete within ${budgets.runMs}ms`,
        `exceeded at step ${step.ref}`,
        committed ? "reconcile_required" : "retry_safe",
        committed ? "unknown" : "none",
      );
    }

    const used: string[] = [];
    /** True once a person has performed this step in the live session. */
    let humanPerformed = false;

    // ---- precondition: are we where this step expects to be? -----------------
    for (;;) {
      const seen = await observeAndClassify(step.pre, used);

      if (seen.c.kind === "recoverable") {
        const refused = await applyRecovery(seen.c, step, used, seen.location, seen.screen);
        if (refused !== null) return refused;
        continue; // re-evaluate the same step
      }

      if (seen.c.kind === "business_outcome") {
        return businessOutcome(step.ref, seen.c);
      }

      if (seen.c.kind === "hard_failure") {
        // THIS step never acted — its precondition is what failed. But an EARLIER
        // step in the same run may already have committed, and the question the
        // caller asked is about the run, not about this step.
        return fail(
          step.ref,
          preconditionKind(seen.c.failureKind),
          seen.c.expected,
          seen.c.observed,
          committed ? "reconcile_required" : "retry_safe",
          committed ? "unknown" : "none",
        );
      }

      break; // precondition holds
    }

    // ---- the action itself ---------------------------------------------------
    const target = step.target ? targets.get(step.target) : undefined;
    if (step.action !== "assert" && step.target && !target) {
      // A plan naming an undeclared symbol is a broken artifact, so `do_not_retry`
      // holds however the run got here. What does NOT hold is `none`: an earlier
      // step may have committed before this one was ever reached.
      return fail(
        step.ref,
        "target_unresolvable",
        `symbol ${step.target} declared`,
        "not present in plan.targets",
        "do_not_retry",
        committed ? "unknown" : "none",
      );
    }

    /**
     * AN ACTING VERB WITH NOTHING TO ACT ON.
     *
     * Schema refinement 10 now makes this unrepresentable in a parsed artifact,
     * so this is the engine refusing to trust that. It used to fall past every
     * branch below — no action issued, no event emitted — and then increment
     * `stepsCompleted`, so the run reported success for a step that never
     * happened. A silently skipped step is the worst available outcome here, so
     * it fails loudly instead.
     */
    if (ACTING_VERBS.includes(step.action) && step.target === undefined) {
      return fail(
        step.ref,
        "contract_violation",
        `step ${step.ref} to name a target for its "${step.action}"`,
        "the plan declares an acting step with no target, so there is nothing to act on",
        "do_not_retry",
        committed ? "unknown" : "none",
      );
    }

    let resolution: Resolution | null = null;

    if (step.action === "read" && target) {
      /**
       * A read never acts, so it never builds an action and never passes the
       * gate — but it CAN still be refused by the surface, and that refusal used
       * to escape `runSteps` as an exception. `PlaywrightSurface.read` catches
       * `locate()` and then calls `resolveFrame()` OUTSIDE the catch, which
       * throws `SurfaceRefused` when the frame is missing. The identical
       * condition on an acting step is a typed `target_unresolvable` failure, and
       * the flagship plan ENDS on a read (s08), so this is the shape most likely
       * to meet it.
       */
      let value: string | null;
      try {
        value = await surface.read(target);
      } catch (e) {
        if (!(e instanceof SurfaceRefused)) throw e;
        return fail(
          step.ref,
          e.reason === "target_unresolvable" ? "target_unresolvable" : "policy_denied",
          `a readable value at ${step.target}`,
          e.message,
          "do_not_retry",
          committed ? "unknown" : "none",
        );
      }
      if (value === null) {
        /**
         * A read issues no action, so this step committed nothing — but this is
         * the exit the FLAGSHIP plan reaches. `msc.card.set_status@1.0.0` ends
         * `s07` click (reversible, commits) then `s08` read (the confirmation
         * number). A read that yields nothing after s07 has frozen a card is
         * precisely the moment `retry_safe` / `none` invites a double-commit.
         */
        return fail(
          step.ref,
          "postcondition_failed",
          `a readable value at ${step.target}`,
          "nothing readable",
          committed ? "reconcile_required" : "retry_safe",
          committed ? "unknown" : "none",
        );
      }
      /**
       * THE SITE THAT GIVES `Output.type` A CONSUMER. Before this the raw string
       * was written straight through and `ReplaySuccess.outputs` described itself
       * as "already validated against its schema", which was false repo-wide.
       */
      const output = capability.contract.outputs.find((o) => o.producedBy === step.ref);
      if (output) {
        const coerced = coerceOutput(output, value);
        if (!coerced.ok) {
          return fail(
            step.ref,
            "contract_violation",
            `output "${output.name}" to be ${output.type}, as ${capability.contract.id} declares`,
            coerced.why,
            // The artifact is wrong, so re-running it changes nothing — unless
            // this run already committed, in which case the truth has to be
            // established before anything else.
            committed ? "reconcile_required" : "do_not_retry",
            committed ? "unknown" : "none",
          );
        }
        outputs[output.name] = coerced.value;
      }
      log.emit(
        "step.read",
        { as: "artifact_step", capability: capability.contract.id, version: capability.contract.version, stepRef: step.ref },
        { stepRef: step.ref, observed: output ? `${output.name} captured` : "value read" },
      );
    } else if (step.action !== "assert" && target) {
      const observation = await surface.observe();

      /**
       * REFUSE RATHER THAN TYPE A TEMPLATE INTO A LIVE APPLICATION.
       *
       * `substitute()` used to fall back to the placeholder when a parameter was
       * missing, so a plan referencing `{{note}}` with no such argument typed the
       * seven literal characters `{{note}}` into the form — and the step's own
       * postcondition, `valueEquals ... "{{note}}"`, then confirmed the value had
       * landed. A phantom success built out of the run's own typo.
       *
       * `replay/index.ts` now rejects this before the browser is touched, so this
       * is unreachable from the CLI. The engine still refuses, because an engine
       * that would type a template if asked is one that will, the first time
       * something invokes it directly.
       */
      let filled = "";
      if (step.action === "fill") {
        const sub = substituteParams(step.value ?? "", params);
        if (sub.missing.length > 0) {
          return fail(
            step.ref,
            "contract_violation",
            `every {{param}} in ${step.ref}'s value to have been supplied`,
            `parameter(s) ${sub.missing.join(", ")} were not supplied, so the run refused to type the literal template into the application`,
            "do_not_retry",
            committed ? "unknown" : "none",
          );
        }
        filled = sub.value;
      }

      const action: SurfaceAction =
        step.action === "fill"
          ? { kind: "fill", target, value: filled }
          : { kind: step.action === "navigate" ? "navigate" : "click", target };

      const actionCtx: ActionContext = {
        stepRef: step.ref,
        risk: step.risk,
        actor: lease.holder,
        /**
         * The era this action was built in. The gate refuses it if control has
         * moved since, which is what makes an action minted before a handoff
         * unissuable afterwards BY CONSTRUCTION rather than by an argument about
         * the order these lines happen to run in.
         */
        epoch: lease.epoch,
        url: observation.location,
        screen: observation.screen,
        ...(step.action === "fill" && step.target ? { field: step.target } : {}),
      };

      try {
        resolution = await surface.act(action, actionCtx);
        // It passed the gate and reached the application. Whether its
        // postcondition later holds is a different question from whether it
        // landed, and only the second one governs "may I retry?".
        if (couldHaveCommitted(step)) committed = true;
      } catch (e) {
        if (!(e instanceof SurfaceRefused)) throw e;
        const detail = e.detail as { requires?: string; ruleId?: string; effectiveRisk?: string; attempted?: string[] } | undefined;

        // "Needs a person" is a different outcome from "forbidden": the first
        // escalates, the second stops. This is the ONLY production trigger for a
        // handoff — deliberately one site rather than every hard failure, because
        // §3.6 asks for a real control transfer, not a wide trigger surface.
        if (detail?.requires === "human") {
          const effectiveRisk = detail.effectiveRisk ?? step.risk;
          const ruleId = detail.ruleId ?? "risk";
          /**
           * Named for the question rather than for the flag, because a local
           * called `committed` here would SHADOW the run-scoped one above and
           * quietly answer a narrower question than the caller asked.
           */
          const mustReconcile = committed || couldHaveCommitted(step);

          log.emit(
            "escalation.required",
            { as: "policy", ruleId, allowed: false, dimension: "risk" },
            { stepRef: step.ref, expected: `a human decision for a ${effectiveRisk} action`, observed: e.message },
          );

          /**
           * Nobody to ask, and that is a normal configuration rather than an
           * error. It is reported as an escalation timeout, NOT `policy_denied`:
           * that kind now means only "forbidden, never retry", while the correct
           * move here is the opposite — attach an operator and invoke again.
           */
          if (deps.escalate === undefined) {
            return fail(
              step.ref,
              "escalation_timeout",
              `a human to decide a ${effectiveRisk} action at ${step.ref}`,
              `${e.message}; no operator channel is attached to this run, so nobody could take the session`,
              // Correct for THIS step — it was refused before it ran — but the run
              // is the unit of the question, and an earlier step may have landed.
              committed ? "reconcile_required" : "retry_safe",
              committed ? "unknown" : "none",
            );
          }

          // CAPPED. The policy is unchanged by a human turn, so a step that asks
          // twice would refuse identically and escalate forever.
          if (escalated.has(step.ref) || interventions.length >= MAX_ESCALATIONS_PER_RUN) {
            return fail(
              step.ref,
              "unresolved_after_handoff",
              `${step.ref} to be complete after its human turn`,
              escalated.has(step.ref)
                ? `${step.ref} still requires a human after one handoff`
                : `the run has already used its ${MAX_ESCALATIONS_PER_RUN} permitted escalation(s)`,
              mustReconcile ? "reconcile_required" : "retry_safe",
              mustReconcile ? "unknown" : "none",
            );
          }

          /**
           * Perception still works here, and that is by design rather than by
           * luck: the gate delegates the read paths ungated (gated.ts), precisely
           * so a run can describe its own predicament to a person and
           * re-synchronise afterwards. This is also `screenshot()`'s first
           * production caller anywhere in the repo.
           */
          /**
           * SCOPED TO WHAT IS ACTUALLY ON THIS SCREEN — BY MEASUREMENT.
           *
           * The filter used to pass EVERY `nameMayContainPii` target in the plan,
           * including ones declared for screens the run is nowhere near. With
           * `failClosed: true` the driver then refused the whole capture because
           * those regions could not resolve, so the operator got NO picture at
           * all — the §3.6-b "current state or screenshot" quietly missing on
           * every escalation from a multi-screen plan.
           *
           * Scoping by comparing `target.screen` to `observation.screen` does NOT
           * work here and the reason is worth recording: `replay/index.ts`
           * resolves targets through the binding before the run, so
           * `target.screen` is the TENANT LITERAL (`CRD0500`), while
           * `BoundSurface` canonicalises the observation back to the SYMBOL
           * (`CARD_SERVICES`). The two never compare equal after resolution, so a
           * name-based filter would select nothing and hand `screenshot()` an
           * EMPTY mask list — which `failClosed` accepts, because zero requested
           * regions all resolved. That is a fail-OPEN capture of a servicing
           * screen, the exact leak this option exists to prevent.
           *
           * So the scope is established by asking the surface what it can find
           * right now. A target that resolves is on this screen and gets masked;
           * one that does not is not rendered and has nothing to mask. This is
           * exactly as strong as the driver's own masking, which resolves the
           * same way, and strictly better than refusing every picture.
           */
          const piiTargets = capability.plan.targets.filter((t) => t.nameMayContainPii);
          const masked: typeof piiTargets = [];
          for (const t of piiTargets) {
            if ((await surface.find(t).catch(() => null)) !== null) masked.push(t);
          }
          let shot: { readonly bytes: Uint8Array; readonly maskedRegions: number } | undefined;
          try {
            shot = { bytes: await surface.screenshot({ mask: masked, failClosed: true }), maskedRegions: masked.length };
          } catch {
            // failClosed means NO PICTURE rather than an unmasked one: a capture
            // of a servicing screen already contains the PAN. The operator still
            // gets the text state, which has been through the redactor.
          }

          const draft: InterventionDraft = {
            runId: deps.runId ?? "(unidentified run)",
            capability: { id: capability.contract.id, version: capability.contract.version, goal: capability.contract.goal },
            stepRef: step.ref,
            stepTitle: step.title,
            action: step.action,
            effectiveRisk,
            reason: e.message,
            ruleId,
            screen: observation.screen,
            location: observation.location,
            observedText: redactText(observation.text),
            ...(shot === undefined ? {} : { screenshot: shot }),
          };

          const handoff = await deps.escalate(draft);
          pausedMs += handoff.pausedMs;
          escalated.add(step.ref);

          /**
           * The only honest source for "what the human did". Automation cannot
           * watch a person's hands, but it CAN compare the surface either side of
           * the turn — so the record carries a measurement rather than a claim.
           * On an app with a mutating route and an audit trail, that log would be
           * the second source and the stronger one.
           */
          const after = await surface.observe();
          const moved =
            after.screen !== observation.screen || after.location !== observation.location || after.digest !== observation.digest;
          const settled: EscalationRecord = {
            ...handoff.record,
            reconstructedActions: [
              ...handoff.record.reconstructedActions,
              moved
                ? `observed after the turn: screen ${observation.screen ?? "(unknown)"} -> ${after.screen ?? "(unknown)"}, surface changed`
                : "observed after the turn: no change to screen, location or content digest",
            ],
          };
          interventions.push(settled);

          /**
           * THE ROW THAT REACHES `handoff.jsonl` (§3.6-d, "record what the human
           * did"). Assembled here because this is the only place that holds both
           * halves at once — the settled `EscalationRecord` and the context the
           * request was raised with. `observedText` is redacted at the same point
           * it was for the operator: MBR0400 renders an SSN as plain text, and
           * the writer redacts again on the way to disk.
           */
          deps.onHandoff?.({
            ...settled,
            runId: deps.runId ?? "(unidentified run)",
            capability: `${capability.contract.id}@${capability.contract.version}`,
            goal: capability.contract.goal,
            screen: observation.screen,
            observedText: draft.observedText,
          });

          /**
           * WHAT A HUMAN TURN MAY HAVE LEFT BEHIND.
           *
           * This used to report the constant `none`, justified by the target app
           * having no mutating route at all — true when it was written, and the
           * comment said that an app with one should key on the observed delta
           * instead. `POST /screen/card-action` exists now, so it does.
           *
           * `moved` is the honest measurement and it is the ONLY one available:
           * automation cannot watch a person's hands, and the person was handed
           * the session precisely because the step was too risky for automation.
           * A surface that changed across the turn is the evidence that something
           * happened; `committed` covers a mutating step this run had already
           * landed before it ever asked for help.
           *
           * The two dispositions diverge on remediation because the operator's
           * intent differs. ABORT keeps `do_not_retry` — a person looked at it
           * and said stop, and no automatic retry should overrule that — but it
           * can no longer claim nothing changed. TIMEOUT means nobody came, so
           * re-invoking is the right move only when the session is demonstrably
           * untouched; otherwise the truth has to be established first.
           */
          const disturbed = committed || moved;

          if (handoff.outcome.kind === "abort") {
            return fail(
              step.ref,
              "operator_abort",
              `${step.ref} to be completed or declined by a person`,
              `operator ${handoff.outcome.operator} took the session and aborted the run`,
              "do_not_retry",
              disturbed ? "unknown" : "none",
            );
          }
          if (handoff.outcome.kind === "timeout") {
            return fail(
              step.ref,
              "escalation_timeout",
              `a human to take the live session before the escalation TTL elapsed`,
              "nobody took the session before it expired",
              disturbed ? "reconcile_required" : "retry_safe",
              disturbed ? "unknown" : "none",
            );
          }

          /**
           * RESUMED, and this is the sharpest decision in the flow: automation
           * does NOT re-attempt the action the policy just refused. The policy
           * still rates it `${effectiveRisk}` and would refuse identically, so a
           * retry is a guaranteed infinite escalation. The person was asked to
           * perform the step in the live session, so the run skips the action and
           * falls through to THIS SAME STEP's postcondition — which is the
           * re-synchronisation §3.6 requires, and which needs no restructuring of
           * the loop because it happens inside this iteration.
           */
          humanPerformed = true;
          /**
           * The person was asked to perform, by hand, the very action the policy
           * refused — so on a mutating step the run must now assume it landed.
           * Assuming the opposite is the failure this flag exists to prevent:
           * it would report `retry_safe` on a card a human has just frozen.
           */
          if (couldHaveCommitted(step)) committed = true;
          log.emit(
            "step.resumed",
            { as: "artifact_step", capability: capability.contract.id, version: capability.contract.version, stepRef: step.ref },
            {
              stepRef: step.ref,
              expected: `${step.ref}'s postcondition to hold, performed by ${handoff.outcome.operator}`,
              observed: "automation did not re-attempt the action the policy refused",
            },
          );
        } else {
          const kind: FailureKind = e.reason === "target_unresolvable" ? "target_unresolvable" : "policy_denied";
          return fail(
            step.ref,
            kind,
            "an action permitted by policy on a resolvable target",
            e.message,
            "do_not_retry",
            // THIS step was refused before it ran, so its own risk is irrelevant.
            // An earlier step's is not: the run may already have committed.
            committed ? "unknown" : "none",
            detail?.attempted,
          );
        }
      }

      // Skipped entirely after a human turn: automation issued no action, and a
      // `step.acted` citation for a step it did not act on would be a false one.
      if (!humanPerformed) {
        if (resolution?.degraded) {
          degradations.push({ stepRef: step.ref, strategyUsed: resolution.strategyUsed, strategyExpected: resolution.strategyExpected });
        }
        log.emit(
          "step.acted",
          { as: "artifact_step", capability: capability.contract.id, version: capability.contract.version, stepRef: step.ref },
          {
            stepRef: step.ref,
            // Conditional spread rather than an explicit `undefined`: the log omits
            // a field it has nothing to say about instead of recording a hole,
            // which is also what keeps the diff projection clean.
            ...(resolution ? { detail: { strategy: resolution.strategyUsed, degraded: resolution.degraded } } : {}),
          },
        );
      }
    }

    /**
     * ---- postcondition: did it actually do what it claimed? -----------------
     *
     * A LOOP, exactly like the precondition above, and sharing the SAME `used`
     * array so `maxAttempts` still bounds the rule across the whole step. This
     * is the headline fix: a `recoverable` classification here used to fall
     * through to `fail(..., "postcondition_failed")` with `recoveries: []` —
     * the rule never applied, the dialog never dismissed, nothing logged.
     *
     * Two further defects went with it, and both are gone by construction rather
     * than by patching:
     *
     *   - `expected` carried `post.c.evidence.summary`, which is the RECOVERY
     *     RULE's own predicate — so §3.3-g's "what was expected" named a
     *     condition the step had never asked for. The recoverable arm no longer
     *     produces a failure at all; once the rule is exhausted `classify()`
     *     falls through to the hard-failure arm, whose `expected` is the STEP's
     *     postcondition and whose `observed` is the condition that persisted.
     *   - because `classify()` ranks recovery above the postcondition, the old
     *     arm fired even when the postcondition ALREADY HELD. Now the rule is
     *     applied, the loop re-observes, and the satisfied postcondition is
     *     seen on the next pass.
     */
    for (;;) {
      const post = await observeAndClassify(step.post, used);

      if (post.c.kind === "recoverable") {
        const refused = await applyRecovery(post.c, step, used, post.location, post.screen);
        if (refused !== null) return refused;
        continue;
      }

      if (post.c.kind === "business_outcome") {
        return businessOutcome(step.ref, post.c);
      }

      if (post.c.kind === "hard_failure") {
        // A step that may have committed something and then could not confirm it
        // is the dangerous case: the caller must reconcile rather than blindly
        // retry. A read_only step in the same position is simply retryable.
        const mustReconcile = committed || couldHaveCommitted(step);
        return fail(
          step.ref,
          // After a human turn this is not "the action did not work" — automation
          // issued no action. It is "the run could not re-establish its position",
          // which is its own kind precisely so a caller can tell the two apart.
          humanPerformed ? "unresolved_after_handoff" : post.c.failureKind,
          post.c.expected,
          humanPerformed ? `after the human turn, ${post.c.observed}` : post.c.observed,
          mustReconcile ? "reconcile_required" : "retry_safe",
          mustReconcile ? "unknown" : "none",
        );
      }

      break; // postcondition holds
    }

    stepsCompleted += 1;
  }

  /**
   * ---- EVERY DECLARED OUTPUT MUST EXIST -------------------------------------
   *
   * The step loop populates outputs as it goes; nothing checked that it had.
   * A capability declaring `confirmation_number` could reach its checkpoint with
   * that output absent — because its producing step was never reached, or was a
   * verb that cannot produce one — and `replay()` would return `status:
   * "success"` with the field simply missing from the object. A caller reading
   * `outputs.confirmation_number` would get `undefined` from a successful run.
   *
   * Schema refinement 5 makes the second cause unrepresentable (a producer must
   * be a `read`); this covers the first, and covers an artifact that reached the
   * engine without going through `parseCapability`.
   */
  const missingOutputs = capability.contract.outputs.filter((o) => !(o.name in outputs));
  if (missingOutputs.length > 0) {
    return fail(
      missingOutputs[0]?.producedBy ?? null,
      "contract_violation",
      `every declared output to be populated (${capability.contract.outputs.map((o) => o.name).join(", ")})`,
      `${missingOutputs.map((o) => `"${o.name}" (declared as produced by ${o.producedBy})`).join("; ")} was never populated`,
      committed ? "reconcile_required" : "do_not_retry",
      committed ? "unknown" : "none",
    );
  }

  /**
   * ---- THE CAPABILITY CHECKPOINT --------------------------------------------
   *
   * Every step passing its own postcondition is not the same as the capability
   * having achieved what it claims. §3.2 requires a declared success condition
   * and §3.3 requires replay to VERIFY it, so it is asserted here rather than
   * inferred from the last step.
   *
   * ROUTED THROUGH `classify()` LIKE EVERY OTHER OBSERVATION POINT, which it was
   * not. It raced ONE expectation and never classified, and both halves of that
   * were wrong in opposite directions:
   *
   *   - a declared BUSINESS OUTCOME visible at the checkpoint was reported as
   *     `checkpoint_failed` — the §3.3 conflation the whole contract exists to
   *     prevent, arriving at the last possible moment;
   *   - worse, a declared RECOVERABLE dialog sitting on screen was ignored into
   *     a `success` whenever the checkpoint predicate still matched underneath
   *     it. That is a phantom success in the exact sense this design claims to
   *     prevent: the run reports the goal reached while an obstruction it knows
   *     how to clear is still on the screen.
   */
  const checkpointUsed: string[] = [];
  for (;;) {
    const final = await observeAndClassify(capability.plan.checkpoint, checkpointUsed);

    if (final.c.kind === "recoverable") {
      const refused = await applyRecovery(final.c, null, checkpointUsed, final.location, final.screen);
      if (refused !== null) return refused;
      continue;
    }

    if (final.c.kind === "business_outcome") {
      // Through the ONE helper, so the citation cannot be forgotten here either.
      return businessOutcome(null, final.c);
    }

    if (final.c.kind === "hard_failure") {
      /**
       * THE MOST DANGEROUS OF THE THREE, and the one that never consulted risk
       * at all. Every step passed its own postcondition, so a mutating step DID
       * land; only the capability-level claim failed. Answering `retry_safe`
       * there tells a calling agent to re-invoke a capability that has already
       * frozen the card — the double-commit this contract exists to prevent.
       *
       * `undeclared_dialog` survives rather than being flattened: "the goal was
       * not reached" and "something nobody anticipated is blocking the screen"
       * send an engineer to two different places.
       */
      return fail(
        null,
        final.c.failureKind === "undeclared_dialog" ? "undeclared_dialog" : "checkpoint_failed",
        final.c.expected,
        `${final.c.observed} — after ${stepsCompleted} step(s)`,
        committed ? "reconcile_required" : "retry_safe",
        committed ? "unknown" : "none",
      );
    }

    return report({ kind: "completed", checkpoint: final.c.evidence });
  }
};
