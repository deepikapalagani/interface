/**
 * "Replay is deterministic" — measured, not claimed.
 *
 * §3.3 requires the same artifact and the same inputs to produce the same run.
 * That is a property of two runs, so it cannot be asserted from inside one of
 * them: it has to be observed by running twice and diffing.
 *
 * THE PROPERTY IS `reset -> run` VERSUS `reset -> run`, NOT `run` versus `run`.
 * DECISIONS.md records why that distinction is written down rather than assumed:
 * the check that first exposed the per-request virtual clock compared a page
 * fetched mid-run against one fetched immediately after a reset, which was never
 * the determinism property. A wrong test found a real design flaw and was nearly
 * dismissed as a broken assertion. So this script resets the app before EACH of
 * the two runs, captures the post-reset state both times, and fails if those two
 * starting points differ — otherwise "the runs matched" would only mean the
 * second run inherited the first one's leftovers.
 *
 * What is compared is the evidence a reviewer would actually read, after
 * projecting away what legitimately varies between two identical runs. That list
 * is measured, not guessed (see VOLATILE_*), and the event projection is checked
 * against `EventSequencer.projectForDiff` at runtime so the two cannot drift.
 *
 * Three guards against a vacuous pass, because a differ that compares nothing
 * also reports success:
 *
 *   - the projection is proven to agree with the code it mirrors, and to drop
 *     exactly two fields rather than everything inconvenient;
 *   - the raw bytes must DIFFER before projection, and the scenarios must cover
 *     all three §3.3 result classes with a floor on the event lines compared;
 *   - `--self-test` plants real divergences into a real corpus and asserts the
 *     comparator rejects each one, so the check is proven live rather than
 *     assumed to be.
 *
 * Replay runs no model, so running it twice costs nothing. Discovery is never
 * invoked from here.
 *
 * ── THE CHECKER BRINGS ITS OWN MOCK ─────────────────────────────────────────
 *
 * It used to hardcode http://localhost:7101/ with no override, which is the
 * worst failure mode a determinism gate can have: after any change to mock/ it
 * reported green against whatever OLD code happened to still be listening on
 * that port, and the greener the result the less it meant. So it now spawns its
 * own mock from mock/main.ts IN THIS TREE, on an ephemeral port, and kills it in
 * a `finally`. The gate therefore tests the code in the working copy and needs
 * nobody to have started anything.
 *
 * `--target <url>` opts back into an external server, and the OK line says so in
 * capitals — a green against a server this checker did not start is a different
 * claim, and it must not read like the default one.
 *
 * `spawnSync` for the REPLAY children stays safe for the reason it always was:
 * the mock is a separate process, so blocking this event loop cannot stop it
 * answering. (`scripts/demo.ts` hosts its mock in-process and must therefore use
 * async `spawn`; the two scripts differ for that measured reason, not by taste.)
 *
 * Run: npx tsx scripts/verify-determinism.ts [--self-test] [--target <url>]
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { EventSequencer } from "../src/evidence/events.js";

/** An external server to test INSTEAD of spawning one. Null means "bring your own". */
const externalTarget = (): string | null => {
  const i = process.argv.indexOf("--target");
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (value === undefined || value.startsWith("--")) return null;
  return value.endsWith("/") ? value : `${value}/`;
};

const CAPABILITY = "tests/fixtures/lookup@1.0.0.json";
/** The mutating capability — the only one here whose run changes the app's state. */
const CARD_CAPABILITY = "tests/fixtures/set_status@1.0.0.json";
const BINDING = "tests/fixtures/fcu@4.2.json";

/** Generous: the child pays `npx tsx` startup before it can bind a port. */
const MOCK_START_TIMEOUT_MS = 30_000;

/**
 * All three §3.3 result classes, because determinism of the happy path alone
 * would say nothing about the one the spec calls the most common design mistake:
 * a legitimate "no such member" must come back the same way every time, and as a
 * business outcome rather than a failure.
 */
interface Scenario {
  readonly name: string;
  readonly inputs: readonly string[];
  /** The class this scenario exists to cover. Asserted — see COVERAGE below. */
  readonly expect: "success" | "business_outcome" | "failed";
  /**
   * Defaults to CAPABILITY. Present only on a scenario that needs a different
   * artifact, so the three read-only scenarios below are untouched by its
   * addition — which is what keeps this change from silently re-baselining the
   * corpus it is supposed to be checking.
   */
  readonly capability?: string;
}

