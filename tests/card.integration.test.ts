/**
 * THE MUTATING CAPABILITY, END TO END — and the app's own record of what it did.
 *
 * `tests/replay.integration.test.ts` proves the engine can drive a READ-ONLY flow.
 * This proves the half that actually carries risk: a capability that CHANGES
 * something, and the reconciliation that makes the change checkable.
 *
 * ── WHY EVERY TEST HERE ASSERTS BOTH SIDES ──────────────────────────────────
 *
 * A replay result is the automation's own account of what happened. Asserting
 * only that is circular — it is the run marking its own homework. So every case
 * below also reads `/__admin/state`, which is the APP's account: its card
 * statuses and its own audit trail, written by the server when the transaction
 * ran and derived from nothing the run reports. Agreement between the two is
 * evidence; disagreement is a defect, and the `abend_after_commit` test exists
 * precisely to produce a disagreement and check the system reports it honestly
 * rather than guessing.
 *
 * The full production stack, assembled exactly as `replay()` requires:
 *
 *     PlaywrightSurface   drives Chromium; the only module importing playwright
 *       -> BoundSurface   translates CRD0500 into CARD_SERVICES
 *         -> GatedSurface enforces the allowlist and the control lease
 *
 * The policy is the SHIPPED default from src/replay/main.ts, not a permissive
 * one written for the test: `reversible: allow` is what lets set_status run
 * unattended, and `irreversible: confirm` is what would route report_lost to a
 * person. A test that widened the policy would prove nothing about what a
 * reviewer actually gets.
 *
 * Each run gets its OWN browser from the entry point, and the app is reset first,
 * for the reason replay.integration.test.ts records: an invocation must establish
 * its own starting position rather than inherit the last one's.
 *
 * No model, no key. This runs in CI.
 *
 * ── THE TWO DIALOG FAULTS, AND WHAT CHANGED ─────────────────────────────────
 *
 * `mock/seed.ts` ships three faults. `abend_after_commit` and `confirm_submit`
 * are exercised below. `broadcast` is not exercised HERE, and the reason is now
 * a budget rather than a defect — the previous version of this comment said it
 * was unrecoverable, and that has stopped being true:
 *
 *  - `broadcast` IS NOW RECOVERABLE, and this is the path that proves it. The
 *    dialog arrives on the CARD SERVICES render, which the run reaches by
 *    CLICKING at s04 — so it is present at s04's POSTCONDITION. `executor.ts`
 *    used to apply `plan.recovery[]` in the precondition loop ONLY, turning a
 *    recoverable classification at a postcondition into `postcondition_failed`
 *    with an empty `recoveries[]`; the `dismiss-broadcast` rule both fixtures
 *    declare really was unreachable on this path. The postcondition is now the
 *    same `for(;;)` loop as the precondition, sharing the step's `used` array,
 *    so the rule fires, the dismiss is issued, and the run continues. Measured
 *    against a mock started on an ephemeral port: the armed run returns
 *    `success` with a non-empty `recoveries[]`.
 *
 *  - WHY THIS SUITE STILL DOES NOT RUN IT: a queued native dialog blocks any
 *    page-touching call that does not check for one first, and the guard is not
 *    yet everywhere. `observe()`, `locate()`, `read()` and `act()` now check
 *    `pendingDialog` before touching the page; `launch()`'s initial navigation
 *    and `describe()` do not, and `observe()`'s enrichment loop calls
 *    `describe()` once per actionable node.
 *
 *    The timings below were measured BEFORE that guard landed and are kept as
 *    the shape of the problem rather than as current numbers: with nothing
 *    checking, `observe()` returned only after ~33s and `locator.click` after
 *    exactly 30s ("Timeout 30000ms exceeded" — Playwright's default, since the
 *    aria snapshot carries no bound of its own).
 *
 *    So recovering was never the slow part; perceiving a blocked page is. Until
 *    the remaining two entry points are bounded, a `broadcast` case here risks
 *    tens of seconds of suite time waiting on a driver timeout — which is the
 *    same gap that makes `npm run mock:fault -- --run broadcast` intermittent
 *    rather than reliable, and it is declared as open in README and REPORT.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../mock/main.js";
import { freshState } from "../mock/seed.js";
import { tenantA } from "../mock/tenant.js";
import { Binding } from "../src/capability/bind.js";
import { parseCapability, type Capability } from "../src/capability/schema.js";
import { completed, type ReplayResult } from "../src/contract/result.js";
import { ControlLease } from "../src/control/lease.js";
import { EventSequencer, type LogEvent } from "../src/evidence/events.js";
import { EvidenceWriter } from "../src/evidence/log.js";
import { PolicyDocument } from "../src/policy/policy.js";
import { replay } from "../src/replay/index.js";
import { BoundSurface } from "../src/surface/bound.js";
import { GatedSurface } from "../src/surface/gated.js";
import { PlaywrightSurface } from "../src/surface/playwright.js";

/**
 * PORT 0 — the OS picks a free one.
 *
 * This suite used to bind a FIXED 7113 with no `error` handler on `listen`, so
 * anything already holding that port hung the `beforeAll` until its timeout and
 * vitest reported all seven tests as SKIPPED rather than failed. These are the
 * only automated coverage of every mutating-capability claim — the freeze, the
 * audit reconciliation, `abend_after_commit`, `confirm_submit` and the
 * end-to-end PAN/SSN leak scan — so they must not be able to vanish quietly
 * behind the word "skipped". The repo's own scripts already bind 0 for this
 * reason (`scripts/demo.ts`) or allocate a free port explicitly
 * (`scripts/verify-determinism.ts`). Nothing here needs a predictable port.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const load = (name: string): unknown => JSON.parse(readFileSync(path.join(here, "fixtures", name), "utf8"));

let ENTRY: string;
/** The SHIPPED default policy (src/replay/main.ts), copied in shape, not relaxed. */
let policy: PolicyDocument;

