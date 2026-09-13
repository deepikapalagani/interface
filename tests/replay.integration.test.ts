/**
 * THE FIRST END-TO-END RUN — everything, against the real mock, in one browser.
 *
 * Until now every piece was proven in isolation with stubs. This is the first
 * time the Playwright adapter meets the actual frameset, the structural anchor
 * resolves against real markup, and `replay()` drives a recorded plan from start
 * to checkpoint. It is the difference between "compiles" and "works".
 *
 * The full stack is assembled exactly as production would:
 *
 *     PlaywrightSurface   drives Chromium; the only module importing playwright
 *       -> BoundSurface   translates MBR0300 into MEMBER_SEARCH
 *         -> GatedSurface enforces the allowlist and the control lease
 *
 * EACH RUN GETS ITS OWN BROWSER, positioned at the capability's entry point.
 * The first version of this test shared one browser between runs, and the second
 * run failed its very first precondition because the first had left the session
 * on the results screen. That was the test's bug, not the system's — but it
 * named a real property: an invocation must establish its own starting position
 * rather than inherit whatever the last one left behind. Launching per run is
 * also how a production worker would invoke a capability.
 *
 * No model is involved. No key is needed. This runs in CI.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../mock/main.js";
import { tenantA } from "../mock/tenant.js";
import { Binding } from "../src/capability/bind.js";
import { parseCapability, type Capability } from "../src/capability/schema.js";
import { ControlLease } from "../src/control/lease.js";
import { EventSequencer } from "../src/evidence/events.js";
import { PolicyDocument } from "../src/policy/policy.js";
import { replay } from "../src/replay/index.js";
import { BoundSurface } from "../src/surface/bound.js";
import { GatedSurface } from "../src/surface/gated.js";
import { PlaywrightSurface } from "../src/surface/playwright.js";

/**
 * PORT 0 — the OS picks a free one.
 *
 * This suite used to bind a FIXED 7108, with no `error` handler on `listen`, so
 * on a machine where anything already held that port the `beforeAll` hung until
 * its timeout and vitest reported every test in the file as SKIPPED rather than
 * failed. Green on a clean machine, silently absent on a busy one — and the
 * repo's own scripts already avoid fixed ports for exactly this reason
 * (`scripts/demo.ts` binds 0, `scripts/verify-determinism.ts` has `freePort()`).
 * Nothing here needs a predictable port: the entry URL is derived after binding.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const load = (name: string): unknown => JSON.parse(readFileSync(path.join(here, "fixtures", name), "utf8"));

let ENTRY: string;
let policy: PolicyDocument;
let server: Server;
let capability: Capability;
const binding = Binding.parse(load("fcu@4.2.json"));

/** One invocation: its own browser, at the entry point, from reset mock state. */
const run = async (memberId: string) => {
  await fetch(`${ENTRY}__admin/reset`, { method: "POST" });

  const driver = await PlaywrightSurface.launch(ENTRY, { headed: false });
  try {
    const lease = new ControlLease(() => new Date().toISOString());
    const log = new EventSequencer({
      runId: `it-${memberId}`,
      phase: "replay",
      now: () => new Date().toISOString(),
      controlOwner: () => lease.holder,
    });
    const surface = new GatedSurface(new BoundSurface(driver, binding), policy, lease);

    return await replay(
      capability,
      binding,
      { member_id: memberId },
      { surface, lease, log, runId: `it-${memberId}`, budgets: { stepMs: 8000, runMs: 40000 }, now: () => Date.now() },
    );
  } finally {
    await driver.close();
  }
};

beforeAll(async () => {
  capability = parseCapability(load("lookup@1.0.0.json"));
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
});

