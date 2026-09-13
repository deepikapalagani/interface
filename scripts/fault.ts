/**
 * `npm run mock:fault` — arm a deterministic fault, and CHECK what replay does with it.
 *
 * The three faults exist so that "recoverable condition" and "hard failure" are
 * things a reviewer can RUN rather than read about. Each is armed explicitly,
 * fires on a stated condition, and then disarms itself; none is probabilistic,
 * because a lucky replay must never be able to pass.
 *
 *   npm run mock:fault -- --list
 *   npm run mock:fault -- --arm abend_after_commit
 *   npm run mock:fault -- --run  abend_after_commit     # arms it, replays, COMPARES
 *   npm run mock:fault -- --status
 *   npm run mock:fault -- --clear
 *
 * ── THIS FILE IS THE ONLY PLACE THAT SAYS WHAT REPLAY RETURNS ───────────────
 *
 * It used to be one of three. `scripts/fault.ts`, `README.md` and `mock/seed.ts`
 * each carried their own copy of "what `broadcast` does", all three said the run
 * SUCCEEDS by dismissing the alert, and all three were wrong: the engine applied
 * `plan.recovery[]` only at a step's precondition, and this dialog arrives on the
 * CARD SERVICES render — i.e. at s04's POSTCONDITION — so it came back
 * `failed / postcondition_failed` with `recoveries: []`. The repo's own test
 * suite recorded the mechanism as unreachable while three reviewer-facing
 * surfaces promised it worked.
 *
 * Triplication was the real defect, so it is gone rather than updated: `mock/seed.ts`
 * describes what the APP does, README points here, and the expectations below are
 * the single copy — which `--run` then COMPARES against a real replay. An
 * expectation nobody compares against is how the three copies drifted in the
 * first place.
 *
 * IT MUST FAIL LOUDLY. An unknown fault name or an unreachable server exits
 * non-zero and says which URL it tried; `--run` exits non-zero on any mismatch
 * and names the mechanism the expectation rested on. A fault demo that silently
 * armed nothing, or that printed an expectation nobody checked, would "pass"
 * while proving the opposite of what it claims.
 *
 * Arming is a deliberate act by a person at a terminal, and it is worth being
 * precise about what enforces that, because the obvious answer is the wrong one.
 * NOT `deniedRoutes: ["/__admin"]`: that rule is evaluated against the page an
 * action is issued FROM rather than where it lands, so it is a declared intent.
 * What actually stops a capability arming its own faults is that no verb in
 * `SurfaceAction` can POST to an arbitrary URL — navigate, click, fill, press and
 * the two dialog verbs are the whole set — and no screen the mock renders carries
 * a control reaching `/__admin`. README and REPORT state it the same way.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAULTS, isFaultName, type FaultName } from "../mock/seed.js";
import type { FailureKind, Remediation, SideEffectRisk } from "../src/contract/result.js";

const DEFAULT_TARGET = "http://localhost:7101/";

/** Generous, and bounded: a queued native dialog can block every page-touching call. */
const DEFAULT_RUN_TIMEOUT_MS = 240_000;

/**
 * What the replay is expected to return, and what the APP's own trail should
 * hold afterwards. Both halves are compared by `--run`.
 *
 * The audit half is the independent one: it is written by the application, not
 * by the run, so "nothing committed" is established by the app's silence rather
 * than by the automation's own report of itself.
 */
type ExpectedResult =
  | { readonly status: "success" }
  | { readonly status: "business_outcome" }
  | {
      readonly status: "failed";
      readonly kind: FailureKind;
      readonly remediation: Remediation;
      readonly sideEffectRisk: SideEffectRisk;
    }
  /** replay() raised instead of returning one of the three classes. */
  | { readonly throws: string };

interface Expectation {
  readonly result: ExpectedResult;
  /** The app's audit trail after the run. */
  readonly audit: "empty" | "one APPLIED row";
  /** The mechanism this rests on, named so a MISMATCH points somewhere specific. */
  readonly because: string;
}