const binding = Binding.parse(load("fcu@4.2.json"));
let setStatus: Capability;
let server: Server;

/**
 * The seeded secrets, read from the mock's own seed rather than copied.
 *
 * `scripts/verify-evidence.ts` sources them the same way and for the same reason:
 * a copied literal goes stale on a reseed and the scan keeps passing while
 * protecting nothing.
 */
const seeded = freshState();
const PANS = Object.values(seeded.members).flatMap((m) => m.cards.map((c) => c.pan));
const SSNS = Object.values(seeded.members).map((m) => m.ssn);

/** The app's own account of itself. Nothing here is derived from the run. */
interface AdminState {
  readonly confirmationSeq: number;
  readonly armedFault: string | null;
  readonly audit: readonly {
    readonly seq: number;
    readonly actor: string;
    readonly screen: string;
    readonly action: string;
    readonly memberId: string | null;
    readonly confirmation: string | null;
    readonly outcome: string;
    readonly detail: string;
  }[];
  readonly cards: Readonly<Record<string, readonly { readonly last4: string; readonly status: string }[]>>;
}

const adminState = async (): Promise<AdminState> =>
  (await (await fetch(`${ENTRY}__admin/state`)).json()) as AdminState;

const reset = async (): Promise<void> => {
  await fetch(`${ENTRY}__admin/reset`, { method: "POST" });
};

/**
 * Arm a fault, and FAIL if it did not arm.
 *
 * Checked rather than assumed, and that is not defensive coding: while writing
 * these tests a `curl` arming request silently failed to connect and the run that
 * followed passed as a clean success, which read exactly like "the fault does
 * nothing". A fault demo that proves nothing must be loud, not green.
 */
const arm = async (fault: string): Promise<void> => {
  const response = await fetch(`${ENTRY}__admin/fault`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fault }),
  });
  expect(response.status).toBe(200);
  expect((await adminState()).armedFault).toBe(fault);
};

interface RunOutput {
  readonly result: ReplayResult;
  readonly events: readonly LogEvent[];
  /** Where the evidence was flushed, when the caller asked for it. */
  readonly dir: string | null;
}

const temps: string[] = [];

/** One invocation, exactly as a production worker would make it. */
const run = async (
  capability: Capability,
  params: Readonly<Record<string, string>>,
  runId: string,
  evidenceRoot?: string,
): Promise<RunOutput> => {
  const startedAt = new Date().toISOString();
  const driver = await PlaywrightSurface.launch(ENTRY, { headed: false });
  try {
    const lease = new ControlLease(() => new Date().toISOString());
    const log = new EventSequencer({
      runId,
      phase: "replay",
      now: () => new Date().toISOString(),
      controlOwner: () => lease.holder,
    });
    const surface = new GatedSurface(new BoundSurface(driver, binding), policy, lease);

    const result = await replay(capability, binding, params, {
      surface,
      lease,
      log,
      runId,
      /**
       * The run ceiling is generous on purpose. A reviewer measured this suite
       * exceeding a 40s run budget under vitest's file-level concurrency while
       * passing in 25.3s when run alone — so the old value was tight enough that
       * a busy machine turned a passing capability into a `timeout` failure, and
       * the budget was testing the machine rather than the engine. Raised, not
       * removed: a run that genuinely hangs still terminates with a typed
       * outcome. No assertion below depends on the value.
       */
      budgets: { stepMs: 8000, runMs: 120000 },
      now: () => Date.now(),
    });

    let dir: string | null = null;
    if (evidenceRoot !== undefined) {
      // Everything the CLI writes, so the leak scan below covers what a run
      // actually leaves on disk rather than a convenient subset of it.
      const evidence = new EvidenceWriter(evidenceRoot, runId);
      evidence.events(log.all);
      evidence.artifact(capability);
      evidence.manifest({
        runId,
        phase: "replay",
        startedAt,
        endedAt: new Date().toISOString(),
        target: ENTRY,
        tenant: binding.tenant,
        capability: { id: capability.contract.id, version: capability.contract.version },
        model: { provider: "none", calls: result.modelCalls },
        result: result.status,
        versions: { node: process.versions.node, playwright: "1.63.0" },
      });
      dir = evidence.directory;
    }

    return { result, events: log.all, dir };
  } finally {
    await driver.close();
  }
};

