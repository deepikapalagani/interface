/**
 * `npm run demo` — the whole vertical slice, in one command.
 *
 * §2's through-line, executed end to end: the model discovers, the artifact
 * becomes a reusable capability, and deterministic replay is how an agent invokes
 * it in production.
 *
 *   npm run demo            a real LLM-driven discovery run (needs a key in .env)
 *   npm run demo:offline    the same slice with NO key and NO model, by replaying
 *                           a committed transcript through the cassette
 *
 * THE OFFLINE PATH IS NOT A SIMULATION. It substitutes exactly one thing — the
 * model — and drives the real loop, the real browser, the real mock, the real
 * compiler and the real replay engine. The cassette refuses to keep replaying if
 * the screens it recorded no longer match what the surface produces, so an
 * offline pass is evidence about today's code rather than a recording of a good
 * day. (That guard was itself broken until 2026-09-12: see src/model/cassette.ts.)
 *
 * ── WHY TWO ARTIFACTS APPEAR BELOW ──────────────────────────────────────────
 *
 * The discovered artifact is replayed first, because that round trip IS the
 * headline claim. It cannot demonstrate the three result classes, though: the
 * mechanical compiler records the literal the model typed and declares no inputs,
 * since deciding which literals are really parameters is a separate judgement
 * pass that is not built. So the three-class demonstration uses the committed
 * `lookup@1.0.0` fixture, which declares a typed `member_id`. Stated here rather
 * than glossed, because quietly swapping artifacts would overclaim.
 *
 * Writes nothing into /evidence/ — that tree is a graded deliverable checked by
 * `scripts/verify-evidence.ts`. Everything here goes to a temp directory whose
 * path is printed, so a reviewer can read it.
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { createServer } from "../mock/main.js";
import { tenantA } from "../mock/tenant.js";

const CAPABILITY = "tests/fixtures/lookup@1.0.0.json";
const BINDING = "tests/fixtures/fcu@4.2.json";
/** The recorded run the offline path replays. Committed, so `demo:offline` needs nothing. */
const CASSETTE = "evidence/runs/discovery-lookup-v3/transcript.jsonl";

const MEMBER = "400200101";
const ABSENT = "400299999";

const offline = process.argv.includes("--provider") && process.argv.includes("cassette");

interface Check {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}
const checks: Check[] = [];

const rule = (title: string): void => {
  console.log(`\n${"─".repeat(72)}\n${title}\n${"─".repeat(72)}`);
};

/**
 * Run a CLI exactly as a reviewer would, and report its REAL exit code.
 *
 * Subprocesses rather than imported functions on purpose: the commands in
 * README.md are the thing being demonstrated, so the demo has to exercise them
 * rather than a tidier internal path that a reviewer cannot reproduce.
 *
 * ASYNC, AND THAT IS NOT A STYLE CHOICE. This file hosts the mock IN-PROCESS so
 * it can take an ephemeral port and never collide with a reviewer's own server.
 * `spawnSync` blocks the Node event loop, so the mock could not answer the child
 * that was navigating to it: MEASURED as `page.goto: Timeout 30000ms exceeded`
 * on every single subprocess — a uniform failure that looks like six broken
 * features and is really one blocked event loop.
 *
 * `scripts/verify-determinism.ts` may use `spawnSync` safely because its mock is
 * a separate process on :7101; this one is not.
 */