/**
 * MEASURED against this tree, by running `--run <name>` and reading what came
 * back. TWO OF THE THREE PASS. `broadcast` does not, and its expectation states
 * the DESIGNED behaviour deliberately rather than the observed one — see its
 * `because`.
 *
 * That choice is the whole design of this file. Declaring the observed hang as
 * the expectation would let `--run broadcast` print PASS while the third result
 * class does not work end to end, and a fault demo that passes on a hang is
 * worse than no fault demo. So the command fails loudly, names the mechanism,
 * and the gap is carried in README and in REPORT's Known gaps rather than being
 * absorbed into a green tick.
 *
 * When one of these stops matching, that is the point rather than an
 * inconvenience: `--run` exits non-zero and names what the expectation rested
 * on, so a drifted engine surfaces as a failed command instead of a catalogue
 * that quietly went stale. All three expectations were rewritten during this
 * pass as the engine moved underneath them — which is exactly the drift the
 * three duplicated prose copies of these claims used to hide.
 */
const EXPECTATION: Readonly<Record<FaultName, Expectation>> = {
  broadcast: {
    result: { status: "success" },
    audit: "one APPLIED row",
    because:
      "THE DESIGNED BEHAVIOUR, AND IT DOES NOT HOLD RELIABLY TODAY — this entry is expected to MISMATCH. This alert arrives on the CARD SERVICES render, i.e. at s04's POSTCONDITION, so it passes only if plan.recovery[] is applied wherever a recoverable condition is CLASSIFIED rather than only in the precondition loop. Half of that landed on 2026-09-13: `applyRecovery` is now one helper called at all three observation points (precondition, postcondition, capability checkpoint), where before it returned failed/postcondition_failed with recoveries: []. The other half did not: a queued native dialog can still block the driver's page-touching calls. MEASURED three times on the same tree — one run completed with success and one APPLIED row, two did not return within 240_000ms and 420_000ms respectively, audit empty, the second on a freshly started mock with nothing else running. An intermittent pass is not a working mechanism, so this stays declared as success and stays red until a queued dialog is bounded everywhere it can arrive.",
  },
  confirm_submit: {
    result: {
      status: "failed",
      kind: "undeclared_dialog",
      remediation: "reconcile_required",
      sideEffectRisk: "unknown",
    },
    audit: "empty",
    because:
      "Two independent halves. The GUARANTEE is the empty audit trail: an undeclared confirm() cancels the submit, so nothing commits, and it is the app's own silence that proves it rather than the automation's report of itself. The RESULT is `undeclared_dialog`, which until 2026-09-13 was a FailureKind nothing could produce — the queued dialog blocked the Playwright call until a 30s timeout and the exception escaped replay() untyped, writing no run directory at all. The driver now checks `pendingDialog` before page-touching calls and answers the blocked step with its own kind. `reconcile_required` / `unknown` beside an EMPTY trail is deliberate and not a contradiction: the engine issued a click at a step that can commit and cannot observe that the dialog cancelled it, so it refuses to promise nothing happened. Establishing that is what /screen/audit is for.",
  },
  abend_after_commit: {
    result: {
      status: "failed",
      kind: "postcondition_failed",
      remediation: "reconcile_required",
      sideEffectRisk: "unknown",
    },
    audit: "one APPLIED row",
    because:
      "The change LANDED and the caller was shown SYS0500, which cannot say so. The run-scoped `committed` flag is what turns this into reconcile_required / unknown rather than an invitation to retry a card that is already frozen (src/replay/executor.ts).",
  },
};

const argv = process.argv.slice(2);

const flag = (name: string): boolean => argv.includes(`--${name}`);

const value = (name: string): string | null => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return null;
  const next = argv[i + 1];
  return next === undefined || next.startsWith("--") ? "" : next;
};