const SCENARIOS: readonly Scenario[] = [
  { name: "found", inputs: ["member_id=400200101"], expect: "success" },
  { name: "not-found", inputs: ["member_id=400299999"], expect: "business_outcome" },
  { name: "bad-input", inputs: ["member_id=abc"], expect: "failed" },
  /**
   * THE FIRST SCENARIO WHOSE RUN CHANGES THE APP.
   *
   * Everything above it is read-only, so `preState` and `postState` were two
   * copies of one constant and `compare()`'s app-state arm could not fail: it
   * was live code pointed at something that never moved. This run freezes a card
   * — the card status flips, an APPLIED row is appended, the confirmation
   * counter advances — so "the run's own effect on the app is reproducible"
   * becomes a claim with content.
   *
   * FREEZE and not LOST_STOLEN deliberately. The capability is `reversible`, the
   * shipped policy allows `reversible`, and so no human turn can enter the
   * determinism corpus. An irreversible capability would escalate, and a corpus
   * containing a person's timing is not a corpus about replay.
   */
  {
    name: "card-freeze",
    capability: CARD_CAPABILITY,
    inputs: ["member_id=400200101", "card_last4=4021", "action=FREEZE"],
    expect: "success",
  },
];

/**
 * MEASURED, not assumed. Two replay runs of the same capability differ in exactly
 * these fields and nothing else; anything else that varies is a defect this
 * script exists to catch, so the lists stay this short deliberately.
 */
const VOLATILE_EVENT_FIELDS = ["at", "runId"] as const;
const VOLATILE_MANIFEST_FIELDS = ["runId", "startedAt", "endedAt"] as const;
const VOLATILE_RESULT_FIELDS = ["runId"] as const;

/**
 * Absolute paths reach stdout only on the `evidence: <dir>` line, which is
 * dropped by parsing the result JSON out of stdout rather than diffing stdout.
 * No duration is persisted anywhere — `SettleResult.elapsedMs` is never logged —
 * so there is nothing further to project.
 */

/** Floor on the corpus, so "two logs matched" cannot mean "two empty logs matched". */
const MIN_EVENT_LINES = 4;

const RUN_TIMEOUT_MS = 90_000;
const MAX_DIFF_LINES = 12;

interface Difference {
  readonly what: string;
  readonly detail: readonly string[];
}

/** One run's evidence, reduced to what two identical runs must agree on. */
interface Corpus {
  readonly events: readonly string[];
  readonly manifest: string | null;
  readonly capability: string | null;
  readonly result: string | null;
  readonly status: string | null;
  readonly exitCode: number;
  readonly files: readonly string[];
  readonly preState: string;
  readonly postState: string;
  readonly rawEvents: string;
  readonly dir: string;
}

/* --------------------------------------------------------------- projection */

const withoutKeys = (value: unknown, drop: readonly string[]): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!drop.includes(k)) out[k] = v;
  }
  return out;
};

const projectLines = (body: string, drop: readonly string[]): string[] =>
  body
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.stringify(withoutKeys(JSON.parse(l), drop)));

/**
 * Guard 1. `projectForDiff` lives in src/evidence/events.ts as a destructuring
 * expression, so a field added there could silently stop being projected here.
 * Rather than trust the comment, drive the real sequencer and compare key sets.
 */
const projectionAgreesWithCode = (): string | null => {
  const log = new EventSequencer({
    runId: "projection-probe",
    phase: "replay",
    now: () => "1970-01-01T00:00:00.000Z",
    controlOwner: () => "automation",
  });
  const raw = log.emit("probe", { as: "artifact_step", capability: "c", version: "1", stepRef: "s01" }, {
    observed: "probe",
    detail: { probe: true },
  });
  const projected = log.projectForDiff()[0];
  if (!projected) return "EventSequencer.projectForDiff returned nothing for an emitted event.";

  const dropped = Object.keys(raw).filter((k) => !Object.keys(projected).includes(k));
  const expected = [...VOLATILE_EVENT_FIELDS];
  if (dropped.join(",") !== expected.join(",")) {
    return `projectForDiff drops [${dropped.join(", ")}] but this script projects [${expected.join(", ")}] — they have drifted.`;
  }
  if (Object.keys(projected).length < 5) {
    return `projectForDiff kept only ${Object.keys(projected).length} field(s) — a projection that keeps almost nothing cannot detect a divergence.`;
  }
  return null;
};

