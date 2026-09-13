/**
 * `npm run mock:fault` — arm a deterministic fault in the mock, from one command.
 *
 * The three faults exist so that "recoverable condition" and "hard failure" are
 * things a reviewer can RUN rather than read about. Each is armed explicitly,
 * fires on a stated condition, and then disarms itself; none is probabilistic,
 * because a lucky replay must never be able to pass.
 *
 *   npm run mock:fault -- --list
 *   npm run mock:fault -- --arm abend_after_commit
 *   npm run mock:fault -- --status
 *   npm run mock:fault -- --clear
 *
 * This talks to the admin plane and does nothing else: no browser, no model, no
 * evidence. The admin plane is denied to the automation by every shipped policy
 * (`deniedRoutes: ["/__admin"]`), which is what stops a capability arming its own
 * faults — so arming is a deliberate act by a person at a terminal.
 *
 * IT MUST FAIL LOUDLY. An unknown fault name or an unreachable server exits
 * non-zero and says which URL it tried; a fault demo that silently armed nothing
 * would "pass" while proving the opposite of what it claims.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAULTS, isFaultName, type FaultName } from "../mock/seed.js";

const DEFAULT_TARGET = "http://localhost:7101/";

/**
 * What a replay against each armed fault should return. Stated here so `--arm`
 * prints the expected result class alongside the command: a run whose outcome
 * disagrees with this line is the interesting case, and a reviewer should not
 * have to guess what was expected.
 */
const EXPECTATION: Readonly<Record<FaultName, string>> = {
  broadcast:
    "success — the capability's declared dismiss_dialog rule clears the alert and the run continues (a RECOVERABLE condition)",
  confirm_submit:
    "failed / undeclared_dialog — the submit is blocked and nothing commits; /screen/audit staying EMPTY is the independent proof",
  abend_after_commit:
    "failed / postcondition_failed, remediation reconcile_required, sideEffectRisk unknown — the change DID land, and /screen/audit is the only place that says so",
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

const call = async (url: string, init?: RequestInit): Promise<unknown> => {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error: unknown) {
    // Naming the URL matters: a checker that reports only "fetch failed" is how a
    // stopped server gets mistaken for a broken script.
    return die(
      `cannot reach ${url} — ${error instanceof Error ? error.message : String(error)}\n` +
        `  is the mock running?  npm run mock`,
    );
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
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

const usage = (): void => {
  console.log("usage: npm run mock:fault -- [--list | --arm <name> | --clear | --status] [--target <url>]");
  console.log(`  --target defaults to ${DEFAULT_TARGET}`);
};

const main = async (): Promise<void> => {
  if (flag("list")) {
    console.log("Deterministic faults. Each is armed explicitly, fires ONCE on its condition, then disarms itself.");
    console.log("Reset (POST /__admin/reset) clears any armed fault, so the determinism corpus cannot be polluted.\n");
    for (const f of FAULTS) {
      console.log(`  ${f.name}`);
      console.log(`      fires:  ${f.fires}`);
      console.log(`      proves: ${f.proves}`);
      console.log(`      replay: ${EXPECTATION[f.name]}\n`);
    }
    return;
  }

  const base = target();

  if (flag("status")) {
    const state = await call(new URL("__admin/state", base).toString());
    console.log(`mock:fault: armed fault is ${armedFaultOf(state)}  (${base})`);
    return;
  }

  if (flag("clear")) {
    const body = await call(new URL("__admin/fault", base).toString(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fault: "none" }),
    });
    console.log(`mock:fault: cleared — armed fault is now ${armedFaultOf(body)}  (${base})`);
    return;
  }

  const arm = value("arm");
  if (arm === null) {
    usage();
    process.exit(2);
  }
  if (arm === "") die("--arm needs a fault name; run --list to see them", 2);
  if (!isFaultName(arm)) {
    // Refused HERE as well as by the server, so a typo costs nothing and the
    // legal set is always in front of the person who mistyped it.
    die(`unknown fault ${JSON.stringify(arm)}\n  known: ${FAULTS.map((f) => f.name).join(", ")}`, 2);
  }

  const body = await call(new URL("__admin/fault", base).toString(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fault: arm }),
  });
  const armed = armedFaultOf(body);
  if (armed !== arm) die(`the server reports the armed fault as ${armed}, not ${arm} — refusing to claim it is armed`);

  const spec = FAULTS.find((f) => f.name === arm);
  const capability = cardCapability();

  console.log(`mock:fault: ARMED ${arm}  (${base})`);
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
  console.log(`  Expect: ${EXPECTATION[arm]}`);
  console.log("  Then:   open /screen/audit — the app's own record of what actually committed.");
};

main().catch((error: unknown) => {
  console.error(`mock:fault: unhandled error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