describe("replay against the real mock", () => {
  it("drives the recorded plan to its checkpoint and returns success", async () => {
    const result = await run("400200101");
    if (result.status !== "success") console.error("UNEXPECTED:", JSON.stringify(result, null, 1));

    expect(result.status).toBe("success");
    expect(result.modelCalls).toBe(0);
    expect(result.tenant).toBe("fcu");
    expect(result.capability).toEqual({ id: "msc.member.lookup", version: "1.0.0" });

    if (result.status !== "success") return;
    // The checkpoint is now genuinely asserted, so it must name what it verified.
    expect(result.checkpoint[0]?.expected).toContain("MEMBER_RESULTS");
  }, 60000);

  it("returns a BUSINESS OUTCOME for a member that does not exist — not a crash", async () => {
    const result = await run("400299999");
    if (result.status !== "business_outcome") console.error("UNEXPECTED:", JSON.stringify(result, null, 1));

    expect(result.status).toBe("business_outcome");
    if (result.status !== "business_outcome") return;
    expect(result.code).toBe("MEMBER_NOT_FOUND");
    expect(result.matchedSignal).toContain("MSG 0071");
  }, 60000);

  /**
   * §3.4-a THROUGH THE CLI, AND BEFORE A BROWSER EXISTS.
   *
   * `validatePlanOrigins` was written for exactly this and had NO caller, so an
   * off-allowlist `--target` used to launch Chromium, navigate to the forbidden
   * origin and render it — only the first ACTION was refused, long after the
   * page had been fetched. "We loaded it and then declined to click" is not the
   * guarantee an allowlist makes.
   *
   * Spawned as the real CLI with NO MOCK RUNNING, which is the point: the
   * refusal has to be the allowlist talking, not a navigation error. A run that
   * got as far as trying would fail with a connection or timeout message
   * instead, so the assertion is on WHICH failure this is.
   */
  it("refuses an off-allowlist target before launching a browser, and writes no evidence", () => {
    const root = mkdtempSync(path.join(tmpdir(), "replay-allowlist-"));
    try {
      const result = spawnSync(
        path.join(here, "..", "node_modules", ".bin", "tsx"),
        [
          path.join(here, "..", "src", "replay", "main.ts"),
          "--capability", path.join(here, "fixtures", "lookup@1.0.0.json"),
          "--binding", path.join(here, "fixtures", "fcu@4.2.json"),
          // allowedOrigins is ["http://localhost:7101"]; example.com is not it.
          "--policy", path.join(here, "fixtures", "policy-escalate.json"),
          "--target", "http://example.com/",
          "--evidence", root,
          "--run-id", "allowlist-refused",
          "--input", "member_id=400200101",
        ],
        { cwd: path.join(here, ".."), encoding: "utf8", timeout: 120_000 },
      );

      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      // Exit 2 is the bad-invocation code `arg()` already uses: the caller asked
      // for something the policy forbids, which is not a run that failed.
      expect(result.status).toBe(2);
      expect(output).toContain("not on this policy's allowlist");
      expect(output).toContain("no browser was launched");
      // The refusal is the allowlist's, not the network's.
      expect(output).not.toMatch(/net::ERR|Timeout .* exceeded|page\.goto/);
      // And nothing was created: refusing before the run means refusing before
      // the evidence directory, so there is no half-run to mistake for one.
      expect(existsSync(path.join(root, "allowlist-refused"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  it("rejects a malformed input without touching the browser at all", async () => {
    // Eight digits; the capability's pattern demands nine.
    await fetch(`${ENTRY}__admin/reset`, { method: "POST" });
    const lease = new ControlLease(() => new Date().toISOString());
    const log = new EventSequencer({
      runId: "it-bad",
      phase: "replay",
      now: () => new Date().toISOString(),
      controlOwner: () => lease.holder,
    });
    // No surface is ever constructed: if validation touched the UI, this would throw.
    const surface = new GatedSurface(new BoundSurface(null as never, binding), policy, lease);

    const result = await replay(
      capability,
      binding,
      { member_id: "40020010" },
      { surface, lease, log, runId: "it-bad", budgets: { stepMs: 8000, runMs: 40000 }, now: () => Date.now() },
    );

    expect(result.status).toBe("failed");
    if (result.status !== "failed") return;
    expect(result.kind).toBe("input_schema_violation");
    expect(result.stepRef).toBeNull();
    expect(result.remediation).toBe("retry_safe");
    expect(result.sideEffectRisk).toBe("none");
  }, 30000);
});
