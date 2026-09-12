/**
 * THE RUN THAT FAILS BEFORE IT TOUCHES ANYTHING MUST STILL LEAVE A LOG.
 *
 * §3.5 asks for a structured log of what the agent did and why; §6 asks
 * specifically for "a replay that hits an error or exceptional state". Those two
 * requirements met badly here. MEASURED: replaying msc.member.lookup with
 * member_id=abc exited 1 with kind input_schema_violation and wrote a run
 * directory of exactly [capability.json, manifest.json]. Nothing had emitted, so
 * `EvidenceWriter.events` looped over an empty array and events.jsonl was ABSENT
 * rather than empty. The failing run — the one a reviewer most needs to read —
 * left strictly less evidence than the successful one.
 *
 * These tests pin the property THROUGH THE REAL WRITER ONTO DISK, not just on
 * the in-memory sequencer. That is deliberate: the defect lived in the gap
 * between "the result was returned" and "a file exists to read it in", so an
 * assertion on `log.all` alone would have passed the entire time the file was
 * missing. They also re-assert, on the file, the two properties
 * scripts/verify-evidence.ts checks there: gapless `seq`, and no `model_decision`
 * arm in a replay run.
 *
 * No browser, no model, no mock server. Every run below is rejected before the
 * surface is touched, and the surface below throws on ANY access if that is ever
 * untrue — which is what makes "before anything is driven" a tested claim rather
 * than a comment.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Binding } from "../src/capability/bind.js";
import { parseCapability } from "../src/capability/schema.js";
import { ControlLease } from "../src/control/lease.js";
import { EventSequencer } from "../src/evidence/events.js";
import { EvidenceWriter } from "../src/evidence/log.js";
import type { ReplayResult } from "../src/contract/result.js";
import { replay } from "../src/replay/index.js";
import type { Surface } from "../src/surface/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (name: string): unknown => JSON.parse(fs.readFileSync(path.join(here, "fixtures", name), "utf8"));

const capability = parseCapability(load("lookup@1.0.0.json"));
const bindingJson = load("fcu@4.2.json") as Record<string, unknown>;
const binding = Binding.parse(bindingJson);

/**
 * A binding that cannot supply MEMBER_ID — §3.7-d drift, as opposed to the
 * configuration difference a binding is allowed to absorb.
 */
const driftBinding = ((): Binding => {
  const fields = { ...(bindingJson["fields"] as Record<string, string>) };
  delete fields["MEMBER_ID"];
  return Binding.parse({ ...bindingJson, fields });
})();

/** Any access at all is a failure: these runs must be decided without perceiving anything. */
const neverTouched = new Proxy({} as Surface, {
  get: (_target, property) => () => {
    throw new Error(`the surface was touched (.${String(property)}) — this run must be rejected before anything is driven`);
  },
});

const temps: string[] = [];
const tempRoot = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-on-failure-"));
  temps.push(dir);
  return dir;
};

