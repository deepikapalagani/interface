/**
 * A HANDOFF THAT REACHES DISK, AND A CHECKER THAT WOULD REJECT IT IF IT WERE WRONG.
 *
 * §3.6-d asks the system to "record what the human did". Before this the record
 * could not exist: `phase` came only from `LogContext`, so a `handoff` line was
 * error TS2353, and there was no writer for the settled record at all. The
 * envelope declared a phase nothing could produce and the checker had been
 * waiting for a writer that could not be written.
 *
 * These tests pin the property THROUGH THE REAL WRITER ONTO A REAL DIRECTORY,
 * for the reason tests/evidence-on-failure.test.ts does: the interesting defects
 * live in the gap between "the object was built" and "a file exists to read it
 * in", so an assertion on an in-memory array would pass the whole time the file
 * was absent, unredacted, or unreconciled.
 *
 * THE CHECKER IS RUN AS THE REAL SCRIPT, not reimplemented here. It resolves its
 * run root and its secret ground truth relative to the process CWD, so the tree
 * is built to that shape and the script is spawned with `cwd` swapped. That
 * matters: the script REFUSES to run if it cannot source the seeded PAN/SSN
 * literals from mock/seed.ts, so copying the real seed in is what keeps the leak
 * scan the real one rather than a vacuous pass. It also demands both a discovery
 * and a replay run before it will report success, so the tree carries both.
 *
 * No browser, no model, no mock server.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { EventSequencer } from "../src/evidence/events.js";
import { EvidenceWriter, type HandoffRecord } from "../src/evidence/log.js";
import type { ControlOwner } from "../src/contract/result.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const CHECKER = path.join(repoRoot, "scripts", "verify-evidence.ts");
const TSX = path.join(repoRoot, "node_modules", ".bin", "tsx");
const SEED = path.join(repoRoot, "mock", "seed.ts");

/**
 * The literal MBR0400 renders as plain text, and the one reachable leak path on
 * this surface. Taken as a constant here rather than read from the seed, because
 * a test that sourced it the same way the redactor does could agree with the
 * redactor while both were wrong.
 */
const SEEDED_SSN = "900-55-0101";
const MASKED_SSN = "***-**-0101";

const RUN_ID = "replay-escalated";
const DISCOVERY_ID = "discovery-001";

const temps: string[] = [];
const tempRoot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "handoff-evidence-"));
  temps.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

const jsonl = (...rows: unknown[]): string => rows.map((r) => `${JSON.stringify(r)}\n`).join("");

/** The record a real escalation would settle: EscalationRecord plus §3.6-b's context. */
const record = (over: Partial<HandoffRecord> = {}): HandoffRecord => ({
  runId: RUN_ID,
  capability: "msc.card.set_status@1.0.0",
  goal: "freeze the debit card ending 4021 for member 400200101",
  stepRef: "s04",
  reason: 'policy rated the effective risk irreversible on screen CARD_SERVICES (rule "risk.irreversible"), which requires a person',
  requestedAt: "2026-03-02T14:05:10.000Z",
  resolvedAt: "2026-03-02T14:07:30.000Z",
  disposition: "resolved",
  operator: "sup-014",
  reconstructedActions: [
    "navigated MBR0300 -> MBR0400 in the same session",
    "set CARD STATUS to FROZEN and submitted",
  ],
  screen: "CARD_SERVICES",
  // The raw screen dump the human was shown — carrying the SSN the writer must mask.
  observedText: `MBR0400 MEMBER DETAIL   ABERNATHY, ROSE   SSN ${SEEDED_SSN}   BRANCH 012`,
  ...over,
});

/**
 * One escalating replay run, written entirely through the production writers:
 * the real `EventSequencer` (exercising the per-emit phase override) and the
 * real `EvidenceWriter`. Nothing about the file is hand-assembled, so what the
 * checker reads is what the system would actually produce.
 */
