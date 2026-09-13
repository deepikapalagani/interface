/**
 * THE HANDOFF, PROVEN HEADLESS — raise, cede, human turn, hand back, resume.
 *
 * §3.6 permits the operator UI to be mocked and requires the control-transfer
 * MECHANISM to be real. This file sits exactly on that line, and follows the
 * split tests/gate.test.ts already made: the lease enforcement runs headless
 * against a stub "so it belongs in CI rather than in the one manual demo".
 *
 * Everything the escalation flows THROUGH is the production code — the policy
 * gate, the lease, the epoch fence, the control journal, the executor's resume,
 * the result mapping. The only thing simulated is WHO SUPPLIES THE INPUT: a
 * scripted transport stands where a person would be. The transport is never
 * allowed to fake an outcome in isolation; when it "performs the step" it does so
 * by changing what the shared surface reports, which is the only way the run can
 * possibly notice — a stub that returned a canned `resolved` without touching the
 * session would prove nothing about control transfer at all.
 *
 * No browser, no mock server, no model, and no test waits in real time: the TTL
 * deadline and the run clock are both injected.
 *
 * THE CONFLATION THIS EXISTS TO END. Before the handoff, a step the policy sent
 * to a human came back `policy_denied` / `do_not_retry` — indistinguishable from
 * "this is forbidden, never retry". `escalation_timeout`, `operator_abort` and
 * `unresolved_after_handoff` were declared in the result contract with no
 * producer anywhere. Each of the three is reached below.
 */
import { describe, expect, it } from "vitest";
import { Binding } from "../src/capability/bind.js";
import { parseCapability, type TargetDescriptor } from "../src/capability/schema.js";
import {
  runEscalation,
  type Escalate,
  type EscalationTransport,
  type HandoffOutcome,
  type InterventionRequest,
} from "../src/control/escalation.js";
import { ControlLease, ControlViolation } from "../src/control/lease.js";
import { EventSequencer, type LogEvent } from "../src/evidence/events.js";
import { PolicyDocument } from "../src/policy/policy.js";
import { runSteps, type RunReport } from "../src/replay/executor.js";
import { replay } from "../src/replay/index.js";
import { GatedSurface } from "../src/surface/gated.js";
import type {
  ActionContext,
  Observation,
  Resolution,
  ScreenshotOptions,
  Surface,
  SurfaceAction,
} from "../src/surface/types.js";

/**
 * Two steps, and both are load-bearing. `s01` is irreversible, so the shipped
 * risk policy rates it `confirm` and the gate refuses it with `requires: human` —
 * that refusal is the ONLY production trigger for a handoff. `s02` exists so
 * there is a NEXT STEP BOUNDARY after the turn, which is where a run charged for
 * the human's minutes would die `timeout`.
 */
const freeze = parseCapability({
  schemaVersion: 1,
  contract: {
    id: "msc.card.freeze",
    version: "1.0.0",
    goal: "Freeze the member's card and confirm it.",
    purpose: "Fixture for the escalation flow: the smallest plan with one step a policy must route to a person.",
    inputs: [],
    outputs: [],
    outcomes: [],
    risk: "irreversible",
    requiresSession: false,
  },
  plan: {
    app: "MERIDIAN MSC",
    targets: [
      {
        id: "FREEZE",
        screen: "CARD_SERVICES",
        framePath: [{ name: "content" }],
        strategies: [{ kind: "field_key", key: "FREEZE", matchedAtRecord: 1 }],
        verify: {},
        // True so the escalation screenshot has something to mask, and the mask
        // count reaching the driver can be asserted rather than assumed.
        nameMayContainPii: true,
        robustness: "Fixture target; resolution is stubbed by the scripted surface.",
      },
    ],
    steps: [
      {
        ref: "s01",
        title: "Press FREEZE on card services",
        action: "click",
        target: "FREEZE",
        pre: { all: [{ atom: "screen", is: "CARD_SERVICES" }], any: [] },
        post: { all: [{ atom: "screen", is: "CONFIRMATION" }], any: [] },
        risk: "irreversible",
        approval: "human_step_up",
      },
      {
        ref: "s02",
        title: "Confirm the card was frozen",
        action: "assert",
        pre: { all: [{ atom: "screen", is: "CONFIRMATION" }], any: [] },
        post: { all: [{ atom: "text", contains: "CNF9000" }], any: [] },
        risk: "read_only",
        approval: "none",
      },
    ],
    recovery: [],
    checkpoint: { all: [{ atom: "text", contains: "CNF9000" }], any: [] },
  },
  provenance: {
    discoveredAt: "2026-09-12T00:00:00Z",
    model: "none - test fixture, no model produced this",
    traceDigest: "0".repeat(64),
    appProfileVersion: "meridian-msc@4.2",
    modelAuthoredFields: [],
  },
  verification: { replayResult: "not_yet_verified" },
});

