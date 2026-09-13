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
 * ── WHAT THE DETERMINISM GATE REQUIRES OF THIS FILE ─────────────────────────
 *
 * `scripts/verify-determinism.ts` spawns THIS FILE with no flags across four
 * scenarios and compares the resulting evidence byte for byte, after projecting
 * away only `at`/`runId` from events and `runId`/`startedAt`/`endedAt` from the
 * manifest. `capability.json` is compared with NO projection at all.
 *
 * So the bar is not "opt-in", it is DETERMINISTIC. Two things below are always
 * on and both clear that bar because they are functions of the artifact and the
 * surface rather than of the clock:
 *
 *   - the GATE AUDIT. Every policy decision is logged, allowed or refused. Two
 *     runs of the same capability take the same actions and so record the same
 *     verdicts. Without it the guardrail was invisible in evidence in both
 *     directions: nothing was written when it allowed, and a refusal on step one
 *     left a run directory the project's own evidence gate rejects.
 *   - the VERIFICATION STAMP. A successful run records `replayResult: "success"`
 *     and `modelCalls: 0` into the artifact it writes. It deliberately does NOT
 *     record `replayedAt`: a wall-clock instant is exactly the kind of field the
 *     byte-for-byte comparison of `capability.json` would catch, and the schema
 *     documents that omission rather than leaving it to be rediscovered.
 *
 * The escalation path stays genuinely opt-in: with no `--operator` no console is
 * constructed, no port is bound, and nothing is passed to `replay()`. A default
 * policy that could escalate would put a human turn inside the determinism
 * corpus, which is why the demo escalates through a policy FILE instead.
 */
import { readFileSync } from "node:fs";
import { parseCapability, type Capability } from "../capability/schema.js";
import { Binding } from "../capability/bind.js";
import type { ReplayResult } from "../contract/result.js";
import { runEscalation, type Escalate } from "../control/escalation.js";
import { ControlLease } from "../control/lease.js";
import { EvidenceWriter, type HandoffRecord } from "../evidence/log.js";
import { EventSequencer } from "../evidence/events.js";
import { OperatorConsole } from "../operator/main.js";
import { PolicyDocument, validatePlanOrigins } from "../policy/policy.js";
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

/**
 * Record that this artifact replayed, in the artifact this run writes (§3.2).
 *
 * `verification.replayResult` existed with no producer: every committed
 * artifact said `not_yet_verified` because nothing ever stamped otherwise, so
 * the field read as a claim the system could make and never did.
 *
 * ONLY ON SUCCESS, and only these two fields. A business outcome is a legitimate
 * answer but it is not the capability's declared checkpoint being reached, so it
 * does not license the stamp; a failure obviously does not. `replayedAt` is
 * omitted deliberately — see the schema's comment on the field.
 */
const stampVerification = (capability: Capability, result: ReplayResult | null): Capability =>
  result?.status === "success"
    ? { ...capability, verification: { ...capability.verification, replayResult: "success", modelCalls: 0 } }
    : capability;