afterAll(() => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

/** One rejected invocation, flushed to a real directory exactly as the CLI does. */
const rejectedRun = async (
  runId: string,
  params: Readonly<Record<string, string>>,
  use: Binding = binding,
): Promise<{ result: ReplayResult; dir: string; lines: Record<string, unknown>[] }> => {
  const lease = new ControlLease(() => new Date().toISOString());
  const log = new EventSequencer({
    runId,
    phase: "replay",
    now: () => new Date().toISOString(),
    controlOwner: () => lease.holder,
  });

  const result = await replay(capability, use, params, {
    surface: neverTouched,
    lease,
    log,
    runId,
    budgets: { stepMs: 1000, runMs: 5000 },
    now: () => Date.now(),
  });

  const root = tempRoot();
  const evidence = new EvidenceWriter(root, runId);
  evidence.events(log.all);
  evidence.artifact(capability);

  const file = path.join(root, runId, "events.jsonl");
  const body = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = body
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  return { result, dir: path.join(root, runId), lines };
};

const why = (line: Record<string, unknown> | undefined): Record<string, unknown> =>
  (line?.["why"] ?? {}) as Record<string, unknown>;

describe("a replay rejected before it touches the UI", () => {
  it("leaves a readable events.jsonl, not just a capability and a manifest", async () => {
    const { result, dir, lines } = await rejectedRun("replay-bad-input", { member_id: "abc" });

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.kind).toBe("input_schema_violation");

    // The regression itself: the directory used to hold exactly these two files.
    expect(fs.readdirSync(dir).sort()).toContain("events.jsonl");
    expect(lines.length).toBeGreaterThan(0);

    // Gapless, asserted on the FILE — the same property verify-evidence checks,
    // because a log that cannot be proven complete is weak evidence.
    expect(lines.map((l) => l["seq"])).toEqual(lines.map((_l, i) => i + 1));

    // And it is readable: it says which argument was rejected and against what.
    const first = lines[0];
    expect(first?.["event"]).toBe("inputs.rejected");
    expect(String(first?.["observed"])).toContain("member_id does not match");
    expect(String(first?.["expected"])).toContain("^\\d{9}$");
  });

  it("cites the artifact's own input contract — a citation, never a model belief", async () => {
    const { lines } = await rejectedRun("replay-cites-contract", { member_id: "abc" });
    const first = lines[0];

    // artifact_step is the arm, and the citation resolves: a reviewer can open
    // capability.json in this same directory at contract.inputs.member_id.
    expect(why(first)["as"]).toBe("artifact_step");
    expect(why(first)["capability"]).toBe("msc.member.lookup");
    expect(why(first)["version"]).toBe("1.0.0");
    expect(why(first)["stepRef"]).toBe("contract.inputs.member_id");

    // No step ran, and the line says so rather than naming a step that does not exist.
    expect(first?.["stepRef"]).toBeNull();

    // The property verify-evidence enforces on every replay run: no beliefs here.
    expect(lines.map((l) => why(l)["as"])).not.toContain("model_decision");
    expect(lines.every((l) => l["phase"] === "replay")).toBe(true);
    expect(lines.every((l) => l["controlOwner"] === "automation")).toBe(true);
  });

  it("names the field and the constraint it broke, never the value supplied (§3.4-e)", async () => {
    const { lines } = await rejectedRun("replay-redaction", {
      member_id: "SENTINEL-MEMBER-VALUE",
      note: "SENTINEL-UNDECLARED-VALUE",
    });

    const serialised = JSON.stringify(lines);
    expect(serialised).toContain("member_id");
    expect(serialised).toContain("note not declared by this capability");
    // Values a caller supplied are the one thing that must not reach the log.
    expect(serialised).not.toContain("SENTINEL");

    // Two offending arguments, so the citation widens to the section they share
    // rather than pretending one of them is the whole story.
    expect(why(lines[0])["stepRef"]).toBe("contract.inputs");
  });

  it("never cites a clause that does not exist, when the offending name came from the caller", async () => {
    // The name in an "undeclared argument" rejection is the CALLER's, so there is
    // no contract.inputs.<name> to open. A citation that does not resolve would
    // defeat the point of the arm, so the section it violated is cited instead.
    const { lines } = await rejectedRun("replay-undeclared-only", { member_id: "400200101", extra: "x" });

    expect(lines[0]?.["event"]).toBe("inputs.rejected");
    expect(why(lines[0])["stepRef"]).toBe("contract.inputs");

    const cited = String(why(lines[0])["stepRef"]).split(".");
    const clause = cited.length === 3 ? cited[2] : null;
    expect(clause === null || capability.contract.inputs.some((i) => i.name === clause)).toBe(true);
  });

  it("logs a binding gap (drift) the same way, rather than failing silently", async () => {
    const { result, dir, lines } = await rejectedRun("replay-drift", { member_id: "400200101" }, driftBinding);

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.kind).toBe("drift_suspected");

    expect(fs.readdirSync(dir)).toContain("events.jsonl");
    const first = lines[0];
    expect(first?.["event"]).toBe("binding.unresolved");
    expect(why(first)["stepRef"]).toBe("plan.targets");
    expect(String(first?.["observed"])).toContain("MEMBER_ID");
  });
});

describe("EvidenceWriter given nothing to write", () => {
  it("leaves the file absent and complains, rather than inventing a line", () => {
    const root = tempRoot();
    const writer = new EvidenceWriter(root, "empty-run");

    const complaints: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      complaints.push(args.map(String).join(" "));
    });
    try {
      writer.events([]);
    } finally {
      spy.mockRestore();
    }

    // Pinning the deliberate non-fix: the writer does not paper over an empty run
    // with a zero-line file (which passes an existence check while saying
    // nothing) and does not synthesise a `why` no code path decided. The
    // invariant lives upstream, so a breach has to be audible here.
    expect(fs.existsSync(path.join(root, "empty-run", "events.jsonl"))).toBe(false);
    expect(complaints.join("\n")).toContain("emitted no events");
  });
});
