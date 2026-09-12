/**
 * `npm run replay` — the production path, from a command line.
 *
 * This is what an AI agent's invocation looks like reduced to a CLI: give it a
 * capability, a tenant binding and some inputs, and it drives the app and returns
 * a typed result. It needs NO model key, and the manifest it writes records
 * `model.calls: 0` so that claim is checkable in a file rather than taken on
 * trust.
 *
 * Usage:
 *   npm run replay -- --capability tests/fixtures/lookup@1.0.0.json \
 *                     --binding tests/fixtures/fcu@4.2.json \
 *                     --target http://localhost:7101/ \
 *                     --input member_id=400200101
 *
 * With a human in the loop (§3.6), which needs a headed browser and a person:
 *   npm run replay -- --headed --operator \
 *                     --policy tests/fixtures/policy-escalate.json \
 *                     --capability tests/fixtures/lookup@1.0.0.json \
 *                     --binding tests/fixtures/fcu@4.2.json \
 *                     --evidence "$(mktemp -d)" --input member_id=400200101
 *
 * ── THE DEFAULT PATH IS UNTOUCHED, AND THAT IS A HARD REQUIREMENT ───────────
 *
 * `scripts/verify-determinism.ts` spawns THIS FILE with no flags across three
 * scenarios and compares the resulting evidence byte for byte. So every addition
 * below is strictly opt-in: with no `--policy` the inline document is the one
 * this file has always built, and with no `--operator` no console is constructed,
 * no port is bound, and nothing is passed to `replay()`. A default policy that
 * could escalate would put a human turn inside the determinism corpus, which is
 * why the demo escalates through a policy FILE instead.
 */
import { readFileSync } from "node:fs";
import { parseCapability } from "../capability/schema.js";
import { Binding } from "../capability/bind.js";
import { runEscalation, type Escalate } from "../control/escalation.js";
import { ControlLease } from "../control/lease.js";
import { EvidenceWriter } from "../evidence/log.js";
import { EventSequencer } from "../evidence/events.js";
import { OperatorConsole } from "../operator/main.js";
import { PolicyDocument } from "../policy/policy.js";
import { BoundSurface } from "../surface/bound.js";
import { GatedSurface } from "../surface/gated.js";
import { PlaywrightSurface } from "../surface/playwright.js";
import { replay, type ReplayDeps } from "./index.js";

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    console.error(`replay: missing required --${name}`);
    process.exit(2);
  }
  return value;
};

/** Present-or-absent, for flags that change behaviour by existing. */
const optional = (name: string): string | null => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const next = process.argv[i + 1];
  return next === undefined || next.startsWith("--") ? "" : next;
};

/** Repeatable: --input a=1 --input b=2 */
const inputs = (): Record<string, string> => {
  const out: Record<string, string> = {};
  process.argv.forEach((a, i) => {
    if (a !== "--input") return;
    const pair = process.argv[i + 1] ?? "";
    const eq = pair.indexOf("=");
    if (eq > 0) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  });
  return out;
};