const main = async (): Promise<number> => {
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

  /**
   * THE ALLOWLIST IS CHECKED BEFORE A BROWSER EXISTS.
   *
   * `validatePlanOrigins` was written for exactly this and had no caller, so an
   * off-allowlist `--target` launched Chromium, NAVIGATED to the forbidden
   * origin and rendered it; only the first ACTION was refused, by which point
   * the page had already been fetched. For an allowlist whose purpose is that
   * the agent cannot act outside it, "we loaded it and then declined to click"
   * is not the guarantee §3.4-a asks for.
   *
   * Exit 2, matching `arg()`'s convention for a bad invocation: this is the
   * caller asking for something the policy forbids, not a run that failed.
   */
  const offLimits = validatePlanOrigins(policy, [target]);
  if (offLimits.length > 0) {
    console.error(`replay: refusing to start — target ${target} is not on this policy's allowlist`);
    console.error(`  allowed origins: ${policy.allowedOrigins.join(", ")}`);
    console.error("  no browser was launched and no evidence directory was created.");
    return 2;
  }

  const operatorFlag = optional("operator");
  const operatorPort = operatorFlag === null ? null : Number(operatorFlag === "" ? "7900" : operatorFlag);
  const handoffTtlMs = Number(arg("handoff-ttl", "120000"));

  const startedAt = new Date().toISOString();
  const lease = new ControlLease(() => new Date().toISOString());

  /**
   * THE WRITER IS BUILT BEFORE THE RUN, and every line is appended as it is
   * emitted rather than serialised at the end.
   *
   * This file previously had no `catch` at all and flushed once, after
   * `replay()` returned — so anything thrown inside the run lost the ENTIRE log,
   * not merely the failure. `evidence/log.ts` claimed JSONL was chosen so a
   * half-way crash still leaves readable evidence; the sink is what makes that
   * true here.
   */
  const evidence = new EvidenceWriter(evidenceRoot, runId);
  const log = new EventSequencer({
    runId,
    phase: "replay",
    now: () => new Date().toISOString(),
    controlOwner: () => lease.holder,
    sink: (e) => evidence.event(e),
  });

  /** Settled human turns, collected from the run and flushed below (§3.6-d). */
  const handoffs: HandoffRecord[] = [];

  const driver = await PlaywrightSurface.launch(target, { headed: process.argv.includes("--headed") });

  // Constructed ONLY on demand. With no --operator this is null, no port is
  // bound, and the run is byte-for-byte what it was before §3.6 existed.
  const operator =
    operatorPort === null
      ? null
      : await OperatorConsole.start({ port: operatorPort, channel: driver, operator: "console" });

  let result: ReplayResult | null = null;

  try {
    /**
     * THE GATE'S OWN VERDICTS, RECORDED.
     *
     * `GateEvent` calls itself "the audit of the guardrail itself" and
     * `onDecision` defaulted to `() => {}` with no production caller anywhere,
     * so not one ALLOWED decision was ever written down: across all five
     * committed runs there is not a single `"as":"policy"` line. §3.4 asks for an
     * allowlist the agent cannot act outside of and §3.5 for a log of what was
     * done and why — the guardrail's verdicts were the one thing never logged.
     *
     * Deterministic by construction: the same plan takes the same actions and so
     * produces the same verdicts, in the same order.
     */
    const surface = new GatedSurface(new BoundSurface(driver, binding), policy, lease, (e) => {
      log.emit(
        "gate.decided",
        { as: "policy", ruleId: e.decision.ruleId, allowed: e.decision.allow, dimension: e.decision.dimension },
        {
          stepRef: e.stepRef,
          expected: `policy to permit ${e.action} at effective risk ${e.decision.effectiveRisk}`,
          observed: e.decision.reason,
        },
      );
    });

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
      /**
       * THE RUN CEILING COMES FROM THE POLICY, which is where §3.4 puts it:
       * `caps.maxRunSeconds` is a declared, reviewable number and this used to
       * ignore it in favour of a hardcoded 120_000. Both defaults are 120s, so
       * the determinism corpus is byte-identical — what changes is that raising
       * the cap in a policy file now actually raises it.
       */
      budgets: { stepMs: 10_000, runMs: policy.caps.maxRunSeconds * 1000 },
      now: () => Date.now(),
      // Absent is absent, not `undefined`: exactOptionalPropertyTypes draws that
      // distinction, and with no --operator the field is simply not there.
      ...(escalate === null ? {} : { escalate }),
      onHandoff: (record) => handoffs.push(record),
    };

    result = await replay(capability, binding, params, deps);
    console.log(JSON.stringify(result, null, 1));

    // A business outcome is a SUCCESS of the system: the caller asked a question
    // and got a legitimate answer. Only a failure is a non-zero exit.
    return result.status === "failed" ? 1 : 0;
  } finally {
    /**
     * EVIDENCE IS WRITTEN WHATEVER HAPPENED, including when `replay()` threw.
     *
     * The exit used to be the last statement of the `try`, and `process.exit()`
     * does not run `finally` blocks — so on every NORMAL run the operator
     * console and the browser were never closed here, and the manifest was
     * written only on the success path. Returning a code and exiting after this
     * block is what makes both happen.
     */
    if (log.all.length === 0) {
      // The sink already appended every line as it was emitted, so this is not a
      // flush. It exists for the one case the sink cannot cover: a run that
      // emitted nothing at all, where `events([])` writes no file and complains
      // loudly rather than leaving the breach silent.
      evidence.events(log.all);
    }
    if (handoffs.length > 0) evidence.handoff(handoffs);

    const artifactContentHash = evidence.artifact(stampVerification(capability, result));
    evidence.manifest({
      runId,
      phase: "replay",
      startedAt,
      endedAt: new Date().toISOString(),
      target,
      tenant: binding.tenant,
      capability: { id: capability.contract.id, version: capability.contract.version },
      artifactContentHash,
      model: { provider: "none", calls: result?.modelCalls ?? 0 },
      // A run that threw has no status of its own, and inventing one would put a
      // result in the manifest that no code path decided.
      result: result?.status ?? "aborted",
      versions: { node: process.versions.node, playwright: "1.63.0" },
    });

    console.log(`\nevidence: ${evidence.directory}`);
    await operator?.close();
    await driver.close();
  }
};

main()
  .then((code) => process.exit(code))
  .catch((e: unknown) => {
    console.error("replay: unhandled error:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