/* -------------------------------------------------------------------- diffs */

/** Flatten to leaf paths so a disagreement is reported as a path, not as two blobs. */
const flatten = (value: unknown, prefix: string, into: Map<string, string>): void => {
  if (Array.isArray(value)) {
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, into));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flatten(v, prefix ? `${prefix}.${k}` : k, into);
    }
    return;
  }
  into.set(prefix, JSON.stringify(value));
};

const diffJson = (a: string, b: string, label: string): string[] => {
  const left = new Map<string, string>();
  const right = new Map<string, string>();
  flatten(JSON.parse(a), label, left);
  flatten(JSON.parse(b), label, right);

  const out: string[] = [];
  for (const key of new Set([...left.keys(), ...right.keys()])) {
    const l = left.get(key) ?? "(absent)";
    const r = right.get(key) ?? "(absent)";
    if (l !== r) out.push(`${key}: A=${l}  B=${r}`);
  }
  return out.slice(0, MAX_DIFF_LINES);
};

const diffLines = (a: readonly string[], b: readonly string[]): string[] => {
  const out: string[] = [];
  if (a.length !== b.length) out.push(`line count: A=${a.length}  B=${b.length}`);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const l = a[i];
    const r = b[i];
    if (l === r) continue;
    if (l === undefined || r === undefined) {
      out.push(`line ${i + 1}: ${l === undefined ? "absent in A" : "absent in B"}`);
      continue;
    }
    out.push(`line ${i + 1}:`);
    for (const d of diffJson(l, r, `line${i + 1}`)) out.push(`  ${d}`);
  }
  return out.slice(0, MAX_DIFF_LINES);
};

const compare = (a: Corpus, b: Corpus): Difference[] => {
  const out: Difference[] = [];

  if (a.preState !== b.preState) {
    out.push({
      what: "post-reset app state (the two runs did not start from the same place)",
      detail: diffJson(a.preState, b.preState, "state"),
    });
  }
  if (a.files.join(",") !== b.files.join(",")) {
    out.push({ what: "evidence file set", detail: [`A=[${a.files.join(", ")}]`, `B=[${b.files.join(", ")}]`] });
  }
  if (a.exitCode !== b.exitCode) {
    out.push({ what: "exit code", detail: [`A=${a.exitCode}  B=${b.exitCode}`] });
  }
  if (a.capability !== b.capability) {
    out.push({
      what: "capability.json (byte comparison — nothing in it may vary)",
      detail: a.capability && b.capability ? diffJson(a.capability, b.capability, "capability") : ["one run wrote no capability.json"],
    });
  }
  if (a.manifest !== b.manifest) {
    out.push({
      what: "manifest.json (projected)",
      detail: a.manifest && b.manifest ? diffJson(a.manifest, b.manifest, "manifest") : ["one run wrote no manifest.json"],
    });
  }
  if (a.events.join("\n") !== b.events.join("\n")) {
    out.push({ what: "events.jsonl (projected)", detail: diffLines(a.events, b.events) });
  }
  if (a.result !== b.result) {
    out.push({
      what: "replay result classification (projected)",
      detail: a.result && b.result ? diffJson(a.result, b.result, "result") : ["one run returned no parseable result"],
    });
  }
  if (a.postState !== b.postState) {
    out.push({
      what: "app state after the run (the run's own effect on the app is not reproducible)",
      detail: diffJson(a.postState, b.postState, "state"),
    });
  }
  return out;
};

/* ------------------------------------------------------------------ running */

/**
 * `agent: false`, so every admin call opens a fresh socket.
 *
 * MEASURED, and worth recording because the symptom looks like a broken script:
 * with the default pool, the first call after `spawnSync` returns fails with
 * `read ECONNRESET`. The replay subprocess takes ~8s, during which this process's
 * event loop is blocked and cannot notice the mock closing an idle keep-alive
 * connection, so the next call reuses a socket that is already gone. A retry
 * would paper over it; not pooling removes it, and leaves a network error
 * meaning what it says.
 *
 * The URL and cause are named for the same reason — a checker that reports only
 * "fetch failed" is how a real divergence gets dismissed as a broken script.
 */
