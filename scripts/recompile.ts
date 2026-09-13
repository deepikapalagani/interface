/**
 * `npm run recompile` — build the artifact again from a trace already on disk.
 *
 * THIS EXISTS BECAUSE FOUR ERROR MESSAGES PROMISED IT AND NOTHING PROVIDED IT.
 * `mechanical.ts` refuses a compile three ways — a literal the binding cannot
 * name, a screen the risk profile does not rate, a checkpoint symbol it would
 * have had to fabricate — and each refusal tells the operator to "add it and
 * re-compile from trace.jsonl". Measured 2026-09-13: `compileMechanical` had
 * exactly one caller (`src/discover/main.ts`), no npm script matched `compile`,
 * and `discover` took no `--from-trace` flag. So the remedy named in every
 * refusal could not be run, which is the same defect class the refusals exist to
 * remove — a confident sentence with nothing behind it.
 *
 * It matters more than a convenience. A discovery run costs a model call and
 * several minutes; a binding gap costs one line. Without this, a refused compile
 * throws away the run rather than the line.
 *
 * The compiler reads the TRACE and never the transcript, so re-running it here is
 * the same computation the discovery CLI performed, on the same input, with no
 * model involved. This file imports no provider — read the import block below,
 * because that is the whole of the guarantee.
 *
 * An earlier version of this comment added "and `verify-no-llm` would catch it if
 * it did". That was false. The checker walks from `src/replay/index.ts` and
 * `src/replay/main.ts` only, and nothing under `scripts/` is ever reached. It
 * could not simply be added as a third entry point either: its `FORBIDDEN_PATHS`
 * are `src/model/`, `src/discover/` and `src/compile/`, and recompiling
 * legitimately imports two of them. The sentence was exactly the failure this
 * file's own header describes — a confident claim with nothing behind it —
 * written while fixing that failure elsewhere.
 *
 * EXIT CODES:
 *   0  the artifact was written
 *   1  it compiled, then FAILED schema validation — nothing is written
 *   2  called wrong: a missing flag, or an input file that cannot be read
 *   3  the compiler REFUSED — a literal the binding cannot name, a screen the
 *      risk profile does not rate, or a checkpoint symbol it would fabricate
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseBinding, type Binding } from "../src/capability/bind.js";
import { safeParseCapability } from "../src/capability/schema.js";
import { compileMechanical } from "../src/compile/mechanical.js";
import { DEFAULT_RISK_PROFILE_PATH, loadRiskProfile } from "../src/compile/risk-profile.js";
import type { TraceEntry } from "../src/discover/executor.js";

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (value === undefined || value.startsWith("--")) {
    if (fallback !== undefined) return fallback;
    console.error(`recompile: missing required --${name}`);
    process.exit(2);
  }
  return value;
};

/**
 * Provenance comes from the run's own manifest, never from this invocation.
 *
 * A recompile happens later, on a different machine, possibly by someone else.
 * Stamping `discoveredAt` with today's clock or the model with "unknown" would
 * make the artifact claim a provenance it does not have, so both are read back
 * from the run that actually produced the trace.
 */
interface RunManifest {
  readonly startedAt?: string;
  readonly model?: { readonly provider?: string };
  readonly capability?: { readonly id?: string; readonly version?: string };
  readonly tenant?: string;
}

const main = (): void => {
  const runDir = arg("run");
  const tracePath = path.join(runDir, "trace.jsonl");
  const manifestPath = path.join(runDir, "manifest.json");

  let trace: TraceEntry[];
  try {
    trace = readFileSync(tracePath, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as TraceEntry);
  } catch (e) {
    console.error(`recompile: cannot read ${tracePath} — ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  let manifest: RunManifest = {};
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RunManifest;
  } catch {
    // A trace without its manifest is still compilable; the provenance is just
    // thinner, and saying so beats inventing the fields.
    console.error(`recompile: no readable manifest beside the trace — provenance will be incomplete`);
  }

  /**
   * BOTH READS ARE GUARDED, because an unreadable input is "called wrong".
   *
   * These two used to sit bare, so a missing or malformed `--binding` surfaced as
   * exit 1 with a raw `node:fs` ENOENT stack trace at the operator — and exit 1
   * on this script means something quite different and much more interesting
   * ("it compiled, then failed validation"). Two unrelated conditions sharing an
   * exit code is how a script stops being scriptable.
   */
  let binding: Binding;
  let riskProfile: ReturnType<typeof loadRiskProfile>;
  try {
    // Checked, like both CLIs — a recompile runs the same `canonicalise` the
    // discovery CLI did, so it needs the same guarantee about label collisions.
    binding = parseBinding(JSON.parse(readFileSync(arg("binding"), "utf8")));
    riskProfile = loadRiskProfile(arg("risk-profile", DEFAULT_RISK_PROFILE_PATH));
  } catch (e) {
    console.error(`recompile: cannot load an input — ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  const capabilityId = arg("capability-id", manifest.capability?.id ?? "msc.capability");
  const version = arg("version", manifest.capability?.version ?? "1.0.0");
  /**
   * `--out` IS REQUIRED, and that is a safety default rather than pedantry.
   *
   * It used to default to `path.join(runDir, "capability.json")` — i.e. straight
   * back over the artifact of the run it was given. Point it at a directory under
   * `/evidence/` and it silently overwrites a graded deliverable. `scripts/demo.ts`
   * goes to visible lengths never to write there; defaulting into it was this
   * script doing the exact opposite without saying so.
   */
  const out = arg("out");

  console.log(`recompile: ${trace.length} trace entr(ies) from ${tracePath}`);

  let draft: Record<string, unknown>;
  try {
    draft = compileMechanical({
      trace,
      goal: arg("goal"),
      capabilityId,
      version,
      app: "MERIDIAN MSC",
      model: manifest.model?.provider ?? "(unrecorded)",
      appProfileVersion: "meridian-msc@4.2",
      discoveredAt: manifest.startedAt ?? "(unrecorded)",
      binding,
      riskProfile,
    });
  } catch (e) {
    // The same refusal the discovery CLI prints, from the same code path. Exit 3
    // distinguishes "the compiler declined" from "this script was called wrong".
    console.error(`recompile: REFUSED — ${e instanceof Error ? e.message : String(e)}`);
    process.exit(3);
  }

  const parsed = safeParseCapability(draft);
  if (!parsed.success) {
    console.error("recompile: the compiled artifact FAILED validation:");
    for (const i of parsed.error.issues) console.error(`  ${i.path.join(".")}: ${i.message}`);
    process.exit(1);
  }

  writeFileSync(out, `${JSON.stringify(parsed.data, null, 1)}\n`, "utf8");
  const steps = parsed.data.plan.steps.map((s) => `${s.ref}:${s.action}/${s.risk}`).join(" ");
  console.log(`recompile: wrote ${out}`);
  console.log(`  ${capabilityId}@${version}  risk=${parsed.data.contract.risk}  steps: ${steps}`);
};

main();