/** Which step a declared business outcome was recognised at — a citation, not a guess. */
const outcomeStep = (events: readonly LogEvent[]): string | null =>
  events.find((e) => e.event === "outcome.matched")?.stepRef ?? null;

beforeAll(async () => {
  setStatus = parseCapability(load("set_status@1.0.0.json"));
  server = createServer(tenantA);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  ENTRY = `http://localhost:${(server.address() as AddressInfo).port}/`;
  policy = PolicyDocument.parse({
    version: "1.0.0",
    allowedOrigins: [ENTRY.replace(/\/$/, "")],
    deniedRoutes: ["/__admin"],
    allowedActions: ["navigate", "click", "fill", "press", "dismiss_dialog"],
    screenRules: [],
    riskHandling: { read_only: "allow", reversible: "allow", irreversible: "confirm" },
    caps: { maxSteps: 40, maxRunSeconds: 60 },
  });
}, 60000);

afterAll(() => {
  server?.close();
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

describe("msc.card.set_status against the real mock", () => {
  it("freezes a card, and the app's OWN audit trail names the same confirmation", async () => {
    await reset();
    const { result } = await run(setStatus, { member_id: "400200101", card_last4: "4021", action: "FREEZE" }, "card-freeze");
    if (result.status !== "success") console.error("UNEXPECTED:", JSON.stringify(result, null, 1));

    expect(result.status).toBe("success");
    expect(result.modelCalls).toBe(0);
    expect(result.capability).toEqual({ id: "msc.card.set_status", version: "1.0.0" });
    if (result.status !== "success") return;

    expect(result.outputs["confirmation_number"]).toBe("CNF4401");
    // Every target resolved by its PRIMARY strategy: the recorded anchors still
    // hold, which is the per-tenant drift signal (§3.7-d) reading clean.
    expect(result.degradations).toEqual([]);

    // ---- the other side: what the APP says happened -------------------------
    const state = await adminState();
    expect(state.cards["400200101"]).toEqual([
      { last4: "4021", status: "FROZEN" },
      { last4: "7788", status: "ACTIVE" },
    ]);

    expect(state.audit).toHaveLength(1);
    const row = state.audit[0];
    expect(row?.outcome).toBe("APPLIED");
    expect(row?.action).toBe("FREEZE 4021");
    expect(row?.memberId).toBe("400200101");
    expect(row?.detail).toBe("ACTIVE -> FROZEN");
    // THE RECONCILIATION. The run read CNF4401 off the confirmation screen; the
    // app wrote CNF4401 when it committed. Neither number came from the other.
    expect(row?.confirmation).toBe("CNF4401");
    expect(row?.confirmation).toBe(result.outputs["confirmation_number"]);
  }, 120000);

  it("reports a card ALREADY in the requested status as a business outcome, not a failure", async () => {
    await reset();
    // 400203344's only card is seeded FROZEN, so FREEZE asks for a world that
    // already exists. This is the §3.3 conflation the result contract exists to
    // prevent: an idempotent request must not look like a broken system.
    const { result, events } = await run(setStatus, { member_id: "400203344", card_last4: "9090", action: "FREEZE" }, "card-already");
    if (result.status !== "business_outcome") console.error("UNEXPECTED:", JSON.stringify(result, null, 1));

    expect(result.status).toBe("business_outcome");
    // Exit-equivalent to a success: `replay/main.ts` exits non-zero only on failure.
    expect(completed(result)).toBe(true);
    if (result.status !== "business_outcome") return;
    expect(result.code).toBe("CARD_ALREADY_IN_STATE");
    expect(result.matchedSignal).toContain("MSG 0121");
    // Recognised at the step that submitted it — an auditable citation.
    expect(outcomeStep(events)).toBe("s07");

    const state = await adminState();
    expect(state.cards["400203344"]?.[0]?.status).toBe("FROZEN");
    // The refusal IS recorded: without a DENIED row, "nothing happened" and "the
    // app refused you" would be indistinguishable in the independent record.
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]?.outcome).toBe("DENIED");
    expect(state.audit[0]?.confirmation).toBeNull();
    expect(state.confirmationSeq).toBe(4400);
  }, 120000);

  it("reports a card that does not belong to the member as CARD_NOT_FOUND", async () => {
    await reset();
    // 5512 is a real seeded card — it belongs to a DIFFERENT member. A wrong
    // answer here would be acting on someone else's card.
    const { result } = await run(setStatus, { member_id: "400200101", card_last4: "5512", action: "FREEZE" }, "card-not-found");
    if (result.status !== "business_outcome") console.error("UNEXPECTED:", JSON.stringify(result, null, 1));

    expect(result.status).toBe("business_outcome");
    if (result.status !== "business_outcome") return;
    expect(result.code).toBe("CARD_NOT_FOUND");
    expect(result.matchedSignal).toContain("MSG 0114");

    const state = await adminState();
    // Nothing moved, on either membership.
    expect(state.cards["400200101"]).toEqual([
      { last4: "4021", status: "ACTIVE" },
      { last4: "7788", status: "ACTIVE" },
    ]);
    expect(state.cards["400200601"]?.[0]?.status).toBe("ACTIVE");
    expect(state.audit[0]?.outcome).toBe("DENIED");
  }, 120000);

  it("reports an unknown member as MEMBER_NOT_FOUND, detected at s02", async () => {
    await reset();
    const { result, events } = await run(setStatus, { member_id: "400299999", card_last4: "4021", action: "FREEZE" }, "card-no-member");
    if (result.status !== "business_outcome") console.error("UNEXPECTED:", JSON.stringify(result, null, 1));

    expect(result.status).toBe("business_outcome");
    if (result.status !== "business_outcome") return;
    expect(result.code).toBe("MEMBER_NOT_FOUND");
    // s02 is the search submit: the answer arrives before any servicing screen is
    // reached, which is why no card was ever selected and nothing was attempted.
    expect(outcomeStep(events)).toBe("s02");

    const state = await adminState();
    expect(state.audit).toHaveLength(0);
  }, 120000);
});