const text = (url: string, method: "GET" | "POST" = "GET"): Promise<string> =>
  new Promise<string>((resolve, reject) => {
    const req = http.request(url, { method, agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => {
        if (res.statusCode === 200) resolve(body);
        else reject(new Error(`${method} ${url} answered ${res.statusCode ?? "no status"}`));
      });
    });
    req.on("error", (e: Error) => reject(new Error(`${method} ${url} could not be reached (${e.message})`)));
    req.end();
  });

const runOnce = async (scenario: Scenario, root: string, runId: string, target: string): Promise<Corpus> => {
  await text(`${target}__admin/reset`, "POST");
  const preState = await text(`${target}__admin/state`);

  const args = [
    "tsx",
    "src/replay/main.ts",
    "--capability", scenario.capability ?? CAPABILITY,
    "--binding", BINDING,
    "--target", target,
    "--evidence", root,
    "--run-id", runId,
    ...scenario.inputs.flatMap((i) => ["--input", i]),
  ];
  const proc = spawnSync("npx", args, { encoding: "utf8", timeout: RUN_TIMEOUT_MS });
  if (proc.error) throw new Error(`replay could not be started: ${proc.error.message}`);

  const postState = await text(`${target}__admin/state`);
  const dir = path.join(root, runId);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  const read = (name: string): string | null =>
    files.includes(name) ? fs.readFileSync(path.join(dir, name), "utf8") : null;

  const rawEvents = read("events.jsonl") ?? "";
  const manifest = read("manifest.json");

  // The result JSON is everything stdout printed before the `evidence:` line,
  // which is the only place an absolute path appears.
  const stdout = proc.stdout ?? "";
  const head = stdout.split("\nevidence:")[0] ?? "";
  let result: string | null = null;
  let status: string | null = null;
  try {
    const parsed = JSON.parse(head) as Record<string, unknown>;
    result = JSON.stringify(withoutKeys(parsed, VOLATILE_RESULT_FIELDS));
    status = typeof parsed["status"] === "string" ? parsed["status"] : null;
  } catch {
    result = null;
  }

  return {
    events: projectLines(rawEvents, VOLATILE_EVENT_FIELDS),
    manifest: manifest === null ? null : JSON.stringify(withoutKeys(JSON.parse(manifest), VOLATILE_MANIFEST_FIELDS)),
    capability: read("capability.json"),
    result,
    status,
    exitCode: proc.status ?? -1,
    files,
    preState,
    postState,
    rawEvents,
    dir,
  };
};

/* -------------------------------------------------------------------- self-test */

const perturbEvent = (c: Corpus): Corpus => {
  const first = c.events[0];
  if (first === undefined) return c;
  const line = JSON.parse(first) as Record<string, unknown>;
  line["event"] = `${String(line["event"])}.PLANTED`;
  return { ...c, events: [JSON.stringify(line), ...c.events.slice(1)] };
};

const perturbResult = (c: Corpus): Corpus => {
  if (c.result === null) return c;
  const parsed = JSON.parse(c.result) as Record<string, unknown>;
  parsed["status"] = "failed";
  return { ...c, result: JSON.stringify(parsed) };
};

const perturbVolatileOnly = (c: Corpus): Corpus => ({
  ...c,
  // Re-project a corpus whose raw lines carry different timestamps and run ids.
  events: projectLines(
    c.rawEvents.replace(/"at":"[^"]*"/g, '"at":"2099-01-01T00:00:00.000Z"').replace(/"runId":"[^"]*"/g, '"runId":"planted"'),
    VOLATILE_EVENT_FIELDS,
  ),
});

