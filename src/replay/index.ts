/**
 * THE PRODUCTION ENTRY POINT — `replay()`.
 *
 * This is the only public door into the execution path, and the module the
 * no-LLM import walker targets: a CI check walks the static import graph from
 * here and fails if it can reach a model SDK, `src/model/**` or `src/discover/**`.
 * That is how §3.3-a's "without invoking the LLM for decisions" becomes a
 * property a reviewer can verify by running a script, rather than a claim.
 *
 * Three things happen here that deliberately do NOT happen in the executor:
 *
 *  1. INPUT VALIDATION BEFORE THE UI IS TOUCHED. A caller's bad argument is
 *     caught against the capability's own declared input schema, and the run
 *     returns `input_schema_violation` having issued zero surface calls. A
 *     malformed member id must never become a half-finished form.
 *
 *  2. BINDING RESOLUTION, ALSO BEFORE THE UI IS TOUCHED. The plan speaks symbols;
 *     this resolves them to one tenant's literals up front, so a binding gap is
 *     caught at load rather than mid-flight on a screen check. A symbol the
 *     tenant cannot supply is DRIFT (§3.7-d) and comes back as a typed failure
 *     rather than an exception escaping the entry point.
 *
 *  3. RESULT ASSEMBLY. The executor reports what happened; this maps it onto the
 *     three-variant contract the caller switches on, attaching the envelope
 *     (recoveries, degradations, interventions, who held control at exit, and
 *     the model-call count, which is zero by construction).
 */
import { UnboundSymbol, resolve, type Binding } from "../capability/bind.js";
import type { Capability } from "../capability/schema.js";
import type {
  ControlOwner,
  DegradationRecord,
  EscalationRecord,
  Evidence,
  RecoveryRecord,
  ReplayResult,
} from "../contract/result.js";
import type { Escalate } from "../control/escalation.js";
import type { ControlLease } from "../control/lease.js";
import type { EventSequencer } from "../evidence/events.js";
import type { Surface } from "../surface/types.js";
import { runSteps, type RunReport } from "./executor.js";

export interface ReplayDeps {
  /**
   * Must already be wrapped: PlaywrightSurface -> BoundSurface -> GatedSurface.
   * `replay` never constructs a driver and never holds a raw one.
   */
  readonly surface: Surface;
  readonly lease: ControlLease;
  readonly log: EventSequencer;
  readonly runId: string;
  readonly budgets: { readonly stepMs: number; readonly runMs: number };
  readonly now: () => number;
  /**
   * The escalation orchestrator, when this deployment has an operator channel.
   *
   * OPTIONAL DELIBERATELY. Every existing construction site of this interface
   * predates the handoff and none of them needs to change, which is the property
   * that keeps "add a human in the loop" from being a breaking change to the
   * calling contract. A run without it still reports honestly that it needed a
   * person (`escalation_timeout`) rather than that the action was forbidden.
   */
  readonly escalate?: Escalate;
}

export interface InputIssue {
  readonly name: string;
  readonly problem: string;
}

/**
 * Validate the caller's arguments against the capability's declared inputs.
 *
 * Pure and UI-free on purpose: this is the check that must run before a browser
 * is ever asked to do anything.
 */
export const validateInputs = (
  capability: Capability,
  params: Readonly<Record<string, string>>,
): InputIssue[] => {
  const issues: InputIssue[] = [];

  for (const input of capability.contract.inputs) {
    const value = params[input.name];

    if (value === undefined || value === "") {
      if (input.required) issues.push({ name: input.name, problem: "required but not supplied" });
      continue;
    }
    if (input.pattern && !new RegExp(input.pattern).test(value)) {
      issues.push({ name: input.name, problem: `does not match ${input.pattern}` });
    }
    if (input.type === "enum" && input.enumValues && !input.enumValues.includes(value)) {
      issues.push({ name: input.name, problem: `must be one of ${input.enumValues.join(", ")}` });
    }
    if (input.type === "integer" && !/^-?\d+$/.test(value)) {
      issues.push({ name: input.name, problem: "must be an integer" });
    }
  }

  // An argument the capability does not declare is a caller bug, not a courtesy.
  for (const name of Object.keys(params)) {
    if (!capability.contract.inputs.some((i) => i.name === name)) {
      issues.push({ name, problem: "not declared by this capability" });
    }
  }

  return issues;
};

/**
 * How one declared input reads in a message: its name, its type, and every
 * constraint the caller had to satisfy.
 *
 * Shared by the log line and the result's `evidence.expected` so the two cannot
 * drift. The previous version of that field said only "member_id: string" while
 * the observed half said "does not match ^\d{9}$" — an expected/observed pair
 * whose two halves did not answer each other.
 */
const declared = (input: Capability["contract"]["inputs"][number]): string =>
  [
    `${input.name}: ${input.type}`,
    input.required ? "required" : "optional",
    ...(input.pattern ? [`matching ${input.pattern}`] : []),
    ...(input.enumValues ? [`one of ${input.enumValues.join("|")}`] : []),
  ].join(", ");

