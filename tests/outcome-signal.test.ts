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