/**
 * The explicit type annotation is load-bearing, not decoration: TypeScript only
 * narrows control flow past a `never`-returning call when the callee's type is
 * declared on the binding. Without it, `if (!isFaultName(arm)) die(...)` leaves
 * `arm` a plain string below, and the keyed lookup stops compiling.
 */
const die: (message: string, code?: number) => never = (message, code = 1) => {
  console.error(`mock:fault: ${message}`);
  process.exit(code);
};

const target = (): string => {
  const raw = value("target") ?? DEFAULT_TARGET;
  if (raw === "") die("--target needs a URL", 2);
  try {
    return new URL(raw).toString();
  } catch {
    return die(`--target ${JSON.stringify(raw)} is not a URL`, 2);
  }
};

/**
 * The card capability, located rather than hardcoded.
 *
 * The flagship artifact's filename is not this script's to fix, so it is found by
 * its contract id. If it is not there yet, the command is printed with an obvious
 * placeholder and a note — never with a guessed path that would fail confusingly.
 */
const FIXTURES = fileURLToPath(new URL("../tests/fixtures", import.meta.url));
const REPO = fileURLToPath(new URL("..", import.meta.url));

const cardCapability = (): string | null => {
  if (!fs.existsSync(FIXTURES)) return null;
  for (const entry of fs.readdirSync(FIXTURES).sort()) {
    if (!entry.endsWith(".json")) continue;
    const full = path.join(FIXTURES, entry);
    if (/"id":\s*"msc\.card\.set_status"/.test(fs.readFileSync(full, "utf8"))) {
      return path.relative(REPO, full);
    }
  }
  return null;
};

/**
 * `agent: false`, so every admin call opens a fresh socket — and NOT `fetch`.
 *
 * MEASURED here on 2026-09-13, and the symptom reads as a stopped server: with
 * pooled connections, the `/__admin/state` call made straight after the replay
 * subprocess returns fails with a bare "fetch failed". `spawnSync` blocks this
 * process's event loop for the whole replay, so it cannot notice the mock
 * closing an idle keep-alive connection, and the next call reuses a socket that
 * is already gone. `scripts/verify-determinism.ts` hit the identical thing as
 * `read ECONNRESET` and solved it the same way. A retry would paper over it; not
 * pooling removes it, and leaves a network error meaning what it says.
 *
 * http, not https: the target is a local mock. An https URL fails loudly here
 * rather than being silently downgraded.
 */
const request = (url: string, method: "GET" | "POST", body?: string): Promise<{ status: number; text: string }> =>
  new Promise((resolve, reject) => {
    const headers = body === undefined
      ? {}
      : { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) };
    const req = http.request(url, { method, agent: false, headers }, (res) => {
      let out = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        out += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: out }));
    });
    req.on("error", (e: Error) => reject(e));
    if (body !== undefined) req.write(body);
    req.end();
  });

const call = async (url: string, init?: { method?: "GET" | "POST"; json?: unknown }): Promise<unknown> => {
  let response: { status: number; text: string };
  try {
    response = await request(
      url,
      init?.method ?? "GET",
      init?.json === undefined ? undefined : JSON.stringify(init.json),
    );
  } catch (error: unknown) {
    // Naming the URL matters: a checker that reports only "fetch failed" is how a
    // stopped server gets mistaken for a broken script.
    return die(
      `cannot reach ${url} — ${error instanceof Error ? error.message : String(error)}\n` +
        `  is the mock running?  npm run mock`,
    );
  }
  let body: unknown = null;
  try {
    body = JSON.parse(response.text);
  } catch {
    body = null;
  }
  if (response.status < 200 || response.status >= 300) {
    const detail = body && typeof body === "object" ? JSON.stringify(body) : `HTTP ${response.status}`;
    return die(`${url} refused: ${detail}`);
  }
  return body;
};

const armedFaultOf = (state: unknown): string => {
  if (state !== null && typeof state === "object" && "armedFault" in state) {
    const armed = (state as { armedFault: unknown }).armedFault;
    return typeof armed === "string" ? armed : "none";
  }
  return "unknown";
};