/**
 * The artifact clause a rejection cites, as a path a reviewer can follow into
 * the capability.json sitting in the same run directory. One offending input
 * names itself; several name the contract section they all came from.
 *
 * MEASURED: replaying with `--input ssn=...` alone cited `contract.inputs.ssn`,
 * a path that does not exist in the artifact — the offending name came from the
 * CALLER, not from the contract. An `artifact_step` citation that does not
 * resolve is the one thing this arm promises it never is, so an undeclared
 * argument cites the section it violated instead of a clause of its own.
 */
const citedClause = (capability: Capability, issues: readonly InputIssue[]): string => {
  const only = issues.length === 1 ? issues[0] : undefined;
  if (only === undefined) return "contract.inputs";
  return capability.contract.inputs.some((i) => i.name === only.name)
    ? `contract.inputs.${only.name}`
    : "contract.inputs";
};

/**
 * §3.5-b's "richer signal", named as a path a reviewer can open.
 *
 * `Evidence.bundle` had ZERO producers repo-wide until now — a declared field
 * pointing at nothing. A run that handed the session to a person is exactly the
 * run where an expected/observed pair is not enough, and the control transfer is
 * written to this file in the run's own directory.
 */
const HANDOFF_BUNDLE = "handoff.jsonl";

const withBundle = (evidence: Evidence, interventions: readonly EscalationRecord[]): Evidence =>
  interventions.length > 0 ? { ...evidence, bundle: HANDOFF_BUNDLE } : evidence;

const envelope = (
  capability: Capability,
  binding: Binding,
  deps: ReplayDeps,
  report: RunReport | null,
  controlAtExit: ControlOwner,
) => ({
  capability: { id: capability.contract.id, version: capability.contract.version },
  runId: deps.runId,
  tenant: binding.tenant,
  recoveries: (report?.recoveries ?? []).map(
    (r): RecoveryRecord => ({ stepRef: r.stepRef, ruleId: r.ruleId, observed: r.observed, attempts: r.attempts }),
  ),
  degradations: (report?.degradations ?? []).map(
    (d): DegradationRecord => ({ stepRef: d.stepRef, strategyUsed: d.strategyUsed, strategyExpected: d.strategyExpected }),
  ),
  interventions: (report?.interventions ?? []) as readonly EscalationRecord[],
  controlAtExit,
  /** Zero by construction: no model SDK is reachable from this module. */
  modelCalls: 0,
});

