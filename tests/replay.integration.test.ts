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
import { readFileSync } from "node:fs";
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

const PORT = 7108;
const ENTRY = `http://localhost:${PORT}/`;
const here = path.dirname(fileURLToPath(import.meta.url));
const load = (name: string): unknown => JSON.parse(readFileSync(path.join(here, "fixtures", name), "utf8"));

const policy = PolicyDocument.parse({
  version: "1.0.0",
  allowedOrigins: [ENTRY.replace(/\/$/, "")],
  deniedRoutes: ["/__admin"],
  allowedActions: ["navigate", "click", "fill", "press", "dismiss_dialog"],
  screenRules: [],
  riskHandling: { read_only: "allow", reversible: "allow", irreversible: "confirm" },
  caps: { maxSteps: 40, maxRunSeconds: 60 },
});

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
  await new Promise<void>((resolve) => server.listen(PORT, resolve));
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