/** Arm it, and refuse to claim it is armed unless the SERVER says so. */
const arm = async (name: FaultName, base: string): Promise<void> => {
  const body = await call(new URL("__admin/fault", base).toString(), { method: "POST", json: { fault: name } });
  const armed = armedFaultOf(body);
  if (armed !== name) die(`the server reports the armed fault as ${armed}, not ${name} — refusing to claim it is armed`);
};

const describeResult = (e: ExpectedResult): string => {
  if ("throws" in e) return `replay() THROWS (message contains ${JSON.stringify(e.throws)}), no result, no run directory`;
  if (e.status === "failed") return `failed / ${e.kind}, remediation ${e.remediation}, sideEffectRisk ${e.sideEffectRisk}`;
  return e.status;
};

const usage = (): void => {
  console.log("usage: npm run mock:fault -- [--list | --arm <name> | --run <name> | --clear | --status] [--target <url>] [--timeout <ms>]");
  console.log(`  --target defaults to ${DEFAULT_TARGET}`);
};

/* ------------------------------------------------------------------- --run */

interface Observed {
  readonly status: string | null;
  readonly kind: string | null;
  readonly remediation: string | null;
  readonly sideEffectRisk: string | null;
  readonly threw: string | null;
  readonly exitCode: number;
  readonly evidenceDir: string;
}

/**
 * Run the replay exactly as a reviewer would, into a TEMP evidence directory.
 *
 * `spawnSync` is safe here for the reason it is safe in verify-determinism and
 * not in demo.ts: the mock is a separate process, so blocking this event loop
 * cannot stop it answering.
 */
const replayOnce = (capability: string, base: string, timeoutMs: number): Observed => {
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), "mock-fault-"));
  const proc = spawnSync(
    "npx",
    [
      "tsx", "src/replay/main.ts",
      "--capability", capability,
      "--binding", "tests/fixtures/fcu@4.2.json",
      "--target", base,
      "--evidence", evidenceDir,
      "--run-id", "fault-run",
      "--input", "member_id=400200101",
      "--input", "card_last4=4021",
      "--input", "action=FREEZE",
    ],
    { encoding: "utf8", timeout: timeoutMs, cwd: REPO },
  );

  const stdout = proc.stdout ?? "";
  const stderr = proc.stderr ?? "";

  if (proc.error) {
    return { status: null, kind: null, remediation: null, sideEffectRisk: null, threw: `the replay process could not run or was killed: ${proc.error.message}`, exitCode: proc.status ?? -1, evidenceDir };
  }

  // The result JSON is everything stdout printed before the `evidence:` line.
  const head = stdout.split("\nevidence:")[0] ?? "";
  try {
    const parsed = JSON.parse(head) as Record<string, unknown>;
    const str = (k: string): string | null => (typeof parsed[k] === "string" ? (parsed[k] as string) : null);
    return {
      status: str("status"),
      kind: str("kind"),
      remediation: str("remediation"),
      sideEffectRisk: str("sideEffectRisk"),
      threw: null,
      exitCode: proc.status ?? -1,
      evidenceDir,
    };
  } catch {
    const line = /replay: unhandled error: (.*)/.exec(stderr)?.[1] ?? stderr.trim().split("\n").slice(-1)[0] ?? "(no message)";
    return { status: null, kind: null, remediation: null, sideEffectRisk: null, threw: line, exitCode: proc.status ?? -1, evidenceDir };
  }
};

interface AuditRowish {
  readonly outcome?: unknown;
  readonly confirmation?: unknown;
}

const auditOf = (state: unknown): { readonly rows: readonly AuditRowish[]; readonly shape: string } => {
  const rows =
    state !== null && typeof state === "object" && Array.isArray((state as { audit?: unknown }).audit)
      ? ((state as { audit: AuditRowish[] }).audit)
      : [];
  if (rows.length === 0) return { rows, shape: "empty" };
  if (rows.length === 1 && rows[0]?.outcome === "APPLIED") return { rows, shape: "one APPLIED row" };
  return { rows, shape: `${rows.length} row(s): ${rows.map((r) => String(r.outcome)).join(", ")}` };
};

