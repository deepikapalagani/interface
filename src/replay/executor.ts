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
import { redactText } from "../safety/redact.js";
import { SurfaceRefused, type ActionContext, type Resolution, type Surface, type SurfaceAction } from "../surface/types.js";
import { classify, type Classification } from "./classify.js";
import type { EvalContext, PredicateResult } from "./predicate.js";
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
  readonly outputs: Readonly<Record<string, string>>;
}

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

const substitute = (value: string, params: Readonly<Record<string, string>>): string =>
  value.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (whole, name: string) => params[name] ?? whole);

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
  for (const r of capability.plan.recovery) list.push({ id: `recovery:${r.id}`, predicate: { all: [r.when], any: [] } });
  return list;
};

/** The one classify() arm that both business-outcome exits below carry. */
type BusinessOutcome = Extract<Classification, { kind: "business_outcome" }>;

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
  const outputs: Record<string, string> = {};
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

  const fail = (
    stepRef: string | null,
    failureKind: FailureKind,
    expected: string,
    observed: string,
    remediation: Remediation,
    sideEffectRisk: SideEffectRisk,
    attempted?: readonly string[],
  ): RunReport =>
    report({ kind: "failed", stepRef, failureKind, expected, observed, remediation, sideEffectRisk, ...(attempted ? { attempted } : {}) });

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
  const businessOutcome = (stepRef: string, c: BusinessOutcome): RunReport => {
    log.emit("outcome.matched", { as: "outcome_signal", code: c.code, matched: c.matchedSignal }, { stepRef });
    return report({ kind: "business_outcome", code: c.code, message: c.message, matchedSignal: c.matchedSignal, evidence: c.evidence });
  };

  /**
   * Wait for anything declared, then let precedence decide what it was.
   * `settle` chooses the moment; `classify` is authoritative about the meaning.
   */
  const observeAndClassify = async (
    expect: Step["post"] | null,
    used: readonly string[],
  ): Promise<{ c: Classification; location: string; screen: string | null; timedOut: boolean }> => {
    const settled = await settle(surface, expectationsFor(capability, expect), ctx, { budgetMs: budgets.stepMs, now });
    const c = await classify({ observation: settled.observation, capability, expectation: expect, usedRecoveries: used }, ctx);
    return {
      c,
      location: settled.observation.location,
      screen: settled.observation.screen,
      timedOut: settled.matched === null,
    };
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
      const { c, location, screen, timedOut } = await observeAndClassify(step.pre, used);

      if (c.kind === "recoverable") {
        used.push(c.ruleId);
        const attempts = used.filter((u) => u === c.ruleId).length;
        recoveries.push({ stepRef: step.ref, ruleId: c.ruleId, observed: c.evidence.summary, attempts });
        log.emit("recovery.applied", { as: "handler", ruleId: c.ruleId, attempt: attempts }, { stepRef: step.ref, observed: c.evidence.summary });

        if (c.action === "dismiss_dialog" || c.action === "accept_dialog") {
          const action: SurfaceAction = c.action === "accept_dialog" ? { kind: "accept_dialog" } : { kind: "dismiss_dialog" };
          await surface.act(action, { stepRef: step.ref, risk: "read_only", actor: lease.holder, epoch: lease.epoch, url: location, screen });
          /**
           * ACCEPTING a dialog can commit; DISMISSING one cancels, which is the
           * whole reason an unhandled confirm() produces a phantom success. So
           * only the accept arm arms the flag, and only on a step that could
           * commit at all. Unreachable under the shipped policy, whose
           * `allowedActions` omits `accept_dialog` — armed anyway, because a
           * policy is configuration and this is the engine.
           */
          if (c.action === "accept_dialog" && couldHaveCommitted(step)) committed = true;
        }
        continue; // re-evaluate the same step
      }

      if (c.kind === "business_outcome") {
        return businessOutcome(step.ref, c);
      }

      if (c.kind === "hard_failure") {
        // THIS step never acted — its precondition is what failed. But an EARLIER
        // step in the same run may already have committed, and the question the
        // caller asked is about the run, not about this step.
        return fail(
          step.ref,
          timedOut ? "precondition_failed" : c.failureKind,
          c.expected,
          c.observed,
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

    let resolution: Resolution | null = null;

    if (step.action === "read" && target) {
      // A read never acts, so it never builds an action and never passes the gate.
      const value = await surface.read(target);
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
      const output = capability.contract.outputs.find((o) => o.producedBy === step.ref);
      if (output) outputs[output.name] = value;
      log.emit(
        "step.read",
        { as: "artifact_step", capability: capability.contract.id, version: capability.contract.version, stepRef: step.ref },
        { stepRef: step.ref, observed: output ? `${output.name} captured` : "value read" },
      );
    } else if (step.action !== "assert" && target) {
      const observation = await surface.observe();
      const action: SurfaceAction =
        step.action === "fill"
          ? { kind: "fill", target, value: substitute(step.value ?? "", params) }
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
          const masked = capability.plan.targets.filter((t) => t.nameMayContainPii);
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
          interventions.push({
            ...handoff.record,
            reconstructedActions: [
              ...handoff.record.reconstructedActions,
              moved
                ? `observed after the turn: screen ${observation.screen ?? "(unknown)"} -> ${after.screen ?? "(unknown)"}, surface changed`
                : "observed after the turn: no change to screen, location or content digest",
            ],
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

    // ---- postcondition: did it actually do what it claimed? -------------------
    const post = await observeAndClassify(step.post, used);

    if (post.c.kind === "business_outcome") {
      return businessOutcome(step.ref, post.c);
    }

    if (post.c.kind === "hard_failure") {
      // A step that may have committed something and then could not confirm it is
      // the dangerous case: the caller must reconcile rather than blindly retry.
      // A read_only step in the same position is simply retryable.
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

    if (post.c.kind === "recoverable") {
      const mustReconcile = committed || couldHaveCommitted(step);
      return humanPerformed
        ? fail(
            step.ref,
            "unresolved_after_handoff",
            `${step.ref} to be complete after its human turn`,
            `a recoverable condition is on screen after the human turn: ${post.c.evidence.summary}`,
            mustReconcile ? "reconcile_required" : "retry_safe",
            mustReconcile ? "unknown" : "none",
          )
        : fail(
            step.ref,
            "postcondition_failed",
            post.c.evidence.summary,
            `a recoverable condition persisted after ${step.ref}`,
            // The same `mustReconcile` the human arm above uses. This arm is the
            // one where automation ITSELF issued the action, so if anything in
            // this run could have committed, it is at least as true here.
            mustReconcile ? "reconcile_required" : "retry_safe",
            mustReconcile ? "unknown" : "none",
          );
    }

    stepsCompleted += 1;
  }

  // ---- THE CAPABILITY CHECKPOINT ---------------------------------------------
  // Every step passing its own postcondition is not the same as the capability
  // having achieved what it claims. §3.2 requires a declared success condition
  // and §3.3 requires replay to VERIFY it, so it is asserted here rather than
  // inferred from the last step. Reporting the final postcondition as though it
  // were the checkpoint would be a success the system never actually checked.
  const final = await settle(
    surface,
    [{ id: "checkpoint", predicate: capability.plan.checkpoint }],
    ctx,
    { budgetMs: budgets.stepMs, now },
  );
  const checkpoint = final.evaluations["checkpoint"];

  if (final.matched !== "checkpoint" || !checkpoint) {
    /**
     * THE MOST DANGEROUS OF THE THREE, and the one that never consulted risk at
     * all. Every step passed its own postcondition, so a mutating step DID land;
     * only the capability-level claim failed. Answering `retry_safe` there tells
     * a calling agent to re-invoke a capability that has already frozen the card
     * — the double-commit this contract exists to prevent. It was defensible
     * only while no route could mutate.
     */
    return fail(
      null,
      "checkpoint_failed",
      checkpoint?.summary ?? "the capability checkpoint",
      `screen ${final.observation.screen ?? "(unknown)"} after ${stepsCompleted} step(s)`,
      committed ? "reconcile_required" : "retry_safe",
      committed ? "unknown" : "none",
    );
  }

  return report({ kind: "completed", checkpoint });
};
