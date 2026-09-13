/**
 * A BUSINESS OUTCOME MUST BE AUDITABLE FROM THE LOG, NOT ONLY FROM THE RESULT.
 *
 * classify.test.ts proves the three classes separate correctly. This proves the
 * separation is *recorded*: §3.5 asks for what the agent did and why, and
 * events.ts calls the `outcome_signal` arm "how a business-outcome
 * classification becomes auditable rather than asserted". A reviewer reading
 * `/evidence/` must be able to see which declared signal ended the run.
 *
 * THE REGRESSION THIS EXISTS FOR. The executor had two business-outcome exits,
 * at a step's precondition and at its postcondition, and only the first emitted
 * the citation. Measured against the mock: a MEMBER_NOT_FOUND replay of
 * lookup@1.0.0 produced an events.jsonl of two `step.acted` lines and zero
 * outcome events, because on that capability the not-found is detected in s02's
 * postcondition settle. The returned result was correct the whole time, which is
 * exactly why nothing caught it — so the assertions below are on the LOG.
 *
 * No browser and no mock server: a scripted surface is enough to reach both
 * exits, and it can reach them in the same millisecond, which the real ones
 * cannot.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseCapability } from "../src/capability/schema.js";
import { ControlLease } from "../src/control/lease.js";
import { EventSequencer, type LogEvent } from "../src/evidence/events.js";
import { runSteps, type RunReport } from "../src/replay/executor.js";
import type { Observation, Resolution, Surface, SurfaceAction } from "../src/surface/types.js";

/**
 * One click step whose postcondition and whose declared outcome can both be
 * satisfied by the screen the click lands on — which is what lets one fixture
 * drive every exit by varying only the observation.
 */