const [freezeTarget] = freeze.plan.targets;
if (freezeTarget === undefined) throw new Error("fixture is malformed: no target to act on");

const binding = Binding.parse({
  tenant: "fixture",
  appVersion: "4.2",
  frames: { content: "content", nav: "nav" },
  screens: { CARD_SERVICES: "CRD0500", CONFIRMATION: "CNF9000" },
  fields: { FREEZE: "FRZBTN" },
  labels: { FREEZE_LABEL: "Freeze" },
});

/** Irreversible is `confirm`, which is what routes s01 to a person rather than performing it. */
const policy = PolicyDocument.parse({
  version: "1.0.0",
  allowedOrigins: ["http://localhost:7101"],
  deniedRoutes: ["/__admin"],
  allowedActions: ["navigate", "click", "fill", "press", "dismiss_dialog"],
  screenRules: [],
  riskHandling: { read_only: "allow", reversible: "allow", irreversible: "confirm" },
  caps: { maxSteps: 40, maxRunSeconds: 300 },
});

const AT_CARD_SERVICES: Observation = {
  location: "http://localhost:7101/screen/card-services",
  screen: "CARD_SERVICES",
  nodes: [],
  text: "CRD0500 CARD SERVICES — CARD ****4021 — STATUS ACTIVE",
  dialog: null,
  digest: "d-card-services",
};

/** What the surface reports once the card has actually been frozen. */
const AT_CONFIRMATION: Observation = {
  location: "http://localhost:7101/screen/confirmation",
  screen: "CONFIRMATION",
  nodes: [],
  text: "CNF9000 CONFIRMATION — CARD ****4021 FROZEN",
  dialog: null,
  digest: "d-confirmation",
};

const resolution: Resolution = { strategyUsed: "field_key", strategyExpected: "field_key", matched: 1, degraded: false };

/** Records everything that reaches the driver, so "nothing happened" is checkable. */
class ScriptedSurface implements Surface {
  readonly acted: SurfaceAction[] = [];
  readonly reads: string[] = [];
  readonly shots: ScreenshotOptions[] = [];
  current: Observation;

  constructor(start: Observation) {
    this.current = start;
  }
  async observe(): Promise<Observation> {
    this.reads.push("observe");
    return this.current;
  }
  async find(_t: TargetDescriptor): Promise<Resolution | null> {
    this.reads.push("find");
    return resolution;
  }
  async describe(_ref: string): Promise<null> {
    return null;
  }
  async read(_t: TargetDescriptor): Promise<string | null> {
    this.reads.push("read");
    return null;
  }
  async act(action: SurfaceAction, _ctx: ActionContext): Promise<Resolution | null> {
    this.acted.push(action);
    this.current = AT_CONFIRMATION;
    return resolution;
  }
  onDialog(_h: (m: string) => void): void {}
  async screenshot(options: ScreenshotOptions): Promise<Uint8Array> {
    this.shots.push(options);
    return new Uint8Array([137, 80, 78, 71]);
  }
  async close(): Promise<void> {}
}

interface Stack {
  readonly stub: ScriptedSurface;
  readonly gated: GatedSurface;
  readonly lease: ControlLease;
  readonly log: EventSequencer;
  readonly now: () => number;
  /** Simulate wall time passing during a human turn. */
  readonly advance: (ms: number) => void;
  /** Read the clock WITHOUT advancing it, so an assertion cannot move it. */
  readonly peek: () => number;
}