const selfTest = (corpus: Corpus): boolean => {
  if (corpus.events.length === 0 || corpus.result === null) {
    console.error("verify-determinism: SELF-TEST FAILED — the corpus it was given has no events or no result, so nothing could be perturbed.");
    return false;
  }

  const planted: { readonly name: string; readonly other: Corpus; readonly mustReject: boolean }[] = [
    { name: "a changed event name", other: perturbEvent(corpus), mustReject: true },
    { name: "a changed result status", other: perturbResult(corpus), mustReject: true },
    { name: "changed timestamps and run ids ONLY", other: perturbVolatileOnly(corpus), mustReject: false },
  ];

  let ok = true;
  for (const p of planted) {
    const rejected = compare(corpus, p.other).length > 0;
    if (rejected !== p.mustReject) {
      console.error(
        p.mustReject
          ? `verify-determinism: SELF-TEST FAILED — ${p.name} was NOT caught. The comparator cannot fail, so a passing run proves nothing.`
          : `verify-determinism: SELF-TEST FAILED — ${p.name} WAS caught. The projection is not removing what legitimately varies.`,
      );
      ok = false;
      continue;
    }
    console.log(`verify-determinism: self-test passed (${p.name} was ${p.mustReject ? "caught" : "correctly ignored"}).`);
  }
  return ok;
};

/* --------------------------------------------------------------------- main */

/** An ephemeral port, obtained by binding one and letting go of it. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => (port === 0 ? reject(new Error("could not obtain an ephemeral port")) : resolve(port)));
    });
  });

/**
 * Start the mock IN THIS TREE and wait for it to answer.
 *
 * `detached: true` puts it in its own process group, which is what makes the kill
 * reliable: `npx` spawns `tsx`, which spawns the server, so signalling the npx
 * process alone would leave the real listener orphaned holding the port.
 */
