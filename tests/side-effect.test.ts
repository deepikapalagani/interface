/**
 * SIDE-EFFECT HONESTY — what a FAILING run is allowed to claim it did not do.
 *
 * Three exits in `runSteps` used to answer "may I retry?" with the constant
 * `retry_safe` / `none`: the run-budget timeout, the capability checkpoint, and
 * the two non-resolving ends of a human turn. Every one of them was correct for
 * an accidental reason — the target app had no mutating route, so no replay
 * could commit anything, and "nothing was committed" was true by construction
 * rather than by reasoning. `POST /screen/card-action` ends that, and a constant
 * that was true for an accidental reason becomes a lie the day the reason goes.
 *
 * This is the §3.3 conflation the result contract exists to prevent, pointed at
 * the caller instead of at the app: telling an agent `retry_safe` after a card
 * has actually been frozen is an invitation to double-commit.
 *
 * EVERY CASE IS PROVEN BOTH WAYS, because a rule that fires on everything is as
 * broken as one that fires on nothing. Each pair runs THE SAME PLAN and THE SAME
 * script, differing only in the one fact that should decide the answer:
 *
 *   - the checkpoint and the budget pair on the acting step's declared RISK;
 *   - the two handoff exits pair on whether the surface MOVED across the turn,
 *     which is the only measurement available — automation cannot watch a
 *     person's hands, and the person was handed the session precisely because
 *     the step was too risky for automation to take.
 *
 * No browser, no mock server, no model, and no test waits in real time: the TTL
 * deadline and the run clock are both injected. The scripted surface is the
 * shape tests/handoff.test.ts already uses.
 */
import { describe, expect, it } from "vitest";
import { parseCapability, type Capability, type RiskClass, type TargetDescriptor } from "../src/capability/schema.js";
import { runEscalation, type Escalate, type EscalationTransport } from "../src/control/escalation.js";
import { ControlLease } from "../src/control/lease.js";
import { EventSequencer } from "../src/evidence/events.js";
import { PolicyDocument } from "../src/policy/policy.js";
import { runSteps, type RunReport } from "../src/replay/executor.js";
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
 * One plan, three risk settings, one knob on the checkpoint.
 *
 * A factory rather than three near-identical literals, so the paired tests below
 * cannot drift apart: if the two halves of a pair differed in any way other than
 * the fact under test, the pair would prove nothing about that fact.
 *
 * `s01` is the acting step whose risk decides everything. `s02` exists so the
 * plan has a SECOND STEP BOUNDARY, which is the only place the run-budget check
 * runs — it is evaluated at the top of each step, never mid-step.
 */