const START_CLOCK = 1_000;

const stack = (start: Observation): Stack => {
  // Advances on every read: settle's budget is measured with this clock, so a
  // never-matching postcondition has to terminate rather than poll forever.
  let clock = START_CLOCK;
  const now = (): number => {
    clock += 250;
    return clock;
  };

  let leaseTick = 0;
  const lease = new ControlLease(() => new Date(Date.UTC(2026, 8, 12, 12, 0, leaseTick++)).toISOString());
  const stub = new ScriptedSurface(start);

  return {
    stub,
    gated: new GatedSurface(stub, policy, lease),
    lease,
    log: new EventSequencer({
      runId: "handoff-test",
      phase: "replay",
      now: () => "2026-09-12T12:00:00.000Z",
      controlOwner: () => lease.holder,
    }),
    now,
    advance: (ms: number) => {
      clock += ms;
    },
    peek: () => clock,
  };
};

interface Run {
  readonly s: Stack;
  readonly report: RunReport;
}

/**
 * One run through the REAL executor, with a scripted operator on the other end of
 * the transport. `makeTransport` receives the whole stack, so a "human" can drive
 * the same surface the run is using — which is the only thing that makes this a
 * test of control transfer rather than of a mock returning a string.
 */
const run = async (
  makeTransport: (s: Stack) => EscalationTransport | undefined,
  opts: {
    readonly ttlMs?: number;
    readonly deadline?: (ms: number) => Promise<void>;
    readonly budgets?: { readonly stepMs: number; readonly runMs: number };
    readonly withoutOrchestrator?: boolean;
  } = {},
): Promise<Run> => {
  const s = stack(AT_CARD_SERVICES);
  const transport = makeTransport(s);

  const escalate: Escalate = (draft) =>
    runEscalation(draft, {
      lease: s.lease,
      log: s.log,
      ttlMs: opts.ttlMs ?? 30_000,
      now: s.now,
      ...(transport === undefined ? {} : { transport }),
      ...(opts.deadline === undefined ? {} : { deadline: opts.deadline }),
    });

  const report = await runSteps(freeze, {}, {
    surface: s.gated,
    lease: s.lease,
    log: s.log,
    budgets: opts.budgets ?? { stepMs: 600, runMs: 60_000 },
    now: s.now,
    runId: "handoff-test",
    ...(opts.withoutOrchestrator === true ? {} : { escalate }),
  });

  return { s, report };
};

/** The scripted operator who actually performs the step in the live session. */
const performsTheStep = (s: Stack, seen: InterventionRequest[]): EscalationTransport => ({
  async raise(request) {
    seen.push(request);
    s.stub.current = AT_CONFIRMATION;
    return { kind: "resolved", operator: "op-7", note: "pressed FREEZE by hand" };
  },
});

const failed = (report: RunReport) => {
  if (report.outcome.kind !== "failed") throw new Error(`expected a failure, got ${report.outcome.kind}`);
  return report.outcome;
};

const handoffLines = (log: EventSequencer): readonly LogEvent[] => log.all.filter((e) => e.phase === "handoff");