const startMock = async (port: number, target: string): Promise<ChildProcess> => {
  const child = spawn("npx", ["tsx", "mock/main.ts", "--tenant", "a", "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  // Captured but printed only on failure: a mock that starts cleanly should add
  // nothing to this script's output.
  let output = "";
  const collect = (c: Buffer | string): void => {
    output += String(c);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);

  const deadline = Date.now() + MOCK_START_TIMEOUT_MS;
  for (;;) {
    try {
      await text(`${target}__admin/state`);
      return child;
    } catch {
      /* not up yet */
    }
    if (child.exitCode !== null) {
      throw new Error(`the mock exited ${child.exitCode} before it answered:\n${output}`);
    }
    if (Date.now() > deadline) {
      stopMock(child);
      throw new Error(`the mock did not answer at ${target} within ${MOCK_START_TIMEOUT_MS}ms:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
};

/** Kill the GROUP, not the process. See `startMock`. */
const stopMock = (child: ChildProcess | null): void => {
  if (child === null || child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
};

/**
 * Every scenario, twice each. Returns true if anything failed.
 *
 * Separated from `main` so the mock can be killed in a `finally`: `process.exit`
 * does NOT run finally blocks, and this function has several failure exits. With
 * the exits inline, a failing gate would leave an orphaned server behind on every
 * failure — which is precisely the "stale server on a fixed port" problem this
 * change exists to remove.
 */
const runAll = async (target: string, external: boolean): Promise<boolean> => {
  const drift = projectionAgreesWithCode();
  if (drift !== null) {
    console.error(`verify-determinism: PROJECTION UNSOUND — ${drift}`);
    return true;
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-determinism-"));
  let failed = false;
  let comparedLines = 0;
  const observed: string[] = [];
  let first: Corpus | null = null;

  for (const scenario of SCENARIOS) {
    const runRoot = path.join(root, scenario.name);
    // Distinct run ids and distinct roots: `EvidenceWriter.event` APPENDS, and the
    // default run id is a constant, so a second run into the same directory would
    // silently double the log and be compared against a fresh one.
    console.log(`verify-determinism: [${scenario.name}] reset -> run, reset -> run ...`);
    const a = await runOnce(scenario, runRoot, "run-a", target);
    const b = await runOnce(scenario, runRoot, "run-b", target);
    if (first === null && a.events.length > 0) first = a;

    if (a.result === null || b.result === null) {
      console.error(`verify-determinism: FAILED [${scenario.name}] — replay returned no parseable result, so there is nothing to compare.`);
      console.error(`    evidence kept at ${runRoot}`);
      failed = true;
      continue;
    }

    // Guard 2a. Identical raw bytes would mean this compared a run with itself.
    if (a.rawEvents === b.rawEvents && a.rawEvents.length > 0) {
      console.error(`verify-determinism: FAILED [${scenario.name}] — the two runs' raw event logs are byte-identical before projection, which means they are not two runs.`);
      failed = true;
      continue;
    }

    if (a.status !== scenario.expect) {
      console.error(`verify-determinism: FAILED [${scenario.name}] — expected class ${scenario.expect}, observed ${a.status ?? "none"}. The coverage this check claims is not the coverage it has.`);
      failed = true;
    }

    const differences = compare(a, b);
    if (differences.length > 0) {
      failed = true;
      console.error(`verify-determinism: FAILED [${scenario.name}] — reset -> run twice did not reproduce.`);
      for (const d of differences) {
        console.error(`  DIVERGED: ${d.what}`);
        for (const line of d.detail) console.error(`    ${line}`);
      }
      console.error(`    evidence kept at ${runRoot}`);
      continue;
    }

    comparedLines += a.events.length;
    observed.push(
      `  ${scenario.name}: ${a.status ?? "?"} (exit ${a.exitCode}), ${a.events.length} event line(s) compared, files [${a.files.join(", ")}]`,
    );
  }

  // Guard 2b. Coverage, stated in numbers so a reviewer can see how much the pass
  // is worth rather than infer it from the word OK.
  const classes = new Set(SCENARIOS.map((s) => s.expect));
  if (!failed && (comparedLines < MIN_EVENT_LINES || classes.size < 3)) {
    console.error(`verify-determinism: VACUOUS — only ${comparedLines} event line(s) across ${classes.size} result class(es) were compared. That is too thin to call determinism proven.`);
    failed = true;
  }

  if (process.argv.includes("--self-test")) {
    if (first === null) {
      console.error("verify-determinism: SELF-TEST FAILED — no scenario produced a corpus to plant a divergence into.");
      failed = true;
    } else if (!selfTest(first)) {
      failed = true;
    }
  }

  if (failed) {
    console.error(`verify-determinism: run directories left at ${root} for inspection.`);
    return true;
  }

  fs.rmSync(root, { recursive: true, force: true });

  console.log(`verify-determinism: OK — ${SCENARIOS.length} scenario(s) each run twice as reset -> run, evidence identical after projection.`);
  for (const line of observed) console.log(line);
  console.log(
    external
      ? `  TARGET: ${target} — EXTERNAL, named with --target. This did NOT test the mock in this working tree.`
      : `  target: ${target} — a mock this checker spawned from mock/main.ts in this tree, and killed afterwards.`,
  );
  console.log(`  projected away: events[${VOLATILE_EVENT_FIELDS.join(", ")}] manifest[${VOLATILE_MANIFEST_FIELDS.join(", ")}] result[${VOLATILE_RESULT_FIELDS.join(", ")}]`);
  console.log("  compared in full: capability.json bytes, manifest, event log, result classification, exit code, and the app's own state before and after each run.");
  console.log("  what this does NOT prove: the mock's clock is frozen, so this shows replay adds no nondeterminism of its own — not that it would survive an app with a live clock.");
  return false;
};

const main = async (): Promise<void> => {
  const missing = [CAPABILITY, CARD_CAPABILITY, BINDING].filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    console.error(`verify-determinism: fixture not found: ${missing.join(", ")} (run from the repo root)`);
    process.exit(1);
  }

  const external = externalTarget();
  let mock: ChildProcess | null = null;
  let target: string;

  if (external === null) {
    const port = await freePort();
    target = `http://localhost:${port}/`;
    console.log(`verify-determinism: starting a mock from mock/main.ts on port ${port} ...`);
    mock = await startMock(port, target);
  } else {
    target = external;
    // An external target must actually ANSWER, and failing is the only honest
    // response: skipping here would make the whole check vacuous.
    try {
      await text(`${target}__admin/state`);
    } catch (e: unknown) {
      console.error(`verify-determinism: the mock is not answering at ${target} — ${e instanceof Error ? e.message : String(e)}`);
      console.error("  start it with `npm run mock`, or drop --target and let this checker start its own.");
      process.exit(1);
    }
  }

  let failed = true;
  try {
    failed = await runAll(target, external !== null);
  } finally {
    // Explicit, because `process.exit` below does not run finally blocks — so
    // without this every FAILING gate would leave an orphaned server holding a
    // port, which is the exact condition this change exists to stop.
    stopMock(mock);
  }
  process.exit(failed ? 1 : 0);
};

main().catch((e: unknown) => {
  console.error(`verify-determinism: unhandled error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