const capabilityWith = (risk: RiskClass, checkpointText: string) =>
  parseCapability({
    schemaVersion: 1,
    contract: {
      id: "msc.card.side_effect",
      version: "1.0.0",
      goal: "Apply a card action and confirm it.",
      purpose: "Fixture for side-effect reporting: the smallest plan with one acting step whose risk decides the answer.",
      inputs: [],
      outputs: [],
      outcomes: [],
      // Refinement 7 forbids understating risk, so the contract tracks the step.
      risk,
      requiresSession: false,
    },
    plan: {
      app: "MERIDIAN MSC",
      targets: [
        {
          id: "APPLY",
          screen: "CARD_SERVICES",
          framePath: [{ name: "content" }],
          strategies: [{ kind: "field_key", key: "APPLY", matchedAtRecord: 1 }],
          verify: {},
          nameMayContainPii: false,
          robustness: "Fixture target; resolution is stubbed by the scripted surface.",
        },
      ],
      steps: [
        {
          ref: "s01",
          title: "Apply the card action",
          action: "click",
          target: "APPLY",
          pre: { all: [{ atom: "screen", is: "CARD_SERVICES" }], any: [] },
          post: { all: [{ atom: "screen", is: "CONFIRMATION" }], any: [] },
          risk,
          approval: risk === "irreversible" ? "human_step_up" : "none",
        },
        {
          ref: "s02",
          title: "Confirm the card action was accepted",
          action: "assert",
          pre: { all: [{ atom: "screen", is: "CONFIRMATION" }], any: [] },
          post: { all: [{ atom: "text", contains: "CNF" }], any: [] },
          risk: "read_only",
          approval: "none",
        },
      ],
      recovery: [],
      checkpoint: { all: [{ atom: "text", contains: checkpointText }], any: [] },
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

/** Satisfied by the confirmation screen, so a run that gets there completes. */
const REACHABLE = "CNF";
/** Never on any screen this surface renders, so the checkpoint must fail. */
const UNREACHABLE = "SETTLEMENT BATCH POSTED";

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
  location: "http://localhost:7101/screen/cards",
  screen: "CARD_SERVICES",
  nodes: [],
  text: "CRD0500 CARD SERVICES — CARD 4021 — CARD STATUS ACTIVE",
  dialog: null,
  digest: "d-card-services",
};

/** What the surface reports once the action has actually been applied. */
const AT_CONFIRMATION: Observation = {
  location: "http://localhost:7101/screen/card-action",
  screen: "CONFIRMATION",
  nodes: [],
  text: "CNF9000 CARD STATUS CHANGE ACCEPTED — CARD 4021 — FROZEN — CNF4401",
  dialog: null,
  digest: "d-confirmation",
};

const resolution: Resolution = { strategyUsed: "field_key", strategyExpected: "field_key", matched: 1, degraded: false };

/** Records everything that reaches the driver, so "nothing happened" is checkable. */
class ScriptedSurface implements Surface {
  readonly acted: SurfaceAction[] = [];
  current: Observation;
  /** Fires AFTER an action lands, so a test can make acting cost wall time. */
  onActed: () => void = () => {};

  constructor(start: Observation) {
    this.current = start;
  }
  async observe(): Promise<Observation> {
    return this.current;
  }
  async find(_t: TargetDescriptor): Promise<Resolution | null> {
    return resolution;
  }
  async describe(_ref: string): Promise<null> {
    return null;
  }
  async read(_t: TargetDescriptor): Promise<string | null> {
    return null;
  }
  async act(action: SurfaceAction, _ctx: ActionContext): Promise<Resolution | null> {
    this.acted.push(action);
    this.current = AT_CONFIRMATION;
    this.onActed();
    return resolution;
  }
  onDialog(_h: (m: string) => void): void {}
  async screenshot(_options: ScreenshotOptions): Promise<Uint8Array> {
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
  /** Simulate wall time passing — during a human turn, or during an action. */
  readonly advance: (ms: number) => void;
}

const stack = (start: Observation): Stack => {
  // Advances on every read: settle's budget is measured with this clock, so a
  // never-matching checkpoint has to terminate rather than poll forever.
  let clock = 1_000;
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
      runId: "side-effect-test",
      phase: "replay",
      now: () => "2026-09-12T12:00:00.000Z",
      controlOwner: () => lease.holder,
    }),
    now,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

interface Run {
  readonly s: Stack;
  readonly report: RunReport;
}

const run = async (
  risk: RiskClass,
  opts: {
    readonly checkpointText?: string;
    readonly runMs?: number;
    readonly transport?: (s: Stack) => EscalationTransport;
    readonly onActed?: (s: Stack) => void;
    /** A different plan shape, for the pair that needs a `read` as its second step. */
    readonly build?: (risk: RiskClass) => Capability;
  } = {},
): Promise<Run> => {
  const s = stack(AT_CARD_SERVICES);
  if (opts.onActed) {
    const hook = opts.onActed;
    s.stub.onActed = () => hook(s);
  }

  const transport = opts.transport?.(s);
  const escalate: Escalate = (draft) =>
    runEscalation(draft, {
      lease: s.lease,
      log: s.log,
      ttlMs: 30_000,
      now: s.now,
      // Injected, so a TTL is proven without waiting for one.
      deadline: async () => {},
      ...(transport === undefined ? {} : { transport }),
    });

  const capability = opts.build ? opts.build(risk) : capabilityWith(risk, opts.checkpointText ?? REACHABLE);

  const report = await runSteps(capability, {}, {
    surface: s.gated,
    lease: s.lease,
    log: s.log,
    budgets: { stepMs: 600, runMs: opts.runMs ?? 60_000 },
    now: s.now,
    runId: "side-effect-test",
    escalate,
  });

  return { s, report };
};

const failed = (report: RunReport) => {
  if (report.outcome.kind !== "failed") throw new Error(`expected a failure, got ${report.outcome.kind}`);
  return report.outcome;
};

describe("the capability checkpoint fails", () => {
  it("READ-ONLY plan: nothing could have been committed, so retrying is safe", async () => {
    const { s, report } = await run("read_only", { checkpointText: UNREACHABLE });

    const outcome = failed(report);
    expect(outcome.failureKind).toBe("checkpoint_failed");
    // Both steps passed their own postconditions — only the capability-level
    // claim failed. That is the whole point of asserting the checkpoint.
    expect(report.stepsCompleted).toBe(2);
    expect(s.stub.acted).toHaveLength(1);

    expect(outcome.remediation).toBe("retry_safe");
    expect(outcome.sideEffectRisk).toBe("none");
  });

  it("ONE REVERSIBLE acting step: the same failure must NOT invite a double-commit", async () => {
    const { s, report } = await run("reversible", { checkpointText: UNREACHABLE });

    const outcome = failed(report);
    // Identical plan, identical script, identical failure kind...
    expect(outcome.failureKind).toBe("checkpoint_failed");
    expect(report.stepsCompleted).toBe(2);
    expect(s.stub.acted).toHaveLength(1);

    // ...and the opposite answer, because the action landed. This site never
    // consulted risk at all: it told the caller to re-invoke a capability that
    // had already changed the card.
    expect(outcome.remediation).toBe("reconcile_required");
    expect(outcome.sideEffectRisk).toBe("unknown");
  });
});

describe("the run budget expires between steps", () => {
  // Acting costs ten minutes of wall clock against a sixty-second budget, so the
  // deadline is hit at s02's boundary — after s01 has already landed.
  const burnTheBudget = (s: Stack): void => s.advance(600_000);

  it("READ-ONLY plan: retry_safe, and the deadline is the only thing that went wrong", async () => {
    const { report } = await run("read_only", { runMs: 60_000, onActed: burnTheBudget });

    const outcome = failed(report);
    expect(outcome.failureKind).toBe("timeout");
    expect(outcome.stepRef).toBe("s02");
    expect(report.stepsCompleted).toBe(1);

    expect(outcome.remediation).toBe("retry_safe");
    expect(outcome.sideEffectRisk).toBe("none");
  });

  it("after a REVERSIBLE step landed: a deadline says nothing about what already committed", async () => {
    const { report } = await run("reversible", { runMs: 60_000, onActed: burnTheBudget });

    const outcome = failed(report);
    expect(outcome.failureKind).toBe("timeout");
    expect(outcome.stepRef).toBe("s02");
    expect(report.stepsCompleted).toBe(1);

    expect(outcome.remediation).toBe("reconcile_required");
    expect(outcome.sideEffectRisk).toBe("unknown");
  });
});

/**
 * The handoff pair runs the IRREVERSIBLE plan, so the shipped risk policy rates
 * s01 `confirm` and the gate refuses it with `requires: human` — the only
 * production trigger for a handoff. Automation therefore issues NOTHING on
 * either side of this pair, which is what makes `moved` the deciding fact rather
 * than a second-order effect of the run's own actions.
 */
describe("the human turn ends without resolving", () => {
  const untouched = (): EscalationTransport => ({
    async raise() {
      return { kind: "abort", operator: "op-9", note: "member is on the line, do not freeze" };
    },
  });

  const movedIt = (s: Stack): EscalationTransport => ({
    async raise() {
      // The person did something in the live session. Automation cannot see WHAT
      // — only that the surface is no longer where it was left.
      s.stub.current = AT_CONFIRMATION;
      return { kind: "abort", operator: "op-9", note: "took a look and stopped" };
    },
  });

  const neverAnswers = (): EscalationTransport => ({
    raise: () => new Promise(() => {}),
  });

  const movedItThenNeverAnswers = (s: Stack): EscalationTransport => ({
    raise: () => {
      s.stub.current = AT_CONFIRMATION;
      return new Promise(() => {});
    },
  });

  it("ABORT on an UNTOUCHED session: do_not_retry, and nothing was disturbed", async () => {
    const { s, report } = await run("irreversible", { transport: untouched });

    const outcome = failed(report);
    expect(outcome.failureKind).toBe("operator_abort");
    // The action was refused BEFORE it ran, so the run itself committed nothing.
    expect(s.stub.acted).toHaveLength(0);

    expect(outcome.remediation).toBe("do_not_retry");
    expect(outcome.sideEffectRisk).toBe("none");
  });

  it("ABORT after the session MOVED: still do_not_retry, but it can no longer claim `none`", async () => {
    const { s, report } = await run("irreversible", { transport: movedIt });

    const outcome = failed(report);
    expect(outcome.failureKind).toBe("operator_abort");
    expect(s.stub.acted).toHaveLength(0);

    // The operator said stop, so no automatic retry may overrule that — but the
    // surface moved under a person's hands, and reporting `none` there would be
    // the system asserting something it cannot possibly know.
    expect(outcome.remediation).toBe("do_not_retry");
    expect(outcome.sideEffectRisk).toBe("unknown");

    // The measurement the answer is derived from reaches the record too.
    expect(report.interventions[0]?.reconstructedActions).toContain(
      "observed after the turn: screen CARD_SERVICES -> CONFIRMATION, surface changed",
    );
  });

  it("TIMEOUT on an UNTOUCHED session: retry_safe — attach an operator and invoke again", async () => {
    const { s, report } = await run("irreversible", { transport: neverAnswers });

    const outcome = failed(report);
    expect(outcome.failureKind).toBe("escalation_timeout");
    expect(s.stub.acted).toHaveLength(0);

    expect(outcome.remediation).toBe("retry_safe");
    expect(outcome.sideEffectRisk).toBe("none");
    expect(report.interventions[0]?.reconstructedActions).toContain(
      "observed after the turn: no change to screen, location or content digest",
    );
  });

  it("TIMEOUT after the session MOVED: reconcile first — somebody was in there", async () => {
    const { s, report } = await run("irreversible", { transport: movedItThenNeverAnswers });

    const outcome = failed(report);
    // Nobody handed back, so this is still an escalation timeout...
    expect(outcome.failureKind).toBe("escalation_timeout");
    expect(s.stub.acted).toHaveLength(0);

    // ...but "nobody answered" and "nobody touched it" are different claims, and
    // only the second one licenses a retry. Somebody opened the session, changed
    // the screen, and walked away without handing back.
    expect(outcome.remediation).toBe("reconcile_required");
    expect(outcome.sideEffectRisk).toBe("unknown");
  });
});

/**
 * THE SHAPE THE FLAGSHIP ACTUALLY HAS, which is why this pair exists.
 *
 * `msc.card.set_status@1.0.0` ends `s07` click (reversible — the submit that
 * freezes the card) followed by `s08` read (the confirmation number the contract
 * declares as its output). The read issues no action and commits nothing ITSELF,
 * which is why this exit reported `retry_safe` / `none` — a per-STEP answer to a
 * question the caller asks about the RUN.
 *
 * So a card that was genuinely frozen, whose confirmation cell then could not be
 * read, told the calling agent to invoke the capability again. The step's own
 * innocence is real and irrelevant.
 *
 * `ScriptedSurface.read()` returns null unconditionally, so the second step here
 * reaches that exit on both halves of the pair.
 */
const readPlanWith = (risk: RiskClass): Capability =>
  parseCapability({
    schemaVersion: 1,
    contract: {
      id: "msc.card.side_effect_read",
      version: "1.0.0",
      goal: "Apply a card action, then read back the confirmation it issued.",
      purpose: "Fixture for the flagship's own shape: an acting step followed by a read that yields nothing.",
      inputs: [],
      outputs: [],
      outcomes: [],
      risk,
      requiresSession: false,
    },
    plan: {
      app: "MERIDIAN MSC",
      targets: [
        {
          id: "APPLY",
          screen: "CARD_SERVICES",
          framePath: [{ name: "content" }],
          strategies: [{ kind: "field_key", key: "APPLY", matchedAtRecord: 1 }],
          verify: {},
          nameMayContainPii: false,
          robustness: "Fixture target; resolution is stubbed by the scripted surface.",
        },
        {
          id: "CONFIRMATION_NUMBER",
          screen: "CONFIRMATION",
          framePath: [{ name: "content" }],
          strategies: [{ kind: "table_anchor", key: "CONFIRMATION", matchedAtRecord: 1 }],
          verify: {},
          nameMayContainPii: false,
          robustness: "Fixture target; the scripted surface reads null from it on purpose.",
        },
      ],
      steps: [
        {
          ref: "s01",
          title: "Apply the card action",
          action: "click",
          target: "APPLY",
          pre: { all: [{ atom: "screen", is: "CARD_SERVICES" }], any: [] },
          post: { all: [{ atom: "screen", is: "CONFIRMATION" }], any: [] },
          risk,
          approval: risk === "irreversible" ? "human_step_up" : "none",
        },
        {
          ref: "s02",
          title: "Read the confirmation number",
          action: "read",
          target: "CONFIRMATION_NUMBER",
          pre: { all: [{ atom: "screen", is: "CONFIRMATION" }], any: [] },
          post: { all: [{ atom: "text", contains: "CNF" }], any: [] },
          risk: "read_only",
          approval: "none",
        },
      ],
      recovery: [],
      checkpoint: { all: [{ atom: "text", contains: REACHABLE }], any: [] },
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

describe("a declared output cannot be read back", () => {
  it("READ-ONLY plan: the read yielded nothing and nothing had committed, so retrying is safe", async () => {
    const { s, report } = await run("read_only", { build: readPlanWith });

    const outcome = failed(report);
    expect(outcome.failureKind).toBe("postcondition_failed");
    expect(outcome.stepRef).toBe("s02");
    expect(outcome.observed).toBe("nothing readable");
    // s01 still acted; it simply could not have committed anything.
    expect(s.stub.acted).toHaveLength(1);

    expect(outcome.remediation).toBe("retry_safe");
    expect(outcome.sideEffectRisk).toBe("none");
  });

  it("after a REVERSIBLE step landed: the read's own innocence does not make the run retryable", async () => {
    const { s, report } = await run("reversible", { build: readPlanWith });

    const outcome = failed(report);
    // Identical plan, identical script, identical failure kind and same step...
    expect(outcome.failureKind).toBe("postcondition_failed");
    expect(outcome.stepRef).toBe("s02");
    expect(outcome.observed).toBe("nothing readable");
    expect(s.stub.acted).toHaveLength(1);

    // ...and the opposite answer. This is the flagship's exact shape: the card is
    // frozen, the confirmation could not be read, and telling the caller to run it
    // again is an invitation to freeze it twice.
    expect(outcome.remediation).toBe("reconcile_required");
    expect(outcome.sideEffectRisk).toBe("unknown");
  });
});