describe("raising an intervention", () => {
  it("carries the goal, the step, the live state and why it stopped (§3.6-b)", async () => {
    const seen: InterventionRequest[] = [];
    const { s } = await run((st) => performsTheStep(st, seen));

    expect(seen).toHaveLength(1);
    const request = seen[0];

    // goal / capability
    expect(request?.capability).toEqual({ id: "msc.card.freeze", version: "1.0.0", goal: "Freeze the member's card and confirm it." });
    expect(request?.runId).toBe("handoff-test");
    // current step
    expect(request?.stepRef).toBe("s01");
    expect(request?.stepTitle).toBe("Press FREEZE on card services");
    expect(request?.action).toBe("click");
    // current state, perceived at raise time through the read paths the gate
    // deliberately leaves open during a handoff
    expect(request?.screen).toBe("CARD_SERVICES");
    expect(request?.location).toBe("http://localhost:7101/screen/card-services");
    expect(request?.observedText).toContain("CRD0500");
    // why it stopped: the policy's own reason and the rule that produced it
    expect(request?.effectiveRisk).toBe("irreversible");
    expect(request?.ruleId).toBe("risk.confirm:irreversible");
    expect(request?.reason).toContain("require a human decision");
    // and it is dated by the control journal, not by a second clock reading
    expect(request?.requestedAt).toBe(s.lease.transitions[0]?.at);
    expect(Date.parse(request?.deadlineAt ?? "")).toBe(Date.parse(request?.requestedAt ?? "") + 30_000);
  });

  it("attaches a screenshot masked AT CAPTURE TIME, fail-closed", async () => {
    const seen: InterventionRequest[] = [];
    const { s } = await run((st) => performsTheStep(st, seen));

    // The first production caller of screenshot() anywhere in the repo. The one
    // PII-bearing target is masked, and the driver was told to fail rather than
    // hand back an unmasked capture.
    expect(s.stub.shots).toHaveLength(1);
    expect(s.stub.shots[0]?.failClosed).toBe(true);
    expect(s.stub.shots[0]?.mask.map((t) => t.id)).toEqual(["FREEZE"]);
    expect(seen[0]?.screenshot?.maskedRegions).toBe(1);
  });
});

describe("while the human holds the session", () => {
  it("REFUSES an automation action, and nothing reaches the driver", async () => {
    let refusal: unknown = null;
    const attempts: string[] = [];

    const { s, report } = await run((st) => ({
      async raise() {
        // The run is blocked here; this is the window in which a stale or
        // confused caller could issue an action into the person's session.
        try {
          await st.gated.act(
            { kind: "click", target: freezeTarget },
            { stepRef: "s01", risk: "irreversible", actor: "automation", epoch: 0, url: AT_CARD_SERVICES.location, screen: "CARD_SERVICES" },
          );
          attempts.push("PERMITTED");
        } catch (e) {
          refusal = e;
          attempts.push("refused");
        }

        // Reads stay open, which is what lets the console show live state and the
        // run re-synchronise afterwards.
        const seenNow = await st.gated.observe();
        expect(seenNow.screen).toBe("CARD_SERVICES");

        st.stub.current = AT_CONFIRMATION;
        return { kind: "resolved", operator: "op-7" } satisfies HandoffOutcome;
      },
    }));

    expect(attempts).toEqual(["refused"]);
    expect(refusal).toBeInstanceOf(ControlViolation);
    // The assertion that matters: not that it threw, but that the target was
    // never touched. A gate that throws after acting is not a gate.
    expect(s.stub.acted).toHaveLength(0);
    expect(s.stub.reads).toContain("observe");
    expect(report.outcome.kind).toBe("completed");
  });
});