const writeEscalatedRun = (tree: string, records: readonly HandoffRecord[]): string => {
  const root = path.join(tree, "evidence", "runs");
  const writer = new EvidenceWriter(root, RUN_ID);

  let owner: ControlOwner = "automation";
  let tick = 0;
  const log = new EventSequencer({
    runId: RUN_ID,
    phase: "replay",
    now: () => new Date(Date.UTC(2026, 2, 2, 14, 5, tick++)).toISOString(),
    controlOwner: () => owner,
  });

  const cite = { as: "artifact_step", capability: "msc.card.set_status", version: "1.0.0", stepRef: "s04" } as const;

  log.emit("step.acted", cite, { stepRef: "s03" });
  log.emit(
    "escalation.required",
    { as: "policy", ruleId: "risk.irreversible", allowed: false, dimension: "risk" },
    { stepRef: "s04", expected: "an action policy permits automation to take", observed: "effective risk irreversible; a person is required" },
  );

  // The control transfer itself: the one line whose phase differs from its run.
  owner = "human";
  log.emit(
    "control.ceded",
    { as: "operator", operator: "sup-014", disposition: "resolved" },
    { phase: "handoff", stepRef: "s04" },
  );
  owner = "automation";
  log.emit("step.verified", cite, { stepRef: "s04", expected: "screen CARD_SERVICES", observed: "screen CARD_SERVICES" });

  writer.events(log.all);
  writer.handoff(records);
  writer.manifest({
    runId: RUN_ID,
    phase: "replay",
    startedAt: "2026-03-02T14:05:00.000Z",
    endedAt: "2026-03-02T14:08:00.000Z",
    target: "http://localhost:7101/",
    tenant: "fcu",
    model: { provider: "none", calls: 0 },
    result: "success",
    versions: { node: "20.17.0", playwright: "1.63.0" },
  });

  return path.join(root, RUN_ID);
};

/**
 * A complete tree the real checker will accept: the seeded literals it refuses
 * to run without, plus one discovery run and one replay run, because a tree with
 * only one phase fails on the through-line rather than on anything being wrong.
 */
const buildTree = (records: readonly HandoffRecord[] = [record()]): { tree: string; runDir: string } => {
  const tree = tempRoot();
  fs.mkdirSync(path.join(tree, "mock"), { recursive: true });
  fs.copyFileSync(SEED, path.join(tree, "mock", "seed.ts"));

  const discovery = path.join(tree, "evidence", "runs", DISCOVERY_ID);
  fs.mkdirSync(discovery, { recursive: true });
  fs.writeFileSync(path.join(discovery, "manifest.json"), JSON.stringify({
    runId: DISCOVERY_ID,
    phase: "discovery",
    startedAt: "2026-03-01T09:00:00.000Z",
    endedAt: "2026-03-01T09:04:00.000Z",
    target: "http://localhost:7101/",
    tenant: "fcu",
    model: { provider: "glm-4.7-flash", calls: 6 },
    result: "goal_reached",
    versions: { node: "20.17.0", playwright: "1.63.0" },
  }));
  fs.writeFileSync(path.join(discovery, "events.jsonl"), jsonl({
    seq: 1,
    at: "2026-03-01T09:00:01.000Z",
    runId: DISCOVERY_ID,
    phase: "discovery",
    controlOwner: "automation",
    event: "model.chose",
    stepRef: null,
    why: { as: "model_decision", stated: "the SEARCH button submits the form", model: "glm-4.7-flash", turn: 4 },
  }));

  return { tree, runDir: writeEscalatedRun(tree, records) };
};