const cli = (script: string, args: readonly string[]): Promise<{ code: number; out: string }> =>
  new Promise((resolve) => {
    const child = spawn("npx", ["tsx", script, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const collect = (chunk: Buffer | string): void => {
      out += String(chunk);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (e: Error) => resolve({ code: 1, out: `${out}\n${e.message}` }));
    child.on("close", (code: number | null) => resolve({ code: code ?? 1, out }));
  });

const record = (label: string, ok: boolean, detail: string): void => {
  checks.push({ label, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label} — ${detail}`);
};

const statusOf = (out: string): string => /"status": "([a-z_]+)"/.exec(out)?.[1] ?? "(no status)";

const main = async (): Promise<void> => {
  const evidence = mkdtempSync(path.join(tmpdir(), "meridian-demo-"));

  // Port 0: the OS picks a free one, so this never collides with a mock a
  // reviewer already has running on 7101.
  const server: Server = createServer(tenantA);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const target = `http://localhost:${port}/`;

  console.log(`MERIDIAN MSC demo — ${offline ? "OFFLINE (cassette: no key, no model, no cost)" : "LIVE MODEL"}`);
  console.log(`  mock:     ${target}`);
  console.log(`  evidence: ${evidence}`);

  try {
    /* ---- 1. DISCOVER ------------------------------------------------------- */
    rule("1. DISCOVERY — a model drives the app and a capability is compiled from the trace");

    const discovery = await cli("src/discover/main.ts", [
      ...(offline ? ["--provider", "cassette", "--from", CASSETTE] : []),
      "--goal", `Look up member ${MEMBER}`,
      "--target", target,
      "--binding", BINDING,
      "--capability-id", "msc.member.lookup",
      "--run-id", "demo-discovery",
      "--evidence", evidence,
    ]);
    console.log(discovery.out.trimEnd());
    record(
      "discovery reached the goal and compiled an artifact",
      discovery.code === 0 && discovery.out.includes("compiled"),
      `exit ${discovery.code}`,
    );

    /* ---- 2. REPLAY WHAT WAS JUST DISCOVERED -------------------------------- */
    rule("2. ROUND TRIP — replaying the artifact that discovery just produced, with no model");

    const discovered = path.join(evidence, "demo-discovery", "capability.json");
    const roundTrip = await cli("src/replay/main.ts", [
      "--capability", discovered,
      "--binding", BINDING,
      "--target", target,
      "--evidence", evidence,
      "--run-id", "demo-roundtrip",
    ]);
    record(
      "the discovered artifact replays deterministically",
      roundTrip.code === 0 && statusOf(roundTrip.out) === "success",
      `status ${statusOf(roundTrip.out)}, exit ${roundTrip.code}`,
    );
    record(
      "replay used NO model",
      /"modelCalls": 0/.test(roundTrip.out),
      "modelCalls 0 — the claim the whole replay path rests on",
    );

    /* ---- 3. THE THREE RESULT CLASSES --------------------------------------- */
    rule("3. THE THREE RESULT CLASSES — kept distinct, which §3.3 calls the most common design mistake");

    const success = await cli("src/replay/main.ts", [
      "--capability", CAPABILITY, "--binding", BINDING, "--target", target,
      "--input", `member_id=${MEMBER}`, "--evidence", evidence, "--run-id", "demo-success",
    ]);
    record("expected business outcome: a member that exists", statusOf(success.out) === "success", `status ${statusOf(success.out)}, exit ${success.code}`);

    const notFound = await cli("src/replay/main.ts", [
      "--capability", CAPABILITY, "--binding", BINDING, "--target", target,
      "--input", `member_id=${ABSENT}`, "--evidence", evidence, "--run-id", "demo-not-found",
    ]);
    record(
      "NOT a failure: no such member is a business outcome, and exits 0",
      statusOf(notFound.out) === "business_outcome" && notFound.code === 0,
      `status ${statusOf(notFound.out)}, exit ${notFound.code}`,
    );

    const badInput = await cli("src/replay/main.ts", [
      "--capability", CAPABILITY, "--binding", BINDING, "--target", target,
      "--input", "member_id=abc", "--evidence", evidence, "--run-id", "demo-bad-input",
    ]);
    record(
      "a hard failure exits 1 and still leaves a readable log",
      statusOf(badInput.out) === "failed" && badInput.code === 1,
      `status ${statusOf(badInput.out)}, exit ${badInput.code}`,
    );

    /* ---- 4. SUMMARY -------------------------------------------------------- */
    rule("SUMMARY");
    const failed = checks.filter((c) => !c.ok);
    for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.label}`);
    console.log(`\n  evidence written to ${evidence}`);
    console.log("  §3.6 handoff is not exercised here: it needs a person, or the headless proof in");
    console.log("  tests/handoff.integration.test.ts. To drive it by hand:");
    console.log("    npm run replay -- --headed --operator --policy tests/fixtures/policy-escalate.json \\");
    console.log(`      --capability ${CAPABILITY} --binding ${BINDING} --input member_id=${MEMBER}`);

    if (failed.length > 0) {
      console.error(`\ndemo: FAILED — ${failed.length} of ${checks.length} check(s) did not hold.`);
      process.exit(1);
    }
    console.log(`\ndemo: OK — ${checks.length} checks, the full slice, ${offline ? "with no model at all." : "one real model-driven run."}`);
  } finally {
    server.close();
  }
};

main().catch((e: unknown) => {
  console.error("demo: unhandled error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