describe("handing control back", () => {
  it("RESOLVED: the human performed the step, so the run resumes and completes", async () => {
    const seen: InterventionRequest[] = [];
    const { s, report } = await run((st) => performsTheStep(st, seen));

    expect(report.outcome.kind).toBe("completed");
    // Both steps count: s01 because the person did it and its postcondition now
    // holds, s02 because automation walked it afterwards.
    expect(report.stepsCompleted).toBe(2);

    // Automation did NOT re-attempt the refused action — the policy would refuse
    // it identically, so a retry is a guaranteed infinite escalation.
    expect(s.stub.acted).toHaveLength(0);
    expect(s.log.all.map((e) => e.event)).toContain("step.resumed");
    expect(s.log.all.map((e) => e.event)).not.toContain("step.acted");

    expect(report.interventions).toHaveLength(1);
    expect(report.interventions[0]?.disposition).toBe("resolved");
    expect(report.interventions[0]?.operator).toBe("op-7");
    // What the human did is RECONSTRUCTED, and the two sources are labelled
    // differently: one is what they reported, the other is what was measured.
    expect(report.interventions[0]?.reconstructedActions).toEqual([
      "operator-reported: pressed FREEZE by hand",
      "observed after the turn: screen CARD_SERVICES -> CONFIRMATION, surface changed",
    ]);
  });

  it("RESOLVED but nothing changed: unresolved_after_handoff, not a false success", async () => {
    const { s, report } = await run(() => ({
      // The person says they did it and the surface says otherwise. The surface wins.
      async raise() {
        return { kind: "resolved", operator: "op-7", note: "I pressed it, honest" };
      },
    }));

    const outcome = failed(report);
    expect(outcome.failureKind).toBe("unresolved_after_handoff");
    expect(outcome.stepRef).toBe("s01");
    // s01 is irreversible, so "just try again" is the one answer that must not be
    // given: the human may have committed something this run cannot see.
    expect(outcome.remediation).toBe("reconcile_required");
    expect(outcome.sideEffectRisk).toBe("unknown");
    expect(outcome.observed).toContain("after the human turn");
    expect(report.interventions[0]?.reconstructedActions).toContain(
      "observed after the turn: no change to screen, location or content digest",
    );
    expect(s.stub.acted).toHaveLength(0);
  });

  it("ABORT: operator_abort, and the caller is told not to retry", async () => {
    const { report } = await run(() => ({
      async raise() {
        return { kind: "abort", operator: "op-9", note: "member is on the line, do not freeze" };
      },
    }));

    const outcome = failed(report);
    expect(outcome.failureKind).toBe("operator_abort");
    expect(outcome.remediation).toBe("do_not_retry");
    expect(report.interventions[0]?.disposition).toBe("abort");
    expect(report.interventions[0]?.operator).toBe("op-9");
  });

  it("TTL: escalation_timeout, expire() fires, and the journal says why", async () => {
    const { s, report } = await run(
      () => ({
        // Nobody ever answers.
        raise: () => new Promise<HandoffOutcome>(() => {}),
      }),
      // The deadline is injected, so this proves a timeout without waiting for one.
      { deadline: async () => {}, ttlMs: 30_000 },
    );

    const outcome = failed(report);
    expect(outcome.failureKind).toBe("escalation_timeout");
    // Nothing was committed: the action was refused before it ran, so the correct
    // move is to attach an operator and invoke again — the opposite of do_not_retry.
    expect(outcome.remediation).toBe("retry_safe");
    expect(report.interventions[0]?.disposition).toBe("timeout");
    expect(report.interventions[0]?.operator).toBeUndefined();

    // expire() is distinct from reclaim() precisely so this reason reaches the
    // audit of control. It had no caller anywhere in the repo until now.
    expect(s.lease.transitions.map((t) => t.reason)).toContain("escalation_timeout");
    expect(s.lease.holder).toBe("automation");
    expect(s.lease.epoch).toBe(2);
  });

  it("NO TRANSPORT ATTACHED is a normal case: cede, expire, and say so", async () => {
    const { s, report } = await run(() => undefined);

    expect(failed(report).failureKind).toBe("escalation_timeout");
    // It still ceded and still expired, so the epoch advanced and the journal
    // carries the whole turn. Declining to cede would record an intention nobody
    // can audit, and would leave a stale action issuable.
    expect(s.lease.epoch).toBe(2);
    expect(handoffLines(s.log)).toHaveLength(2);
  });

  it("NO ORCHESTRATOR AT ALL: still an escalation timeout, never policy_denied", async () => {
    const { s, report } = await run(() => undefined, { withoutOrchestrator: true });

    const outcome = failed(report);
    // THE CONFLATION THIS COMPONENT EXISTS TO END. This used to be
    // policy_denied / do_not_retry, which told a caller "forbidden, never retry"
    // when the truth was "a person could unblock this; nobody was reachable".
    expect(outcome.failureKind).toBe("escalation_timeout");
    expect(outcome.remediation).toBe("retry_safe");
    expect(outcome.observed).toContain("no operator channel is attached");
    // Nothing was ceded, because nothing could have been handed to anyone.
    expect(s.lease.transitions).toHaveLength(0);
  });
});

