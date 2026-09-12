/**
 * LEASE ENFORCEMENT — the test that makes the control model a mechanism.
 *
 * §7 says the human-in-the-loop path must be "a real, well-reasoned mechanism …
 * not just a TODO". The difference between a mechanism and a status field is
 * exactly this: when a human holds the session, an automation action must FAIL,
 * and — the assertion that actually matters — must not reach the target at all.
 *
 * This runs headless against a stub surface, so it belongs in CI rather than in
 * the one manual demo. The stub records every call that reaches it, which is how
 * "no mutation occurred" is asserted rather than assumed.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ControlLease, ControlViolation } from "../src/control/lease.js";
import { GatedSurface } from "../src/surface/gated.js";
import { PolicyDocument } from "../src/policy/policy.js";
import { SurfaceRefused, type ActionContext, type Observation, type Resolution, type Surface, type SurfaceAction } from "../src/surface/types.js";
import type { TargetDescriptor } from "../src/capability/schema.js";

/** Records everything that reaches the target, so "nothing happened" is checkable. */
class StubSurface implements Surface {
  readonly acted: SurfaceAction[] = [];
  readonly reads: string[] = [];

  async observe(): Promise<Observation> {
    this.reads.push("observe");
    return {
      location: "http://localhost:7101/screen/search",
      screen: "MEMBER_SEARCH",
      nodes: [],
      text: "MBR0300",
      dialog: null,
      digest: "abc",
    };
  }
  async find(_t: TargetDescriptor): Promise<Resolution | null> {
    this.reads.push("find");
    return { strategyUsed: "table_anchor", strategyExpected: "table_anchor", matched: 1, degraded: false };
  }
  async describe(_ref: string): Promise<null> {
    return null;
  }
  async read(_t: TargetDescriptor): Promise<string | null> {
    this.reads.push("read");
    return "CNF4401";
  }
  async act(action: SurfaceAction, _ctx: ActionContext): Promise<Resolution | null> {
    this.acted.push(action);
    return { strategyUsed: "table_anchor", strategyExpected: "table_anchor", matched: 1, degraded: false };
  }
  onDialog(_h: (m: string) => void): void {}
  async screenshot(): Promise<Uint8Array> {
    this.reads.push("screenshot");
    return new Uint8Array();
  }
  async close(): Promise<void> {}
}

const policy = PolicyDocument.parse({
  version: "1.0.0",
  allowedOrigins: ["http://localhost:7101"],
  deniedRoutes: ["/__admin"],
  allowedActions: ["navigate", "click", "fill", "press", "dismiss_dialog"],
  screenRules: [{ screen: "CARD_SERVICES", deniedFields: ["OVERRIDE_CODE"], risk: "irreversible" }],
  riskHandling: { read_only: "allow", reversible: "allow", irreversible: "confirm" },
  caps: { maxSteps: 40, maxRunSeconds: 300 },
});

const target = { id: "MEMBER_ID" } as unknown as TargetDescriptor;
const action: SurfaceAction = { kind: "click", target };