const runFault = async (name: FaultName, base: string, timeoutMs: number): Promise<void> => {
  const expectation = EXPECTATION[name];
  const capability = cardCapability();
  if (capability === null) {
    die('no artifact declaring "msc.card.set_status" was found under tests/fixtures, so there is nothing to replay');
  }

  const spec = FAULTS.find((f) => f.name === name);

  // Reset FIRST. The audit half of the expectation is meaningless against a
  // trail left behind by something else, and a fault must be armed AFTER its own
  // reset because reset clears any armed fault.
  await call(new URL("__admin/reset", base).toString(), { method: "POST" });
  await arm(name, base);

  console.log(`mock:fault: --run ${name}  (${base})`);
  console.log(`  fires:  ${spec?.fires ?? "(no description)"}`);
  console.log(`  expect: ${describeResult(expectation.result)}`);
  console.log(`          audit ${expectation.audit}`);
  console.log("  replaying (no model, temp evidence) ...");

  const observed = replayOnce(capability, base, timeoutMs);
  const state = await call(new URL("__admin/state", base).toString());
  const audit = auditOf(state);

  const mismatches: string[] = [];

  if ("throws" in expectation.result) {
    if (observed.threw === null) {
      mismatches.push(`expected replay() to throw, but it returned status ${JSON.stringify(observed.status)} (exit ${observed.exitCode})`);
    } else if (!observed.threw.includes(expectation.result.throws)) {
      mismatches.push(`expected the thrown message to contain ${JSON.stringify(expectation.result.throws)}, got ${JSON.stringify(observed.threw)}`);
    }
  } else if (observed.threw !== null) {
    mismatches.push(`expected status ${expectation.result.status}, but replay() threw: ${observed.threw}`);
  } else {
    if (observed.status !== expectation.result.status) {
      mismatches.push(`expected status ${expectation.result.status}, got ${JSON.stringify(observed.status)}`);
    }
    if (expectation.result.status === "failed") {
      if (observed.kind !== expectation.result.kind) mismatches.push(`expected kind ${expectation.result.kind}, got ${JSON.stringify(observed.kind)}`);
      if (observed.remediation !== expectation.result.remediation) mismatches.push(`expected remediation ${expectation.result.remediation}, got ${JSON.stringify(observed.remediation)}`);
      if (observed.sideEffectRisk !== expectation.result.sideEffectRisk) mismatches.push(`expected sideEffectRisk ${expectation.result.sideEffectRisk}, got ${JSON.stringify(observed.sideEffectRisk)}`);
    }
  }

  if (audit.shape !== expectation.audit) {
    mismatches.push(`expected the app's audit trail to be ${expectation.audit}, found ${audit.shape}`);
  }

  console.log("");
  console.log(`  observed: ${observed.threw !== null ? `THREW ${JSON.stringify(observed.threw)}` : `status ${observed.status ?? "(none)"}${observed.kind ? ` / ${observed.kind}` : ""}${observed.remediation ? `, ${observed.remediation}, ${observed.sideEffectRisk ?? "?"}` : ""}`} (exit ${observed.exitCode})`);
  console.log(`  audit:    ${audit.shape}`);
  console.log(`  evidence: ${observed.evidenceDir}`);

  if (mismatches.length > 0) {
    console.error("");
    console.error(`mock:fault: MISMATCH on ${name} — what this tree does is not what this file declares.`);
    for (const m of mismatches) console.error(`  ${m}`);
    console.error(`  the expectation rests on: ${expectation.because}`);
    console.error("  Either the mechanism regressed, or the expectation above is stale. Both are defects; neither is a pass.");
    process.exit(1);
  }

  console.log("");
  console.log(`mock:fault: PASS — ${name} behaved exactly as declared, in the result AND in the app's own audit trail.`);
};

