/**
 * THE CONTROL TRANSFER, AGAINST A REAL BROWSER AND A REAL APP — §3.6.
 *
 * `tests/gate.test.ts` proves the lease refuses. This proves the other half, the
 * half that is easy to fake: that the person gets THE SAME LIVE SESSION.
 *
 * That property fails silently. A handoff that quietly opens a second browser
 * renders exactly the same screens, and every assertion about "the human did the
 * step" still passes. So it is asserted three independent ways here, and all
 * three are mechanical:
 *
 *   1. FORM STATE CARRIES THROUGH. Automation types the member id; the human —
 *      who never types it — presses submit; the results screen comes back
 *      carrying that member. A fresh session's search box would have been empty
 *      and the mock would have answered "NO RECORDS MATCH SELECTION — MSG 0071".
 *      This is the strongest of the three because it is the APPLICATION, not the
 *      test, reporting that the two actors shared one document.
 *   2. NOTHING WAS CREATED. Context and page counts are identical across the turn.
 *   3. READS STAY LIVE. The value automation typed is still readable mid-turn,
 *      from the same driver, while automation is locked out of acting.
 *
 * ── THE SCRIPTED OPERATOR IS NOT A STUB ─────────────────────────────────────
 *
 * The "human" here is a function that drives the SAME `PlaywrightSurface`
 * instance the run is using — same browser, same context, same page — and
 * performs the step the policy refused. A stand-in that returned a canned
 * outcome without touching the session would prove nothing whatsoever about
 * control transfer, so there is no such stub in this file. The only thing
 * simulated is WHO SUPPLIES THE INPUT; every mechanism it flows through — the
 * lease, the driver's turn lock, the gate, the banner plumbing, the hand-back
 * channel — is the production one.
 *
 * THE BANNER IS ASSERTED HERE, AND THIS SUITE CANNOT CATCH THE BUG THAT BROKE IT.
 * Both halves are measured, and the second matters more than the first.
 *
 * Asserted below: the banner reaches the page through the ordinary perception
 * path, and it goes away again on hand-back.
 *
 * NOT pinned: the failure that actually shipped. The in-page banner died in every
 * frame with `ReferenceError: __name is not defined` — esbuild's keep-names
 * transform rewrites a nested named function, and `__name` does not exist in the
 * page — which makes it a property of the TRANSPILER rather than of the banner.
 * `tsx` sets `keepNames: true` and runs every production entry point in
 * package.json; vite, which vitest uses, sets `keepNames: false`. MEASURED on
 * this tree: restore the old nested `const render =` body and THIS FILE still
 * passes 4/4, while the same source under `tsx` reports the banner absent in all
 * three frames and logs the ReferenceError once per frame. A keep-names-only
 * regression is therefore green here and broken in production. What guards it is
 * the rule stated on `paintBanner` in `src/surface/playwright.ts` and the
 * per-frame failure `notice()` now LOGS instead of swallowing; closing it
 * mechanically needs a check that runs under `tsx`, which does not exist yet.
 *
 * WHAT STILL GENUINELY NEEDS A PERSON: whether the banner is LEGIBLE — placement,
 * contrast, whether it covers a field the operator needs — and whether a finger
 * on HAND BACK feels right. Those are the operator-UI half §3.6 explicitly
 * permits to be mocked.
 *
 * Headless, no model, no key. This runs in CI.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../mock/main.js";
import { tenantA } from "../mock/tenant.js";
import { Binding, resolve } from "../src/capability/bind.js";
import { parseCapability, type Capability, type TargetDescriptor } from "../src/capability/schema.js";
import { ControlLease, ControlViolation } from "../src/control/lease.js";
import { PolicyDocument } from "../src/policy/policy.js";
import { BoundSurface } from "../src/surface/bound.js";
import { GatedSurface } from "../src/surface/gated.js";
import { PlaywrightSurface } from "../src/surface/playwright.js";
import type { HandbackSignal } from "../src/surface/session.js";
import { SurfaceRefused, type ActionContext } from "../src/surface/types.js";

/**
 * AN EPHEMERAL PORT, NOT A FIXED ONE.
 *
 * This suite used to bind 7109. A hardcoded port is green on a clean machine and
 * fails on a busy one — and it fails badly, because `server.listen` here has no
 * error handler, so an EADDRINUSE surfaces as an unhandled rejection rather than
 * as "the port was taken". Worse, it can bind a port some OTHER process owns and
 * then drive a browser against whatever that process serves.
 *
 * Port 0 asks the OS for a free port, which is what `tests/mock-app.test.ts` and
 * `scripts/demo.ts` already do. `ENTRY` is therefore only knowable after the
 * listen, so it and the two policies built from it are assigned in `beforeAll`.
 */
