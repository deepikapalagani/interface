/**
 * THE EVENT LOG — two properties, both load-bearing for claims made elsewhere.
 *
 * 1. GAPLESSNESS. §3.5 asks for a structured log of what the agent did and why.
 *    A log you cannot prove is complete is weak evidence: if a line can go
 *    missing silently, then "the agent never did X" and "the record of X was
 *    lost" are indistinguishable. Sequence numbers make that detectable.
 *
 * 2. THE DIFF PROJECTION. "Replay is deterministic" is only checkable if two
 *    runs can be compared. Timestamps and run ids vary between runs by
 *    definition; nothing else may. The projection drops exactly those two and
 *    keeps everything else, so a diff that shows anything at all is a real
 *    divergence rather than noise.
 */
import { describe, expect, it } from "vitest";
import { EventSequencer, type LogContext, type Why } from "../src/evidence/events.js";
import type { ControlOwner } from "../src/contract/result.js";

const makeCtx = (over: Partial<LogContext> = {}): LogContext => ({
  runId: "run-01",
  phase: "replay",
  now: () => "2026-03-02T14:05:00Z",
  controlOwner: () => "automation" as ControlOwner,
  ...over,
});

const step: Why = { as: "artifact_step", capability: "msc.card.set_status", version: "1.0.0", stepRef: "s04" };

describe("event log", () => {
  it("numbers every line gaplessly, so a missing line is detectable", () => {
    const log = new EventSequencer(makeCtx());
    log.emit("step.acted", step, { stepRef: "s01" });
    log.emit("step.acted", step, { stepRef: "s02" });
    log.emit("step.acted", step, { stepRef: "s03" });

    expect(log.all.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(log.isComplete()).toBe(true);
  });

  it("records who held control on EVERY line, and lets ONE line be a handoff", () => {
    let owner: ControlOwner = "automation";
    const log = new EventSequencer(makeCtx({ controlOwner: () => owner }));

    const before = log.emit("step.acted", step, { stepRef: "s03" });
    owner = "human"; // escalation: the person takes the session
    const transfer = log.emit(
      "operator.acted",
      { as: "operator", operator: "sup-014", disposition: "resolved" },
      { phase: "handoff", stepRef: "s04" },
    );
    owner = "automation"; // handed back
    const after = log.emit("step.acted", step, { stepRef: "s04" });

    // This is what makes §3.6-d's "record what the human did" a property of the
    // log's shape rather than a separate mechanism bolted on.
    expect(log.all.map((e) => e.controlOwner)).toEqual(["automation", "human", "automation"]);

    // The phase override is per-LINE. The run is a replay run throughout; only
    // the line describing the control transfer is a handoff. Before the
    // override, `phase` came solely from `LogContext` and was fixed for the life
    // of the sequencer, so this line was error TS2353 — the envelope declared a
    // `handoff` phase that no writer could produce.
    expect([before.phase, transfer.phase, after.phase]).toEqual(["replay", "handoff", "replay"]);

    // And it does not cost gaplessness. A second sequencer — the obvious
    // alternative — restarts `seq` at 1, which verify-evidence reads as a gap or
    // a duplicate in the single events.jsonl the two would both append to.
    expect(log.all.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(log.isComplete()).toBe(true);

    // The override writes a different VALUE into a field every line already had;
    // it adds no FIELD. So the determinism projection is untouched and still
    // drops exactly `at` and `runId`. verify-determinism drives this same class
    // and exits "PROJECTION UNSOUND" otherwise, so pinning it here catches a
    // break at the unit level first.
    const projected = log.projectForDiff()[0] ?? {};
    const dropped = Object.keys(before).filter((k) => !Object.keys(projected).includes(k));
    expect(dropped).toEqual(["at", "runId"]);

    // `phase` survives the projection, so a run that escalated and one that did
    // not are distinguishable by diff rather than collapsing to the same bytes.
    expect(Object.keys(projected)).toContain("phase");
    expect(JSON.stringify(log.projectForDiff())).toContain('"phase":"handoff"');
  });

  it("the diff projection drops timestamps and run ids, and nothing else", () => {
    const a = new EventSequencer(makeCtx({ runId: "run-01", now: () => "2026-03-02T14:05:00Z" }));
    const b = new EventSequencer(makeCtx({ runId: "run-99", now: () => "2027-11-20T09:00:00Z" }));

    for (const log of [a, b]) {
      log.emit("step.acted", step, { stepRef: "s01", expected: "screen CONFIRMATION", observed: "screen CONFIRMATION" });
      log.emit("outcome.matched", { as: "outcome_signal", code: "MEMBER_NOT_FOUND", matched: 'text contains "MSG 0071"' });
    }

    // Two runs, different clocks and different ids — identical projections.
    expect(a.projectForDiff()).toEqual(b.projectForDiff());
    // And the projection is not vacuous: the substance survives it.
    expect(JSON.stringify(a.projectForDiff())).toContain("MEMBER_NOT_FOUND");
    expect(JSON.stringify(a.projectForDiff())).toContain("s01");
  });

  it("a genuine divergence survives the projection", () => {
    const a = new EventSequencer(makeCtx());
    const b = new EventSequencer(makeCtx());
    a.emit("step.acted", step, { stepRef: "s01" });
    b.emit("step.acted", step, { stepRef: "s02" }); // different step — a real difference
    expect(a.projectForDiff()).not.toEqual(b.projectForDiff());
  });

  it("carries each kind of `why` — a belief, a citation, an attribution", () => {
    const log = new EventSequencer(makeCtx({ phase: "discovery" }));
    log.emit("model.chose", { as: "model_decision", stated: "the SEARCH button submits the form", model: "glm-4.7-flash", turn: 4 });
    log.emit("gate.decided", { as: "policy", ruleId: "route.denied:/__admin", allowed: false, dimension: "route" });
    log.emit("operator.resolved", { as: "operator", operator: "sup-014", disposition: "resolved" });

    expect(log.all.map((e) => e.why.as)).toEqual(["model_decision", "policy", "operator"]);
    // A belief is only ever a belief: the model's stated reason is recorded as
    // its claim, never as a fact the system verified.
    const first = log.all[0]?.why;
    expect(first?.as === "model_decision" && first.stated).toContain("SEARCH button");
  });

  it("omits optional fields rather than writing nulls into the record", () => {
    const log = new EventSequencer(makeCtx());
    const line = log.emit("step.acted", step);
    expect("expected" in line).toBe(false);
    expect("detail" in line).toBe(false);
    expect(line.stepRef).toBeNull();
  });
});