export const replay = async (
  capability: Capability,
  binding: Binding,
  params: Readonly<Record<string, string>>,
  deps: ReplayDeps,
): Promise<ReplayResult> => {
  const base = envelope(capability, binding, deps, null, deps.lease.holder);

  // 1. The caller's arguments, before anything is driven.
  const issues = validateInputs(capability, params);
  if (issues.length > 0) {
    const expected = capability.contract.inputs.map(declared).join(", ");
    const observed = issues.map((i) => `${i.name} ${i.problem}`).join("; ");

    /**
     * THE REJECTION IS LOGGED, NOT ONLY RETURNED.
     *
     * MEASURED: replaying msc.member.lookup with member_id=abc exited 1 with
     * kind input_schema_violation and left a run directory of exactly
     * [capability.json, manifest.json]. Nothing had emitted, so the writer
     * looped over an empty array and events.jsonl was ABSENT rather than empty.
     * The run §6 asks for by name — "a replay that hits an error or exceptional
     * state" — was the one run that left nothing to read.
     *
     * WHICH `why` ARM IS HONEST HERE is the whole question, and five of the six
     * are wrong in ways that matter:
     *
     *   model_decision  false outright: no model ran. verify-evidence fails a
     *                   model_decision line in a replay run precisely because it
     *                   would contradict the claim the replay path rests on.
     *   policy          a citation a reviewer cannot follow. `ruleId` names a
     *                   rule in the POLICY document everywhere else it appears
     *                   (`route.denied:/__admin`, `risk`), and that document
     *                   says nothing about member_id.
     *   handler         no declared plan.recovery[] rule fired.
     *   outcome_signal  the most damaging misuse on offer: it would file a
     *                   caller's malformed argument as a declared business
     *                   answer, which is the §3.3 conflation the result contract
     *                   exists to prevent.
     *   operator        no person was involved.
     *
     * So `artifact_step`, because this rejection genuinely IS a citation of the
     * artifact: msc.member.lookup@1.0.0's own `contract.inputs` declared the
     * pattern the argument failed, and capability.json is written into the same
     * run directory for a reviewer to check it against.
     *
     * SAID LOUDLY, because it stretches one field: `stepRef` carries the artifact
     * CLAUSE that decided (`contract.inputs.member_id`) rather than a step id,
     * since no step ran — which is also why the event's own stepRef is null,
     * matching the result's. A fabricated "s00" would have been a citation to a
     * step that does not exist. A seventh `Why` arm was the other candidate and
     * was rejected on both counts: the six are a closed vocabulary that
     * verify-evidence validates arm by arm, and the citation semantics already
     * fit — this is a pointer into the artifact and it resolves.
     *
     * Redaction (§3.4-e) falls out of `issues` carrying declarations only: the
     * field name and the constraint it broke reach the log, the value the caller
     * supplied never does.
     */
    deps.log.emit(
      "inputs.rejected",
      {
        as: "artifact_step",
        capability: capability.contract.id,
        version: capability.contract.version,
        stepRef: citedClause(capability, issues),
      },
      { stepRef: null, expected, observed },
    );

    return {
      ...base,
      status: "failed",
      kind: "input_schema_violation",
      stepRef: null,
      evidence: { expected, observed },
      remediation: "retry_safe",
      sideEffectRisk: "none",
    };
  }

  // 2. The tenant's literals, also before anything is driven. A gap here is
  //    drift, and it is far better found now than on a screen check mid-run.
  let bound: Capability;
  try {
    const resolved = resolve(capability, binding);
    // Copy rather than alias: this is a new per-tenant view of the plan, and the
    // resolver's array is readonly by design so callers cannot mutate it.
    bound = { ...capability, plan: { ...capability.plan, targets: [...resolved.targets] } };
  } catch (e) {
    if (!(e instanceof UnboundSymbol)) throw e;
    const expected = `binding "${binding.tenant}" to supply ${e.kind} symbol ${e.symbol}`;

    // Logged for the same reason as the input rejection above, and on the same
    // arm: this too is a citation of the artifact. `plan.targets` is the clause a
    // reviewer opens to see which symbols the recorded flow asks a tenant for;
    // `observed` carries which one this binding could not answer. Without the
    // line, a drift rejection — the §3.7-d signal the whole binding layer exists
    // to surface — would leave a run directory with no trail of what drifted.
    deps.log.emit(
      "binding.unresolved",
      {
        as: "artifact_step",
        capability: capability.contract.id,
        version: capability.contract.version,
        stepRef: "plan.targets",
      },
      { stepRef: null, expected, observed: e.message },
    );

    return {
      ...base,
      status: "failed",
      kind: "drift_suspected",
      stepRef: null,
      evidence: { expected, observed: e.message },
      remediation: "do_not_retry",
      sideEffectRisk: "none",
    };
  }

  // 3. Walk the recorded plan, now speaking this tenant's markup.
  const report = await runSteps(bound, params, {
    surface: deps.surface,
    lease: deps.lease,
    log: deps.log,
    budgets: deps.budgets,
    now: deps.now,
    runId: deps.runId,
    // An absent orchestrator is absent, not `undefined`: exactOptionalPropertyTypes
    // draws that distinction and the conditional spread respects it.
    ...(deps.escalate === undefined ? {} : { escalate: deps.escalate }),
  });

  const full = envelope(capability, binding, deps, report, deps.lease.holder);
  const outcome = report.outcome;

  switch (outcome.kind) {
    case "completed":
      return {
        ...full,
        status: "success",
        outputs: report.outputs,
        // The executor asserts `plan.checkpoint` itself now, so this reports what
        // was genuinely verified rather than the final step's postcondition
        // wearing the checkpoint's name.
        checkpoint: [withBundle({ expected: outcome.checkpoint.summary, observed: "satisfied" }, full.interventions)],
      };

    case "business_outcome":
      return {
        ...full,
        status: "business_outcome",
        code: outcome.code,
        message: outcome.message,
        matchedSignal: outcome.matchedSignal,
        evidence: withBundle({ expected: outcome.matchedSignal, observed: "matched" }, full.interventions),
      };

    /**
     * THE `needs_human` ARM IS GONE, and its absence is the point.
     *
     * It used to downgrade "a person must approve this" to
     * `policy_denied` / `do_not_retry` — the same answer a caller gets for
     * "this is forbidden, never retry". A calling agent could not tell the two
     * apart, so the one case where a human could unblock the run looked
     * identical to the one where nothing ever will.
     *
     * The executor now returns the three escalation kinds as ordinary typed
     * failures, so they arrive through the arm below with the remediation the
     * handoff actually established. There is one mapping rather than four, and
     * the variant is deleted from `RunOutcome` so no path can produce it again.
     */
    case "failed":
      return {
        ...full,
        status: "failed",
        kind: outcome.failureKind,
        stepRef: outcome.stepRef,
        evidence: withBundle({ expected: outcome.expected, observed: outcome.observed }, full.interventions),
        remediation: outcome.remediation,
        sideEffectRisk: outcome.sideEffectRisk,
        ...(outcome.attempted ? { attempted: outcome.attempted } : {}),
      };
  }
};