let ENTRY = "";
const MEMBER = "400200101";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (name: string): unknown => JSON.parse(readFileSync(path.join(here, "fixtures", name), "utf8"));

const policyBase = (entry: string) => ({
  version: "1.0.0",
  allowedOrigins: [entry.replace(/\/$/, "")],
  deniedRoutes: ["/__admin"],
  allowedActions: ["navigate", "click", "fill", "press", "dismiss_dialog"],
  riskHandling: { read_only: "allow", reversible: "allow", irreversible: "confirm" },
  caps: { maxSteps: 40, maxRunSeconds: 60 },
});

/** The shipped policy: nothing on this capability escalates. */
let permissive: PolicyDocument;

/**
 * The demo policy, in the same shape as `tests/fixtures/policy-escalate.json`.
 *
 * The artifact stays truthfully `read_only` and the POLICY rates the screen
 * riskier — the `riskDrift` case `resolveRisk` exists for. That is how this
 * suite reaches the escalation path WITHOUT lying in an artifact and WITHOUT a
 * mutating route, neither of which this mock has.
 */
let escalating: PolicyDocument;

let server: Server;
let capability: Capability;
let memberIdTarget: TargetDescriptor;
let submitTarget: TargetDescriptor;
const binding = Binding.parse(load("fcu@4.2.json"));

const ctx = (lease: ControlLease, over: Partial<ActionContext> = {}): ActionContext => ({
  stepRef: "s02",
  risk: "read_only",
  actor: lease.holder,
  epoch: lease.epoch,
  url: `${ENTRY}screen/search`,
  screen: "MEMBER_SEARCH",
  ...over,
});