describe("gated surface", () => {
  let stub: StubSurface;
  let lease: ControlLease;
  let gated: GatedSurface;

  beforeEach(() => {
    stub = new StubSurface();
    lease = new ControlLease(() => "2026-03-02T14:05:00Z");
    gated = new GatedSurface(stub, policy, lease);
  });

  /**
   * Builds an action context the way a caller does: reading the epoch AT BUILD
   * TIME. It lives inside the describe for that reason — a context built once at
   * module load would freeze epoch 0 and make the fence below untestable.
   */
  const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
    stepRef: "s02",
    risk: "read_only",
    actor: "automation",
    epoch: lease.epoch,
    url: "http://localhost:7101/screen/search",
    screen: "MEMBER_SEARCH",
    ...over,
  });

  it("permits a legal action while automation holds the lease", async () => {
    await gated.act(action, ctx());
    expect(stub.acted).toHaveLength(1);
  });

  it("REFUSES an automation action while a human holds the session, and nothing reaches the target", async () => {
    lease.cede("escalation: irreversible step");
    await expect(gated.act(action, ctx())).rejects.toBeInstanceOf(ControlViolation);
    // The assertion that matters: not merely that it threw, but that the target
    // was never touched. A gate that throws after acting is not a gate.
    expect(stub.acted).toHaveLength(0);
  });

  it("permits the identical action once control is handed back", async () => {
    lease.cede("escalation");
    await expect(gated.act(action, ctx())).rejects.toBeInstanceOf(ControlViolation);
    lease.reclaim("human handed back");
    await gated.act(action, ctx());
    expect(stub.acted).toHaveLength(1);
  });

  it("denies the admin plane, without reaching the target", async () => {
    await expect(gated.act(action, ctx({ url: "http://localhost:7101/__admin/reset" }))).rejects.toBeInstanceOf(SurfaceRefused);
    expect(stub.acted).toHaveLength(0);
  });

  it("routes an irreversible step to a human rather than performing it", async () => {
    await expect(gated.act(action, ctx({ screen: "CARD_SERVICES" }))).rejects.toMatchObject({
      reason: "policy_denied",
      detail: { requires: "human", effectiveRisk: "irreversible", riskDrift: true },
    });
    expect(stub.acted).toHaveLength(0);
  });

  it("checks CONTROL before policy — the documented ordering, not an accident", async () => {
    // Both would refuse this: the human holds the lease AND the route is denied.
    lease.cede("escalation");
    await expect(gated.act(action, ctx({ url: "http://localhost:7101/__admin/reset" }))).rejects.toBeInstanceOf(ControlViolation);
  });

  it("read paths still work during a handoff, so the run can resynchronise afterwards", async () => {
    lease.cede("escalation");
    await gated.observe();
    await gated.find(target);
    await gated.read(target);
    expect(stub.reads).toEqual(["observe", "find", "read"]);
    expect(stub.acted).toHaveLength(0);
  });

  it("records every gate decision, allowed and denied alike", async () => {
    const seen: string[] = [];
    const audited = new GatedSurface(stub, policy, lease, (e) => seen.push(`${e.action}:${e.decision.allow}`));
    await audited.act(action, ctx());
    await expect(audited.act(action, ctx({ url: "http://localhost:7101/__admin/reset" }))).rejects.toBeTruthy();
    expect(seen).toEqual(["click:true", "click:false"]);
  });

  it("FENCES an action built in a previous era, and records no gate decision for it", async () => {
    const seen: string[] = [];
    const audited = new GatedSurface(stub, policy, lease, (e) => seen.push(e.action));

    // Built while automation held the session, at epoch 0.
    const stale = ctx();
    lease.cede("escalation: irreversible step");
    lease.reclaim("human handed back");

    // Automation holds the lease again and the action is entirely legal, so the
    // epoch is the ONLY thing left that can refuse it. Before the fence existed
    // this call succeeded, which is what made `isCurrent` decorative.
    await expect(audited.act(action, stale)).rejects.toBeInstanceOf(ControlViolation);
    expect(stub.acted).toHaveLength(0);
    // The control checks run before the policy does, so no permission verdict was
    // ever computed — and an audit line claiming one would be a fabrication.
    expect(seen).toEqual([]);
  });

  it("REFUSES when the caller's view of control disagrees with the lease", async () => {
    // Automation genuinely holds the lease, so `assertAutomation` is satisfied; a
    // caller that nonetheless believes a human is driving is working from a stale
    // view, and acting on it is the defect being caught.
    await expect(gated.act(action, ctx({ actor: "human" }))).rejects.toBeInstanceOf(ControlViolation);
    expect(stub.acted).toHaveLength(0);
  });

  it("does NOT misfire: a fresh action after a full cede/reclaim cycle still acts", async () => {
    // The complement of the fence. A check that refuses everything would pass the
    // test above while breaking every handoff, so the recovery case is pinned too.
    lease.cede("escalation");
    lease.reclaim("human handed back");
    expect(lease.epoch).toBe(2);

    await gated.act(action, ctx());
    expect(stub.acted).toHaveLength(1);
  });
});