const main = async (): Promise<void> => {
  const capability = parseCapability(JSON.parse(readFileSync(arg("capability"), "utf8")));
  const binding = Binding.parse(JSON.parse(readFileSync(arg("binding"), "utf8")));
  const target = arg("target", "http://localhost:7101/");
  const evidenceRoot = arg("evidence", "evidence/runs");
  const runId = arg("run-id", `replay-${capability.contract.id}`);
  const params = inputs();

  /**
   * The allowlist. Loaded from a file when one is named, so a reviewer can read
   * what the agent was permitted to do without reading the agent (§3.4-a).
   *
   * The inline fallback is UNCHANGED and must stay so: the admin plane is denied
   * a capability cannot arm faults or reset the app it is running against, and
   * `screenRules: []` means nothing on this capability escalates by default.
   */
  const policyFile = optional("policy");
  const policy = policyFile
    ? PolicyDocument.parse(JSON.parse(readFileSync(policyFile, "utf8")))
    : PolicyDocument.parse({
        version: "1.0.0",
        allowedOrigins: [new URL(target).origin],
        deniedRoutes: ["/__admin"],
        allowedActions: ["navigate", "click", "fill", "press", "dismiss_dialog"],
        screenRules: [],
        riskHandling: { read_only: "allow", reversible: "allow", irreversible: "confirm" },
        caps: { maxSteps: 40, maxRunSeconds: 120 },
      });

  const operatorFlag = optional("operator");
  const operatorPort = operatorFlag === null ? null : Number(operatorFlag === "" ? "7900" : operatorFlag);
  const handoffTtlMs = Number(arg("handoff-ttl", "120000"));

  const startedAt = new Date().toISOString();
  const lease = new ControlLease(() => new Date().toISOString());
  const log = new EventSequencer({
    runId,
    phase: "replay",
    now: () => new Date().toISOString(),
    controlOwner: () => lease.holder,
  });

  const driver = await PlaywrightSurface.launch(target, { headed: process.argv.includes("--headed") });

  // Constructed ONLY on demand. With no --operator this is null, no port is
  // bound, and the run is byte-for-byte what it was before §3.6 existed.
  const operator =
    operatorPort === null
      ? null
      : await OperatorConsole.start({ port: operatorPort, channel: driver, operator: "console" });

  try {
    const surface = new GatedSurface(new BoundSurface(driver, binding), policy, lease);

    /**
     * The escalation orchestrator, attached only when a console exists.
     *
     * `Escalate` is a FUNCTION — `(draft) => Promise<EscalationResult>` — not a
     * bag of dependencies, and that distinction is worth stating because getting
     * it wrong typechecks: an object supplied here intersects with the declared
     * function type rather than conflicting with it, so the mistake surfaces only
     * at runtime as "escalate is not a function". The dependencies are closed
     * over instead, and `runEscalation` owns the ordering — cede, arm the lock,
     * raise, race the TTL, clear the lock, reclaim or expire.
     *
     * `session` is the driver itself: the same object that holds the page, so the
     * person gets the session the run is standing in rather than a fresh one.
     */
    const escalate: Escalate | null =
      operator === null
        ? null
        : (draft) =>
            runEscalation(draft, {
              lease,
              log,
              transport: operator,
              ttlMs: handoffTtlMs,
              now: () => Date.now(),
              session: driver,
            });

    if (operator !== null) {
      console.log(`operator console: ${operator.url}  (hand-back TTL ${handoffTtlMs}ms)`);
    }

    const deps: ReplayDeps = {
      surface,
      lease,
      log,
      runId,
      budgets: { stepMs: 10_000, runMs: 120_000 },
      now: () => Date.now(),
      // Absent is absent, not `undefined`: exactOptionalPropertyTypes draws that
      // distinction, and with no --operator the field is simply not there.
      ...(escalate === null ? {} : { escalate }),
    };

    const result = await replay(capability, binding, params, deps);

    const evidence = new EvidenceWriter(evidenceRoot, runId);
    evidence.events(log.all);
    evidence.artifact(capability);
    evidence.manifest({
      runId,
      phase: "replay",
      startedAt,
      endedAt: new Date().toISOString(),
      target,
      tenant: binding.tenant,
      capability: { id: capability.contract.id, version: capability.contract.version },
      model: { provider: "none", calls: result.modelCalls },
      result: result.status,
      versions: { node: process.versions.node, playwright: "1.63.0" },
    });

    console.log(JSON.stringify(result, null, 1));
    console.log(`\nevidence: ${evidence.directory}`);

    // A business outcome is a SUCCESS of the system: the caller asked a question
    // and got a legitimate answer. Only a failure is a non-zero exit.
    process.exit(result.status === "failed" ? 1 : 0);
  } finally {
    await operator?.close();
    await driver.close();
  }
};

main().catch((e: unknown) => {
  console.error("replay: unhandled error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