/* -------------------------------------------------------------------- main */

const main = async (): Promise<void> => {
  if (flag("list")) {
    console.log("Deterministic faults. Each is armed explicitly, fires ONCE on its condition, then disarms itself.");
    console.log("Reset (POST /__admin/reset) clears any armed fault, so the determinism corpus cannot be polluted.");
    console.log("`--run <name>` arms one, replays the card capability against it, and COMPARES the outcome with what is declared here.\n");
    for (const f of FAULTS) {
      const e = EXPECTATION[f.name];
      console.log(`  ${f.name}`);
      console.log(`      fires:  ${f.fires}`);
      console.log(`      proves: ${f.proves}`);
      console.log(`      replay: ${describeResult(e.result)}`);
      console.log(`      audit:  ${e.audit}`);
      console.log(`      why:    ${e.because}\n`);
    }
    return;
  }

  const base = target();
  const timeoutRaw = value("timeout");
  const timeoutMs = timeoutRaw === null || timeoutRaw === "" ? DEFAULT_RUN_TIMEOUT_MS : Number(timeoutRaw);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) die("--timeout needs a positive number of milliseconds", 2);

  if (flag("status")) {
    const state = await call(new URL("__admin/state", base).toString());
    console.log(`mock:fault: armed fault is ${armedFaultOf(state)}  (${base})`);
    return;
  }

  if (flag("clear")) {
    const body = await call(new URL("__admin/fault", base).toString(), { method: "POST", json: { fault: "none" } });
    console.log(`mock:fault: cleared — armed fault is now ${armedFaultOf(body)}  (${base})`);
    return;
  }

  const run = value("run");
  if (run !== null) {
    if (run === "") die("--run needs a fault name; run --list to see them", 2);
    if (!isFaultName(run)) {
      die(`unknown fault ${JSON.stringify(run)}\n  known: ${FAULTS.map((f) => f.name).join(", ")}`, 2);
    }
    await runFault(run, base, timeoutMs);
    return;
  }

  const armName = value("arm");
  if (armName === null) {
    usage();
    process.exit(2);
  }
  if (armName === "") die("--arm needs a fault name; run --list to see them", 2);
  if (!isFaultName(armName)) {
    // Refused HERE as well as by the server, so a typo costs nothing and the
    // legal set is always in front of the person who mistyped it.
    die(`unknown fault ${JSON.stringify(armName)}\n  known: ${FAULTS.map((f) => f.name).join(", ")}`, 2);
  }

  await arm(armName, base);

  const spec = FAULTS.find((f) => f.name === armName);
  const capability = cardCapability();
  const expectation = EXPECTATION[armName];

  console.log(`mock:fault: ARMED ${armName}  (${base})`);
  console.log(`  fires:  ${spec?.fires ?? "(no description)"}`);
  console.log(`  proves: ${spec?.proves ?? "(no description)"}`);
  console.log("");
  console.log("  Run it:");
  console.log(
    `    npm run replay -- --capability ${capability ?? "<the msc.card.set_status artifact>"} \\\n` +
      `      --binding tests/fixtures/fcu@4.2.json --target ${base} \\\n` +
      `      --evidence "$(mktemp -d)" \\\n` +
      `      --input member_id=400200101 --input card_last4=4021 --input action=FREEZE`,
  );
  if (capability === null) {
    console.log("");
    console.log("  NOTE: no artifact declaring \"msc.card.set_status\" was found under tests/fixtures,");
    console.log("        so the --capability path above is a placeholder rather than a real file.");
  }
  console.log("");
  console.log(`  Expect: ${describeResult(expectation.result)}`);
  console.log(`          audit ${expectation.audit}`);
  console.log(`  Or have it checked for you:  npm run mock:fault -- --run ${armName}`);
  console.log("  Then:   open /screen/audit — the app's own record of what actually committed.");
};

main().catch((error: unknown) => {
  console.error(`mock:fault: unhandled error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