describe("when the app commits and then loses the transaction", () => {
  /**
   * THE HEADLINE. `abend_after_commit` applies the change, writes the APPLIED row
   * with its confirmation number, and then renders SYS0500 instead of CNF9000.
   *
   * This is the DANGEROUS direction of disagreement: the app moved and the
   * automation never saw it. The only honest answer is "I cannot tell you what
   * happened — go and reconcile", which is what the result contract's
   * `reconcile_required` / `sideEffectRisk: unknown` pair means. A system that
   * guessed either way would be wrong half the time, and silently.
   */
  it("returns reconcile_required — and the app's audit proves the change DID land", async () => {
    await reset();
    await arm("abend_after_commit");

    const { result } = await run(setStatus, { member_id: "400200101", card_last4: "4021", action: "FREEZE" }, "card-abend");
    if (result.status !== "failed") console.error("UNEXPECTED:", JSON.stringify(result, null, 1));

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.kind).toBe("postcondition_failed");
    expect(result.stepRef).toBe("s07");
    // Keyed on the step's DECLARED risk: s07 is `reversible`, so it may have
    // committed, so the caller must not blindly retry.
    expect(result.remediation).toBe("reconcile_required");
    expect(result.sideEffectRisk).toBe("unknown");

    // ---- and now the part the automation could not know ---------------------
    const state = await adminState();
    expect(state.cards["400200101"]?.[0]?.status).toBe("FROZEN");
    expect(state.audit).toHaveLength(1);
    expect(state.audit[0]?.outcome).toBe("APPLIED");
    expect(state.audit[0]?.confirmation).toBe("CNF4401");

    // The two records genuinely disagree, and that is the point: the confirmation
    // number exists in the app and appears NOWHERE in what the run returned. A
    // result that mentioned it would mean the run had seen the confirmation
    // screen, and it never did.
    expect(JSON.stringify(result)).not.toContain("CNF4401");
  }, 120000);
});