describe("the evidence of a control transfer", () => {
  it("emits handoff lines AT each transition, with control flipping automation -> human -> automation", async () => {
    const seen: InterventionRequest[] = [];
    const { s } = await run((st) => performsTheStep(st, seen));

    const lines = handoffLines(s.log);
    expect(lines.map((e) => e.event)).toEqual(["handoff.requested", "handoff.returned"]);
    expect(lines.every((e) => e.why.as === "operator")).toBe(true);

    // The flip, read across the three lines that describe the turn. This is only
    // correct because the lines are emitted AT the transition: the sequencer
    // stamps controlOwner per line from the live lease, so draining them
    // afterwards would stamp all three with the final holder.
    const turn = s.log.all.filter((e) => ["escalation.required", "handoff.requested", "handoff.returned"].includes(e.event));
    expect(turn.map((e) => `${e.event}:${e.controlOwner}`)).toEqual([
      "escalation.required:automation",
      "handoff.requested:human",
      "handoff.returned:automation",
    ]);

    // The `operator` arm is an ATTRIBUTION, and it names who and what.
    const returned = lines[1]?.why;
    expect(returned?.as === "operator" && returned.operator).toBe("op-7");
    expect(returned?.as === "operator" && returned.disposition).toBe("resolved");

    // Gapless across the whole run, handoff lines included — they live in the
    // escalating run's own log rather than in a run directory of their own.
    expect(s.log.isComplete()).toBe(true);
  });

  it("dates the record from the control journal, never from a second clock reading", async () => {
    const seen: InterventionRequest[] = [];
    const { s, report } = await run((st) => performsTheStep(st, seen));

    const record = report.interventions[0];
    expect(s.lease.transitions).toHaveLength(2);
    expect(record?.requestedAt).toBe(s.lease.transitions[0]?.at);
    expect(record?.resolvedAt).toBe(s.lease.transitions[1]?.at);
    // Two different instants, so this could not pass by both being the same
    // constant.
    expect(record?.requestedAt).not.toBe(record?.resolvedAt);
  });
});

describe("when the driver lock cannot be armed", () => {
  /**
   * THE UNGUARDED WINDOW, closed.
   *
   * `lease.cede()` runs before the driver lock is armed, so for as long as
   * arming sat OUTSIDE the try that restores control, a throw there escaped
   * `runEscalation` with the lease still on "human", no `handoff.returned` line,
   * and the emitted-versus-journalled reconciliation never reached — an audit of
   * control showing a cede with no matching return.
   *
   * Not a hypothetical failure to simulate: `beginHumanTurn()` awaits
   * `ensurePlumbing()`, and `exposeBinding`/`addInitScript` reject on a closed or
   * torn-down context. Against the real driver, closing the context and then
   * calling it throws `browserContext.exposeBinding: Target page, context or
   * browser has been closed`.
   *
   * What must survive is the property the catch block claims: the session never
   * stays stuck on a human who is not there.
   */
  it("RESTORES control and journals the failure instead of stranding the lease on the human", async () => {
    const s = stack(AT_CARD_SERVICES);
    const boom = new Error("browserContext.exposeBinding: Target page, context or browser has been closed");

    const draft = {
      runId: "arming-failure",
      capability: { id: "msc.card.freeze", version: "1.0.0", goal: "Freeze the member's card and confirm it." },
      stepRef: "s01",
      stepTitle: "Press FREEZE on card services",
      action: "click",
      effectiveRisk: "irreversible",
      reason: "irreversible actions require a human decision",
      ruleId: "risk.confirm:irreversible",
      screen: "CARD_SERVICES",
      location: AT_CARD_SERVICES.location,
      observedText: AT_CARD_SERVICES.text,
    };

    let endCalled = false;
    const raised = await runEscalation(draft, {
      lease: s.lease,
      log: s.log,
      ttlMs: 30_000,
      now: s.now,
      transport: { async raise() { throw new Error("the transport must never be reached"); } },
      session: {
        beginHumanTurn: () => Promise.reject(boom),
        endHumanTurn: async () => { endCalled = true; },
      },
    }).then(
      () => null,
      (e: unknown) => e,
    );

    // It still fails loudly — the caller is not told a turn happened.
    expect(raised).toBe(boom);

    // ...and control came BACK. This is the assertion that was false before.
    expect(s.lease.holder).toBe("automation");
    expect(s.lease.epoch).toBe(2);
    expect(s.lease.transitions.map((t) => `${t.from}->${t.to}`)).toEqual(["automation->human", "human->automation"]);
    expect(s.lease.transitions.at(-1)?.reason).toBe("escalation_timeout");

    // The journal is two-sided, and the closing line names what actually failed:
    // the lock would not arm, which is NOT a transport error.
    const lines = handoffLines(s.log);
    expect(lines.map((e) => e.event)).toEqual(["handoff.requested", "handoff.returned"]);
    const returned = lines[1]?.why;
    expect(returned?.as === "operator" && returned.disposition).toBe("arming_error");
    expect(lines[1]?.observed).toContain("has been closed");

    // The lock never armed, so there was nothing to clear; calling endHumanTurn
    // would be clearing a turn that never began.
    expect(endCalled).toBe(false);
  });
});