const runChecker = (tree: string, extra: readonly string[] = []): { status: number; output: string } => {
  const r = spawnSync(TSX, [CHECKER, ...extra], { cwd: tree, encoding: "utf8", timeout: 120_000 });
  return { status: r.status ?? -1, output: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

const readRows = (runDir: string): { body: string; rows: Record<string, unknown>[] } => {
  const body = fs.readFileSync(path.join(runDir, "handoff.jsonl"), "utf8");
  const rows = body.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>);
  return { body, rows };
};

describe("the handoff record on disk", () => {
  it("is JSONL, one settled turn per line, terminated by a newline", () => {
    const { runDir } = buildTree();
    const { body, rows } = readRows(runDir);

    // A file that does not end in a newline cannot be distinguished from one
    // whose last line was truncated — the same property the checker enforces.
    expect(body.endsWith("\n")).toBe(true);
    expect(rows).toHaveLength(1);

    // It lives in the escalating run's OWN directory, beside the events it has
    // to reconcile with. Not a run of its own: RunManifest.phase is typed
    // discovery|replay, and the checker skips the event check for anything else.
    expect(fs.readdirSync(runDir).sort()).toEqual(["events.jsonl", "handoff.jsonl", "manifest.json"]);

    // §3.6-b's context survives the trip: the goal, the step, and why it stopped.
    const row = rows[0] ?? {};
    expect(row["goal"]).toContain("freeze the debit card");
    expect(row["stepRef"]).toBe("s04");
    expect(row["capability"]).toBe("msc.card.set_status@1.0.0");
    expect(String(row["reason"])).toContain("irreversible");
    expect(row["disposition"]).toBe("resolved");
    expect(row["operator"]).toBe("sup-014");
    expect(row["reconstructedActions"]).toEqual([
      "navigated MBR0300 -> MBR0400 in the same session",
      "set CARD STATUS to FROZEN and submitted",
    ]);
  });

  it("masks an SSN in the observed screen text on the way out (§3.4-e)", () => {
    const { runDir } = buildTree();
    const { body, rows } = readRows(runDir);

    // `observedText` is a raw screen dump, and MBR0400 renders an SSN as plain
    // text. This is the last boundary before bytes hit disk, so the redaction
    // happens in the writer rather than being trusted to have happened upstream.
    expect(body).not.toContain(SEEDED_SSN);
    expect(String(rows[0]?.["observedText"])).toContain(MASKED_SSN);

    // Masked, not destroyed: the rest of the screen a reviewer needs is intact.
    expect(String(rows[0]?.["observedText"])).toContain("ABERNATHY, ROSE");
    expect(String(rows[0]?.["observedText"])).toContain("BRANCH 012");
  });

  it("does not mutate the caller's record — the agent still gets the real one back", () => {
    const original = record();
    const { runDir } = buildTree([original]);

    // Redaction applies to a COPY. If it mutated in place, the same object the
    // run hands back to the calling agent in `interventions[]` would come back
    // full of asterisks behind its back.
    expect(original.observedText).toContain(SEEDED_SSN);
    expect(readRows(runDir).body).not.toContain(SEEDED_SSN);
  });

  it("is accepted by the REAL checker, run as the script a reviewer runs", () => {
    const { tree } = buildTree();
    const { status, output } = runChecker(tree);

    expect(output).toContain("verify-evidence: OK");
    expect(status).toBe(0);
  }, 120_000);
});

describe("the checker would reject a bad handoff record", () => {
  it("rejects a field no writer declares, rather than passing it through", () => {
    const { tree, runDir } = buildTree();
    // Written by hand on purpose: the point of the check is to catch what the
    // type system cannot — a hand-edited file, or a future writer that starts
    // smuggling a per-run-varying value onto a graded deliverable.
    const row = { ...record(), epoch: 2 };
    fs.writeFileSync(path.join(runDir, "handoff.jsonl"), jsonl(row));

    const { status, output } = runChecker(tree);
    expect(output).toContain('carries "epoch", which a handoff record does not declare');
    expect(status).toBe(1);
  }, 120_000);

  it("rejects a record whose run never logged the transition it claims", () => {
    const { tree, runDir } = buildTree();
    // The file says a human took the session; the event log says no transition
    // ever happened. Two records of one control transfer have to agree, or the
    // evidence is decorative.
    const events = fs.readFileSync(path.join(runDir, "events.jsonl"), "utf8");
    fs.writeFileSync(
      path.join(runDir, "events.jsonl"),
      events.split("\n").filter((l) => l !== "" && !l.includes('"phase":"handoff"'))
        .map((l, i) => JSON.stringify({ ...(JSON.parse(l) as Record<string, unknown>), seq: i + 1 }))
        .map((l) => `${l}\n`).join(""),
    );

    const { status, output } = runChecker(tree);
    expect(output).toContain('no event line with phase "handoff"');
    expect(status).toBe(1);
  }, 120_000);

  it("proves these checks are live, via the script's own planted-defect self-test", () => {
    const { tree } = buildTree();
    const { status, output } = runChecker(tree, ["--self-test"]);

    // `--self-test` is opt-in and `npm run verify:evidence` does not pass it, so
    // running it here is what keeps the new checks from being merely assumed.
    expect(output).toContain("self-test passed");
    expect(status).toBe(0);
  }, 120_000);
});

describe("EvidenceWriter given no handoff to write", () => {
  it("leaves the file absent and complains, rather than writing an empty one", () => {
    const root = tempRoot();
    const writer = new EvidenceWriter(root, "no-escalation");

    const complaints: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      complaints.push(args.map(String).join(" "));
    });
    try {
      writer.handoff([]);
    } finally {
      spy.mockRestore();
    }

    // The file's existence is itself a claim that this run escalated. A zero-line
    // file would pass an existence check while making that claim falsely — and
    // would add a filename to a non-escalating run, which is precisely what
    // verify-determinism compares across its scenarios — four, since card-freeze.
    expect(fs.existsSync(path.join(root, "no-escalation", "handoff.jsonl"))).toBe(false);
    expect(complaints.join("\n")).toContain("left absent rather than written empty");
  });
});