describe("when an undeclared dialog blocks the submit", () => {
  /**
   * `confirm_submit` puts an `onsubmit` confirm() on the card form. No capability
   * declares it, and `accept_dialog` is deliberately not in the shipped
   * `allowedActions`, so the submit cannot complete.
   *
   * WHAT IS ASSERTED IS THE PROPERTY, NOT TODAY'S MECHANISM — and the mechanism
   * has since changed, which is why the tolerance was worth having.
   *
   * It used to THROW: `locator.click: Timeout 30000ms exceeded`, because the
   * queued dialog blocked the click and the driver bounded nothing, so the error
   * escaped `replay()` untyped instead of arriving as the `undeclared_dialog`
   * kind the contract declares for exactly this case. This comment described that
   * as current long after it stopped being true.
   *
   * `observe`, `locate`, `read` and `act` now check for a pending dialog first, so
   * the run RETURNS the typed failure — `npm run mock:fault -- --run confirm_submit`
   * asserts precisely that, and re-measured here those calls answer in 0ms rather
   * than timing out. (`launch`'s initial navigation and `describe` are still
   * unbounded; see README's "Not built".)
   *
   * The assertion below stays tolerant of both deliberately. The one outcome that
   * must never happen is a SUCCESS, because a click reporting success over a
   * cancelled submit is the phantom success this whole design is built against.
   */
  it("commits NOTHING, and the app's empty audit trail is the independent proof", async () => {
    await reset();
    await arm("confirm_submit");

    const outcome = await run(setStatus, { member_id: "400200101", card_last4: "4021", action: "FREEZE" }, "card-confirm-submit").then(
      (r) => ({ threw: false, result: r.result }) as const,
      () => ({ threw: true, result: null }) as const,
    );

    expect(outcome.threw || outcome.result?.status === "failed").toBe(true);
    expect(outcome.result?.status).not.toBe("success");

    // THE INDEPENDENT RECORD, and the reason this test is worth its wall time: a
    // blocked submit must leave the app untouched. An APPLIED row here would mean
    // the change landed while the automation believed it had been stopped.
    const state = await adminState();
    expect(state.audit).toHaveLength(0);
    expect(state.cards["400200101"]?.[0]?.status).toBe("ACTIVE");
    expect(state.confirmationSeq).toBe(4400);
  }, 180000);
});

describe("redaction, on the evidence a run actually writes", () => {
  /**
   * CRD0500 renders the PAN UNMASKED — that is what the screen is for, and this
   * run is the first thing in the repo that reaches it. So this is the first
   * chance to check the leak end to end rather than in a unit test of the
   * redactor.
   *
   * MEASURED, and it changes what this test can honestly claim: replay's
   * `events.jsonl` carries citations and expected/observed SUMMARIES, never a
   * screen dump and never a typed value — so a card-freeze run writes neither the
   * PAN nor the last four to disk. The scan below is therefore a REGRESSION GUARD
   * on that property, not proof that the redactor masks anything; the redactor
   * itself is covered by tests/redact.test.ts, and the path that really does put
   * screen text on disk is the handoff record, which redacts on the way out.
   *
   * The shapes are the ones `scripts/verify-evidence.ts` and `src/safety/redact.ts`
   * already share — guarded rather than `\b`, for the measured reason recorded
   * there — so all three agree on what a leak looks like instead of drifting.
   */
  it("writes no PAN and no SSN, while the last four survives where it is load-bearing", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "card-evidence-"));
    temps.push(root);

    await reset();
    const { result, dir } = await run(
      setStatus,
      { member_id: "400200101", card_last4: "4021", action: "FREEZE" },
      "card-evidence",
      root,
    );
    expect(result.status).toBe("success");
    expect(dir).not.toBeNull();
    if (dir === null) return;

    const files = readdirSync(dir);
    expect(files.sort()).toEqual(["capability.json", "events.jsonl", "manifest.json"]);
    const written = files.map((f) => readFileSync(path.join(dir, f), "utf8")).join("\n");

    // Exact literals first: these are the values actually rendered on the screens
    // this run walked through.
    for (const pan of PANS) expect(written).not.toContain(pan);
    for (const ssn of SSNS) expect(written).not.toContain(ssn);

    // Then the shapes, which also catch a leak the exact literals would miss.
    expect(written).not.toMatch(/(?<![\w-])\d{13,19}(?![\w-])/);
    expect(written).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);

    // And the other half of §3.4, which is easy to forget: safety must not break
    // the thing it protects. The last four is what tells 4021 from 7788, so it
    // has to survive where the capability needs it — here, in the checkpoint the
    // run verified and in the result the caller receives.
    if (result.status !== "success") return;
    expect(result.checkpoint[0]?.expected).toContain("4021");
    expect(result.outputs["confirmation_number"]).toBe("CNF4401");
  }, 120000);
});