describe("the run budget", () => {
  it("does not charge the human's minutes to the run, and dies at the deadline it actually hit", async () => {
    const seen: InterventionRequest[] = [];
    // Ten minutes of human turn against a sixty-second run budget.
    const { s, report } = await run(
      (st) => ({
        async raise(request) {
          seen.push(request);
          st.advance(600_000);
          st.stub.current = AT_CONFIRMATION;
          return { kind: "resolved", operator: "op-7" };
        },
      }),
      { budgets: { stepMs: 600, runMs: 60_000 } },
    );

    // The run outlasted its wall-clock budget by an order of magnitude...
    expect(s.peek() - START_CLOCK).toBeGreaterThan(60_000);
    // ...and still completed, because the pause was not charged to it. Without
    // that subtraction this run dies `timeout` at s02 — reporting the deadline as
    // the cause when the actual cause was a handoff that worked.
    expect(report.outcome.kind).toBe("completed");
    expect(report.stepsCompleted).toBe(2);
  });
});

describe("what the calling agent gets back", () => {
  it("carries the intervention on the envelope and points at the handoff bundle", async () => {
    const s = stack(AT_CARD_SERVICES);
    const seen: InterventionRequest[] = [];

    const result = await replay(freeze, binding, {}, {
      surface: s.gated,
      lease: s.lease,
      log: s.log,
      runId: "handoff-envelope",
      budgets: { stepMs: 600, runMs: 60_000 },
      now: s.now,
      escalate: (draft) =>
        runEscalation(draft, { lease: s.lease, log: s.log, transport: performsTheStep(s, seen), ttlMs: 30_000, now: s.now }),
    });

    expect(result.status).toBe("success");
    // `interventions` was the literal `[]` on every envelope until now.
    expect(result.interventions).toHaveLength(1);
    expect(result.interventions[0]?.stepRef).toBe("s01");
    expect(result.interventions[0]?.requestedAt).toBe(s.lease.transitions[0]?.at);
    expect(result.interventions[0]?.resolvedAt).toBe(s.lease.transitions[1]?.at);
    expect(result.controlAtExit).toBe("automation");
    expect(result.modelCalls).toBe(0);

    if (result.status !== "success") return;
    // `Evidence.bundle` had zero producers repo-wide; a run with a human turn in
    // it is exactly the run where an expected/observed pair is not enough.
    expect(result.checkpoint[0]?.bundle).toBe("handoff.jsonl");
  });

  it("a run with no human turn points at no bundle", async () => {
    // The complement: the bundle must mean something happened, not be stamped on
    // every result.
    const s = stack(AT_CONFIRMATION);
    const result = await replay(freeze, binding, {}, {
      surface: s.gated,
      lease: s.lease,
      log: s.log,
      runId: "handoff-none",
      budgets: { stepMs: 600, runMs: 60_000 },
      now: s.now,
    });

    expect(result.interventions).toEqual([]);
    if (result.status === "failed") {
      expect(result.evidence.bundle).toBeUndefined();
      return;
    }
    if (result.status !== "success") return;
    expect(result.checkpoint[0]?.bundle).toBeUndefined();
  });
});