const lookup = parseCapability({
  schemaVersion: 1,
  contract: {
    id: "msc.member.lookup",
    version: "1.0.0",
    goal: "Look up a member by id and reach the results screen.",
    purpose: "Fixture for the business-outcome citation; the smallest plan that reaches both exits.",
    inputs: [],
    outputs: [],
    outcomes: [
      {
        code: "MEMBER_NOT_FOUND",
        message: "No member matches that id.",
        when: { all: [{ atom: "text", contains: "MSG 0071" }], any: [] },
        source: "app_profile",
        note: "The app's own empty-result message. A legitimate answer, not a failure.",
      },
    ],
    risk: "read_only",
    requiresSession: false,
  },
  plan: {
    app: "MERIDIAN MSC",
    targets: [
      {
        id: "SUBMIT",
        screen: "MEMBER_SEARCH",
        framePath: [{ name: "content" }],
        strategies: [{ kind: "field_key", key: "SUBMIT", matchedAtRecord: 1 }],
        verify: {},
        nameMayContainPii: false,
        robustness: "Fixture target; resolution is stubbed by the scripted surface.",
      },
    ],
    steps: [
      {
        ref: "s01",
        title: "Submit the search",
        action: "click",
        target: "SUBMIT",
        pre: { all: [{ atom: "screen", is: "MEMBER_SEARCH" }], any: [] },
        post: { all: [{ atom: "screen", is: "MEMBER_RESULTS" }], any: [] },
        risk: "read_only",
        approval: "none",
      },
    ],
    recovery: [],
    checkpoint: { all: [{ atom: "screen", is: "MEMBER_RESULTS" }], any: [] },
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

const view = (over: Partial<Observation> = {}): Observation => ({
  location: "http://localhost:7101/screen/search",
  screen: "MEMBER_SEARCH",
  nodes: [],
  text: "MBR0300 MEMBER INQUIRY",
  dialog: null,
  digest: "d-search",
  ...over,
});

/** The app's own not-found render: satisfies the declared outcome AND the postcondition. */
const NOT_FOUND = view({
  location: "http://localhost:7101/screen/results",
  screen: "MEMBER_RESULTS",
  text: "MBR0310 RESULTS — NO RECORDS MATCH SELECTION — MSG 0071",
  digest: "d-notfound",
});

const ONE_MATCH = view({
  location: "http://localhost:7101/screen/results",
  screen: "MEMBER_RESULTS",
  text: "MBR0310 RESULTS — 1 RECORD SELECTED",
  digest: "d-hit",
});

const resolved: Resolution = { strategyUsed: "field_key", strategyExpected: "field_key", matched: 1, degraded: false };

/**
 * Perception is a single observation that the action swaps. Everything settle
 * races matches on its first poll, so no test here touches a timer.
 */
class ScriptedSurface implements Surface {
  readonly acted: SurfaceAction[] = [];
  constructor(
    private current: Observation,
    private readonly afterAct: Observation,
  ) {}
  async observe(): Promise<Observation> {
    return this.current;
  }
  async find(): Promise<Resolution | null> {
    return resolved;
  }
  async describe(): Promise<null> {
    return null;
  }
  async read(): Promise<string | null> {
    return null;
  }
  async act(action: SurfaceAction): Promise<Resolution | null> {
    this.acted.push(action);
    this.current = this.afterAct;
    return resolved;
  }
  onDialog(): void {}
  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async close(): Promise<void> {}
}

const run = async (
  start: Observation,
  afterAct: Observation,
): Promise<{ report: RunReport; events: readonly LogEvent[]; surface: ScriptedSurface }> => {
  const surface = new ScriptedSurface(start, afterAct);
  const lease = new ControlLease(() => "2026-09-12T00:00:00Z");
  const log = new EventSequencer({
    runId: "outcome-signal",
    phase: "replay",
    now: () => "2026-09-12T00:00:00Z",
    controlOwner: () => lease.holder,
  });

  const report = await runSteps(lookup, {}, { surface, lease, log, budgets: { stepMs: 1000, runMs: 5000 }, now: () => Date.now() });
  return { report, events: log.all, surface };
};

const citations = (events: readonly LogEvent[]): readonly LogEvent[] => events.filter((e) => e.why.as === "outcome_signal");

describe("a business outcome cites the signal that produced it", () => {
  it("THE REGRESSION: the POSTCONDITION exit emits the citation", async () => {
    // The path every recorded search-then-read capability actually takes: the
    // step acts, and the not-found arrives in the postcondition settle.
    const { report, events, surface } = await run(view(), NOT_FOUND);

    expect(report.outcome.kind).toBe("business_outcome");
    expect(surface.acted).toHaveLength(1); // the step really did run first

    const cited = citations(events);
    expect(cited).toHaveLength(1);
    const why = cited[0]?.why;
    expect(why?.as === "outcome_signal" && why.code).toBe("MEMBER_NOT_FOUND");
    expect(cited[0]?.event).toBe("outcome.matched");
    expect(cited[0]?.stepRef).toBe("s01");

    // Before the fix this log was `["step.acted"]` and nothing else.
    expect(events.map((e) => e.event)).toEqual(["step.acted", "outcome.matched"]);
  });

  it("the PRECONDITION exit emits the same citation", async () => {
    // The outcome is already on screen when the step is evaluated, so the run
    // ends without acting at all — and must still say why.
    const { report, events, surface } = await run(NOT_FOUND, NOT_FOUND);

    expect(report.outcome.kind).toBe("business_outcome");
    expect(surface.acted).toHaveLength(0);
    expect(citations(events)).toHaveLength(1);
    expect(events.map((e) => e.event)).toEqual(["outcome.matched"]);
  });

  it("the log and the returned result cannot disagree about which outcome it was", async () => {
    const { report, events } = await run(view(), NOT_FOUND);
    if (report.outcome.kind !== "business_outcome") throw new Error("expected a business outcome");

    const why = citations(events)[0]?.why;
    if (why?.as !== "outcome_signal") throw new Error("expected an outcome_signal citation");
    expect(why.code).toBe(report.outcome.code);
    // The citation carries the matched signal itself, so the classification is
    // checkable against the artifact rather than taken on trust.
    expect(why.matched).toBe(report.outcome.matchedSignal);
    expect(why.matched).toContain("MSG 0071");
  });

  it("a run that reaches its checkpoint emits NO outcome signal", async () => {
    // The complement: the citation must mean something happened, not be stamped
    // on every terminal path.
    const { report, events } = await run(view(), ONE_MATCH);

    expect(report.outcome.kind).toBe("completed");
    expect(citations(events)).toHaveLength(0);
  });

  it("a business outcome recognised at the CAPABILITY CHECKPOINT still cites its signal", async () => {
    // The checkpoint used to race one expectation and never call classify(), so a
    // declared outcome visible only at that last observation point came back as
    // `checkpoint_failed` — the §3.3 conflation arriving at the final moment. It
    // is routed through the same helper now, which is why the citation exists.
    const { report, events } = await run(view(), view({ screen: "MEMBER_RESULTS", text: "MBR0310 — NO RECORDS MATCH SELECTION — MSG 0071" }));

    expect(report.outcome.kind).toBe("business_outcome");
    expect(citations(events)).toHaveLength(1);
  });

  it("SOURCE INVARIANT: there is exactly one business-outcome exit to forget", async () => {
    // The defect was structural, not behavioural — a second return path that
    // skipped the emit. Two exits existed; two could exist again. This pins the
    // property the fix relies on: every business outcome leaves through the one
    // helper that logs, so a new detection site cannot silently reintroduce a
    // classification with no evidence behind it.
    const source = readFileSync(fileURLToPath(new URL("../src/replay/executor.ts", import.meta.url)), "utf8");
    const constructed = source.match(/report\(\{\s*kind:\s*"business_outcome"/g) ?? [];
    expect(constructed).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------- */

/**
 * THE RECOVERABLE CLASS, AT A STEP'S POSTCONDITION.
 *
 * §3.3 names three result classes and requires them kept distinct. The
 * recoverable one was implemented at ONE of the three points it can be observed:
 * `plan.recovery[]` was applied in the precondition loop only. At a
 * postcondition the identical `recoverable` classification fell straight to
 * `fail(..., "postcondition_failed")` — no rule applied, no dismiss issued,
 * nothing logged, `recoveries: []`.
 *
 * That is not a corner. The shipped `broadcast` fault queues its alert on the
 * CARD SERVICES render, which the flagship plan reaches by CLICKING — so it
 * lands on exactly this path, while the fault catalogue, the README and the
 * mock's own seed all promised the declared rule would clear it.
 *
 * A scripted surface rather than the mock, deliberately: a queued native dialog
 * blocks every page-touching call for ~30s against a real browser, so the real
 * thing is minutes of suite time spent pinning a driver timeout. Everything that
 * decides the outcome — classify's precedence, the recovery loop, the shared
 * attempt budget — is the production code.
 */
const recoveryCapability = (maxAttempts: number) =>
  parseCapability({
    schemaVersion: 1,
    contract: {
      id: "msc.member.recoverable",
      version: "1.0.0",
      goal: "Submit a search and reach the results screen through a known interstitial.",
      purpose: "Fixture for the recoverable class at a postcondition — the smallest plan that reaches it.",
      inputs: [],
      outputs: [],
      outcomes: [],
      risk: "read_only",
      requiresSession: false,
    },
    plan: {
      app: "MERIDIAN MSC",
      targets: [
        {
          id: "SUBMIT",
          screen: "MEMBER_SEARCH",
          framePath: [{ name: "content" }],
          strategies: [{ kind: "field_key", key: "SUBMIT", matchedAtRecord: 1 }],
          verify: {},
          nameMayContainPii: false,
          robustness: "Fixture target; resolution is stubbed by the scripted surface.",
        },
      ],
      steps: [
        {
          ref: "s01",
          title: "Submit the search",
          action: "click",
          target: "SUBMIT",
          pre: { all: [{ atom: "screen", is: "MEMBER_SEARCH" }], any: [] },
          post: { all: [{ atom: "screen", is: "MEMBER_RESULTS" }], any: [] },
          risk: "read_only",
          approval: "none",
        },
      ],
      recovery: [
        {
          id: "dismiss-broadcast",
          when: { atom: "dialog", messageContains: "SYSTEM BROADCAST" },
          do: "dismiss_dialog",
          maxAttempts,
          note: "A known nightly interstitial; dismissing it changes no member state.",
        },
      ],
      checkpoint: { all: [{ atom: "screen", is: "MEMBER_RESULTS" }], any: [] },
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

/** Like `ScriptedSurface`, but the dialog is a thing the run can actually clear. */
class RecoverySurface implements Surface {
  readonly acted: SurfaceAction[] = [];
  constructor(
    private current: Observation,
    private readonly afterAct: Observation,
    private readonly clearsOnDismiss: boolean,
  ) {}
  async observe(): Promise<Observation> {
    return this.current;
  }
  async find(): Promise<Resolution | null> {
    return resolved;
  }
  async describe(): Promise<null> {
    return null;
  }
  async read(): Promise<string | null> {
    return null;
  }
  async act(action: SurfaceAction): Promise<Resolution | null> {
    this.acted.push(action);
    if (action.kind === "dismiss_dialog") {
      if (this.clearsOnDismiss) this.current = { ...this.current, dialog: null };
      return null;
    }
    this.current = this.afterAct;
    return resolved;
  }
  onDialog(): void {}
  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async close(): Promise<void> {}
}

const runRecovery = async (
  afterAct: Observation,
  opts: { clearsOnDismiss: boolean; maxAttempts: number },
): Promise<{ report: RunReport; events: readonly LogEvent[]; surface: RecoverySurface }> => {
  const surface = new RecoverySurface(view(), afterAct, opts.clearsOnDismiss);
  const lease = new ControlLease(() => "2026-09-12T00:00:00Z");
  const log = new EventSequencer({
    runId: "recovery",
    phase: "replay",
    now: () => "2026-09-12T00:00:00Z",
    controlOwner: () => lease.holder,
  });
  const report = await runSteps(recoveryCapability(opts.maxAttempts), {}, {
    surface,
    lease,
    log,
    budgets: { stepMs: 1000, runMs: 5000 },
    now: () => Date.now(),
  });
  return { report, events: log.all, surface };
};

const BROADCAST = { message: "SYSTEM BROADCAST: NIGHTLY MAINTENANCE 22:00" };

describe("a declared recovery rule fires at a step's POSTCONDITION", () => {
  it("THE HEADLINE: the rule clears the dialog and the run continues to its checkpoint", async () => {
    // The dialog arrives on the screen the click lands on, which is where the
    // shipped `broadcast` fault puts it.
    const { report, events, surface } = await runRecovery(
      view({ screen: "MEMBER_RESULTS", text: "MBR0310 RESULTS", dialog: BROADCAST }),
      { clearsOnDismiss: true, maxAttempts: 1 },
    );

    // Before the fix this was `failed` / postcondition_failed with recoveries: [].
    expect(report.outcome.kind).toBe("completed");
    expect(report.stepsCompleted).toBe(1);

    // The rule was APPLIED, not merely matched: a dismiss reached the surface.
    expect(surface.acted.map((a) => a.kind)).toEqual(["click", "dismiss_dialog"]);
    expect(report.recoveries).toHaveLength(1);
    expect(report.recoveries[0]?.ruleId).toBe("dismiss-broadcast");
    expect(report.recoveries[0]?.stepRef).toBe("s01");
    expect(report.recoveries[0]?.attempts).toBe(1);

    // And it is auditable, which is the other half of §3.5: the citation names
    // the declared rule that fired.
    const applied = events.find((e) => e.event === "recovery.applied");
    expect(applied?.why.as === "handler" && applied.why.ruleId).toBe("dismiss-broadcast");
  });

  it("fires even when the postcondition ALREADY HOLDS underneath the dialog", async () => {
    // This is the case classify()'s precedence exists for and the old code got
    // backwards. The postcondition (`screen MEMBER_RESULTS`) is satisfied by the
    // very observation carrying the dialog — so the old arm reported
    // `postcondition_failed` for a step that had in fact succeeded, and the
    // obstruction it knew how to clear stayed on the screen.
    const { report, surface } = await runRecovery(
      view({ screen: "MEMBER_RESULTS", text: "MBR0310 RESULTS", dialog: BROADCAST }),
      { clearsOnDismiss: true, maxAttempts: 1 },
    );

    expect(report.outcome.kind).toBe("completed");
    expect(surface.acted.map((a) => a.kind)).toContain("dismiss_dialog");
  });

  it("stays bounded by maxAttempts, and then reports the STEP's expectation — not the rule's", async () => {
    // The dialog never clears, so the rule is spent after one attempt.
    const { report, surface } = await runRecovery(
      view({ screen: "MEMBER_SEARCH", text: "MBR0300 SEARCH", dialog: BROADCAST }),
      { clearsOnDismiss: false, maxAttempts: 1 },
    );

    if (report.outcome.kind !== "failed") throw new Error(`expected a failure, got ${report.outcome.kind}`);

    // Bounded: one dismiss, not an unbounded loop.
    expect(surface.acted.filter((a) => a.kind === "dismiss_dialog")).toHaveLength(1);
    expect(report.recoveries).toHaveLength(1);

    // THE §3.3-g REGRESSION. `expected` used to carry the RECOVERY RULE's own
    // predicate — `dialog contains "SYSTEM BROADCAST"` — so the failure named a
    // condition the step had never asked for. It must name what the STEP wanted.
    expect(report.outcome.expected).toContain("screen MEMBER_RESULTS");
    expect(report.outcome.expected).not.toContain("SYSTEM BROADCAST");

    // And `observed` says the rule was declared and exhausted, rather than
    // calling a dialog the artifact anticipated "undeclared".
    expect(report.outcome.observed).toContain("DECLARED dialog is still blocking");
    expect(report.outcome.observed).toContain("dismiss-broadcast");
    expect(report.outcome.failureKind).toBe("postcondition_failed");
  });
});