/** Poll a perception until it says what we are waiting for. The mock is fast; this is a guard, not a sleep. */
const until = async (
  driver: PlaywrightSurface,
  binding_: Binding,
  predicate: (text: string) => boolean,
  what: string,
): Promise<string> => {
  const bound = new BoundSurface(driver, binding_);
  for (let i = 0; i < 40; i += 1) {
    const observation = await bound.observe().catch(() => null);
    if (observation && predicate(observation.text)) return observation.text;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};

interface Stack {
  readonly driver: PlaywrightSurface;
  readonly lease: ControlLease;
  /** The run's own gate, under the shipped policy. */
  readonly automation: GatedSurface;
  /** The same live session, seen through the demo policy that escalates. */
  readonly underDemoPolicy: GatedSurface;
}

const launch = async (): Promise<Stack> => {
  await fetch(`${ENTRY}__admin/reset`, { method: "POST" });
  const driver = await PlaywrightSurface.launch(ENTRY, { headed: false });
  const lease = new ControlLease(() => new Date().toISOString());
  const bound = new BoundSurface(driver, binding);
  return {
    driver,
    lease,
    automation: new GatedSurface(bound, permissive, lease),
    underDemoPolicy: new GatedSurface(bound, escalating, lease),
  };
};

beforeAll(async () => {
  capability = parseCapability(load("lookup@1.0.0.json"));
  const resolved = resolve(capability, binding);
  const byId = new Map(resolved.targets.map((t) => [t.id, t]));
  const member = byId.get("MEMBER_ID");
  const submit = byId.get("SUBMIT");
  if (!member || !submit) throw new Error("fixture does not declare MEMBER_ID and SUBMIT");
  memberIdTarget = member;
  submitTarget = submit;

  server = createServer(tenantA);
  await new Promise<void>((r) => server.listen(0, r));
  ENTRY = `http://localhost:${(server.address() as AddressInfo).port}/`;

  // Built here rather than at module scope: the origin is not knowable until the
  // OS has handed out a port, and an allowlist naming the wrong origin would
  // deny every action in the suite.
  permissive = PolicyDocument.parse({ ...policyBase(ENTRY), screenRules: [] });
  escalating = PolicyDocument.parse({
    ...policyBase(ENTRY),
    screenRules: [{ screen: "MEMBER_SEARCH", risk: "irreversible" }],
  });
}, 60000);

afterAll(() => {
  server?.close();
});

describe("§3.6 handoff: the human operates the same live session", () => {
  it("cedes, lets a person finish the refused step IN THE SAME SESSION, and resumes", async () => {
    const { driver, lease, automation, underDemoPolicy } = await launch();
    try {
      /* ---- 1. automation establishes state a fresh session could not have ---- */
      await automation.act(
        { kind: "fill", target: memberIdTarget, value: MEMBER },
        ctx(lease, { stepRef: "s01", field: "MEMBER_ID" }),
      );
      expect(await driver.read(memberIdTarget)).toBe(MEMBER);

      const before = driver.sessionFingerprint();

      /* ---- 2. THE RAISE TRIGGER, measured rather than assumed ---------------- */
      // This is the production trigger: a policy refusal carrying requires:"human",
      // which the executor routes to escalation instead of to a hard failure.
      const refusal = await underDemoPolicy
        .act({ kind: "click", target: submitTarget }, ctx(lease))
        .then(() => null)
        .catch((e: unknown) => e);

      expect(refusal).toBeInstanceOf(SurfaceRefused);
      expect((refusal as SurfaceRefused).detail).toMatchObject({
        requires: "human",
        effectiveRisk: "irreversible",
        // The artifact claimed read_only and the policy rated it higher. An
        // artifact may never talk its risk DOWN; here the policy talks it UP.
        riskDrift: true,
      });
      // Refused before it ran: the search has not been submitted.
      expect(await driver.read(memberIdTarget)).toBe(MEMBER);

      /* ---- 3. CEDE: lease first, then the driver's own lock, then the banner - */
      expect(lease.epoch).toBe(0);
      lease.cede("escalation: s02 requires a human decision");
      expect(lease.epoch).toBe(1);
      expect(lease.holder).toBe("human");

      await driver.beginHumanTurn();
      const NOTICE = `RUN ${capability.contract.id} PAUSED — you have control. Complete step s02, then press HAND BACK.`;
      await driver.notice(NOTICE, {
        frameName: binding.frames.content,
        urlPattern: "/screen/",
      });

      /**
       * THE BANNER IS ON SCREEN — asserted through `observe()`, the same
       * perception path every other step uses, because the banner is appended to
       * the frame's body and therefore shows up in the page text a human would
       * read.
       *
       * SCOPED, because the obvious reading is wrong: this pins that the paint
       * path works UNDER THIS RUNNER. It would not have caught the failure that
       * shipped — `ReferenceError: __name is not defined`, swallowed by a bare
       * `.catch` — because that error exists only when the transpiler sets
       * `keepNames`, which `tsx` does for every production entry point and vite
       * does not for this suite. Measured both ways; the file header carries the
       * numbers.
       */
      const painted = await driver.observe();
      expect(painted.text).toContain("PAUSED — you have control");
      expect(painted.text).toContain("HAND BACK");

      /* ---- 4. while the human holds it: two independent refusals ------------- */

      // (a) The LEASE refuses the run's own gate.
      await expect(automation.act({ kind: "click", target: submitTarget }, ctx(lease, { actor: "automation" }))).rejects.toBeInstanceOf(
        ControlViolation,
      );

      // (b) THE INDEPENDENCE OF THE SECOND POINT. A brand-new lease that believes
      //     automation holds control, at a current epoch, passing a permissive
      //     policy — every check in the gate is satisfied. The DRIVER still
      //     refuses, on its own flag, sharing no state with any lease. This is
      //     what makes a bug in the lease unable to cause a double-actor write.
      const naiveLease = new ControlLease(() => new Date().toISOString());
      const naiveGate = new GatedSurface(new BoundSurface(driver, binding), permissive, naiveLease);
      expect(naiveLease.holder).toBe("automation");
      await expect(naiveGate.act({ kind: "click", target: submitTarget }, ctx(naiveLease))).rejects.toMatchObject({
        reason: "control_violation",
        detail: { point: "driver" },
      });

      // Neither refusal touched the app: still on the search screen, id intact.
      expect(await driver.read(memberIdTarget)).toBe(MEMBER);

      // (c) Reads stay open, which is what lets the console show live state and
      //     the run resynchronise afterwards.
      const midTurn = await driver.observe();
      expect(midTurn.text).toContain("MBR0300");

      /* ---- 5. THE SCRIPTED OPERATOR — a function driving the real session ---- */
      const operator = async (): Promise<HandbackSignal> => {
        const pending = driver.awaitHandback({ timeoutMs: 15_000 });
        // The person performs the step the policy refused, in the live session.
        await driver.humanAction({ kind: "click", target: submitTarget });
        await until(driver, binding, (t) => t.includes("MBR0310"), "the results screen after the human's click");
        // ...then presses HAND BACK. This resolves the promise the run is on.
        expect(driver.signalHandback({ kind: "handed_back", operator: "op.rivera", note: "submitted by hand" })).toBe(true);
        return pending;
      };

      const signal = await operator();
      expect(signal).toEqual({ kind: "handed_back", operator: "op.rivera", note: "submitted by hand" });

      /* ---- 6. hand back ------------------------------------------------------ */
      await driver.endHumanTurn();

      // ...AND THE BANNER IS GONE. The complement of the assertion above, and
      // what makes it non-vacuous: a test that only ever checked for presence
      // would pass against a banner painted once and never cleared, which would
      // leave an operator being told they hold a session automation has taken
      // back.
      const cleared = await driver.observe();
      expect(cleared.text).not.toContain("PAUSED — you have control");
      lease.reclaim("operator handed back");
      expect(lease.epoch).toBe(2);
      expect(lease.holder).toBe("automation");

      /* ---- 7. SAME SESSION, proven three ways -------------------------------- */

      // (1) THE APPLICATION reports it: the human never typed the member id, yet
      //     the results carry it. A fresh session would have submitted an empty
      //     box and come back with MSG 0071.
      const results = await until(driver, binding, (t) => t.includes("MBR0310"), "the results screen");
      expect(results).toContain(MEMBER);
      expect(results).not.toContain("MSG 0071");

      // (2) Nothing was created to serve the human.
      const after = driver.sessionFingerprint();
      expect(after.contexts).toBe(before.contexts);
      expect(after.pages).toBe(before.pages);
      expect(after.pages).toBe(1);

      // (3) The control journal is the audit of the transfer itself (§3.6-d).
      expect(lease.transitions.map((t) => `${t.from}->${t.to}`)).toEqual(["automation->human", "human->automation"]);

      /* ---- 8. automation acts again ONLY after the reclaim -------------------- */
      const bound = new BoundSurface(driver, binding);
      const resumed = await bound.observe();
      expect(resumed.screen).toBe("MEMBER_RESULTS");
      // The step's postcondition — which IS the re-synchronisation §3.6 requires.
      await expect(
        automation.act({ kind: "navigate", target: submitTarget }, ctx(lease, { screen: "MEMBER_RESULTS" })),
      ).rejects.toBeInstanceOf(SurfaceRefused); // no SUBMIT on the results screen: the target is gone, not the permission
    } finally {
      await driver.close();
    }
  }, 90000);

  it("TIMES OUT rather than hanging when nobody comes, and journals why", async () => {
    const { driver, lease } = await launch();
    try {
      lease.cede("escalation: nobody is watching");
      await driver.beginHumanTurn();

      const signal = await driver.awaitHandback({ timeoutMs: 250 });
      expect(signal).toEqual({ kind: "timed_out" });

      // `expire()` is distinct from `reclaim()` precisely because nobody resolved
      // anything, and the run must fail with its own kind rather than continue.
      lease.expire();
      expect(lease.holder).toBe("automation");
      expect(lease.transitions.at(-1)?.reason).toBe("escalation_timeout");

      await driver.endHumanTurn();
    } finally {
      await driver.close();
    }
  }, 60000);

  it("distinguishes ABORT from a hand-back, so the run can fail differently", async () => {
    const { driver, lease } = await launch();
    try {
      lease.cede("escalation");
      await driver.beginHumanTurn();

      const pending = driver.awaitHandback({ timeoutMs: 15_000 });
      expect(driver.signalHandback({ kind: "aborted", operator: "op.rivera", note: "should not be submitted" })).toBe(true);
      expect(await pending).toMatchObject({ kind: "aborted", operator: "op.rivera" });

      // A second press has nothing left to resolve, and says so rather than
      // resolving a settled promise twice.
      expect(driver.signalHandback({ kind: "handed_back", operator: "op.rivera" })).toBe(false);

      await driver.endHumanTurn();
      lease.reclaim("operator aborted");
    } finally {
      await driver.close();
    }
  }, 60000);

  it("refuses a human action OUTSIDE a turn — the exact mirror of act()", async () => {
    const { driver } = await launch();
    try {
      // Nobody has been ceded this session, so there is no person to attribute
      // this to. act() is refused DURING a turn; this is refused outside one.
      await expect(driver.humanAction({ kind: "click", target: submitTarget })).rejects.toMatchObject({
        reason: "control_violation",
        detail: { point: "driver" },
      });
      // And the ordinary automation path is unaffected.
      expect(await driver.read(memberIdTarget)).toBe("");
    } finally {
      await driver.close();
    }
  }, 60000);
});
