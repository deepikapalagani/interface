/**
 * THE THROUGH-LINE, END TO END.
 *
 *     "The model discovers. The artifact becomes a reusable capability.
 *      Deterministic replay is how the AI agent invokes it in production."
 *                                                        — §2, the spec's own words
 *
 * This test is that sentence, executed:
 *
 *   1. a loop drives the REAL mock through a REAL browser and records a trace;
 *   2. the compiler turns that trace — never the transcript — into an artifact,
 *      rating every step against the SHIPPED risk profile;
 *   3. the schema accepts it, with all twelve safety refinements applied;
 *   4. `replay()` executes that artifact against the app and reaches its
 *      checkpoint, with zero model calls.
 *
 * The model is scripted rather than live, so this runs in CI with no API key and
 * costs nothing. What is NOT faked is everything that matters: the browser, the
 * frameset, the minting of durable targets from refs, the schema, the gate, and
 * the replay engine. A genuine model-driven run is a separate exercise; this
 * proves the machinery it feeds.
 *
 * THE PORT IS EPHEMERAL, and that is not a detail. This suite used to bind 7111
 * with no listen error handler, so it was green on a clean machine and failed
 * with EADDRINUSE on a busy one — including against a reviewer who happened to
 * have something on that port. The repo's own scripts bind port 0; so does this.
 */
import type { Server } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "../mock/main.js";
import { tenantA } from "../mock/tenant.js";
import { Binding } from "../src/capability/bind.js";
import { safeParseCapability } from "../src/capability/schema.js";
import { compileMechanical } from "../src/compile/mechanical.js";
import { DEFAULT_RISK_PROFILE_PATH, loadRiskProfile } from "../src/compile/risk-profile.js";
import { ControlLease } from "../src/control/lease.js";
import { runDiscovery } from "../src/discover/loop.js";
import { EventSequencer } from "../src/evidence/events.js";
import type { ConverseOptions, ConverseResponse, ModelProvider, Turn, Usage } from "../src/model/provider.js";
import { PolicyDocument } from "../src/policy/policy.js";
import { replay } from "../src/replay/index.js";
import { BoundSurface } from "../src/surface/bound.js";
import { GatedSurface } from "../src/surface/gated.js";
import { PlaywrightSurface } from "../src/surface/playwright.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const binding = Binding.parse(JSON.parse(readFileSync(path.join(here, "fixtures", "fcu@4.2.json"), "utf8")));
/** The profile the shipped CLI loads. Using it here is also what pins that it covers this flow. */
const riskProfile = loadRiskProfile(DEFAULT_RISK_PROFILE_PATH);

let server: Server;
let entry: string;

const policyFor = (target: string): PolicyDocument =>
  PolicyDocument.parse({
    version: "1.0.0",
    allowedOrigins: [target.replace(/\/$/, "")],
    deniedRoutes: ["/__admin"],
    allowedActions: ["navigate", "click", "fill", "press", "dismiss_dialog"],
    screenRules: [],
    riskHandling: { read_only: "allow", reversible: "allow", irreversible: "confirm" },
    caps: { maxSteps: 40, maxRunSeconds: 60 },
  });

/**
 * Stands in for the model. It cannot know refs in advance — they are minted per
 * observation — so each scripted step names the control it wants by matching the
 * rendered CONTROLS list, exactly as a model would read it.
 */
type Pick = { tool: string; match: RegExp; extra?: Record<string, unknown> } | { tool: "finish"; args: Record<string, unknown> };

class ScriptedModel implements ModelProvider {
  readonly id = "scripted";
  readonly picked: string[] = [];
  private turn = 0;

  constructor(private readonly script: Pick[]) {}

  async converse(history: readonly Turn[], _o: ConverseOptions): Promise<ConverseResponse> {
    const step = this.script[this.turn++];
    const usage: Usage = { promptTokens: 120, completionTokens: 40 };
    const none: ConverseResponse = { text: "", toolCalls: [], raw: { role: "assistant" }, usage, stopReason: "end_turn" };
    if (!step) return none;

    if ("args" in step) {
      return { ...none, toolCalls: [{ id: `c${this.turn}`, name: step.tool, args: step.args }], stopReason: "tool_calls" };
    }

    // Read the latest observation the loop rendered, and pick a ref from it.
    const latest = [...history].reverse().find((t) => (t.role === "tool" || t.role === "user") && "content" in t && t.content.includes("CONTROLS"));
    const text = latest && "content" in latest ? latest.content : "";
    const screen = /SCREEN: (\S+)/.exec(text)?.[1] ?? "";
    const line = text.split("\n").find((l) => step.match.test(l));
    const ref = line ? /\[ref=([^\]]+)\]/.exec(line)?.[1] : undefined;
    this.picked.push(`${step.tool}:${ref ?? "NONE"}:${line?.trim() ?? "(no matching control)"}`);

    if (!ref) return none;
    return {
      ...none,
      toolCalls: [
        {
          id: `c${this.turn}`,
          name: step.tool,
          args: { ref, screen_id: screen, why_stable: "anchored on its label in the form", ...(step.extra ?? {}) },
        },
      ],
      stopReason: "tool_calls",
    };
  }
}

const stack = (driver: PlaywrightSurface) => {
  const lease = new ControlLease(() => new Date().toISOString());
  const log = new EventSequencer({
    runId: "roundtrip",
    phase: "replay",
    now: () => new Date().toISOString(),
    controlOwner: () => lease.holder,
  });
  return { lease, log, surface: new GatedSurface(new BoundSurface(driver, binding), policyFor(entry), lease) };
};

beforeAll(async () => {
  server = createServer(tenantA);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  entry = `http://localhost:${port}/`;
}, 60000);

afterAll(() => server?.close());

describe("discover -> compile -> replay", () => {
  it("records a run, compiles it into a valid artifact, and replays that artifact", async () => {
    // ---- 1. DISCOVER -------------------------------------------------------
    await fetch(`${entry}__admin/reset`, { method: "POST" });
    // Picks controls the way a model now can: by the label rendered beside them.
    // Matching a bare role would reach for the nav frame's quick-lookup box,
    // which is indistinguishable from the member-id field without its label.
    const model = new ScriptedModel([
      { tool: "type_text", match: /labelled "MEMBER ID"/, extra: { text: "400200101" } },
      { tool: "click", match: /field=SUBMIT/ },
      { tool: "finish", args: { summary: "member located", checkpoint: "the results grid is showing" } },
    ]);

    const driver = await PlaywrightSurface.launch(entry, { headed: false });
    let discovery;
    try {
      const { surface } = stack(driver);
      discovery = await runDiscovery("Look up member 400200101", {
        provider: model,
        surface,
        actor: () => "automation" as const,
        epoch: () => 0,
        riskProfile,
      });
    } finally {
      await driver.close();
    }

    if (discovery.trace.length < 2) {
      // The errors are the whole diagnosis: a run that declares success while
      // recording nothing has always failed inside a tool call.
      console.error("DISCOVERY:", discovery.summary);
      console.error("picked:", model.picked);
      console.error("errors:", discovery.errors);
    }
    expect(discovery.stopped).toBe("goal_reached");
    expect(discovery.trace.length).toBeGreaterThanOrEqual(2);
    // Minted, never the ref it came from.
    expect(JSON.stringify(discovery.trace)).not.toMatch(/"key":\s*"f?\d*e\d+"/);

    // ---- 2. COMPILE (from the trace, never the transcript) ------------------
    const draft = compileMechanical({
      trace: discovery.trace,
      goal: "Look up a member by id and reach the results screen.",
      capabilityId: "msc.member.lookup",
      version: "1.0.0",
      app: "MERIDIAN MSC",
      model: model.id,
      appProfileVersion: "meridian-msc@4.2",
      discoveredAt: "2026-09-12T00:00:00Z",
      binding,
      riskProfile,
    });

    // ---- 3. THE SCHEMA MUST ACCEPT IT --------------------------------------
    const parsed = safeParseCapability(draft);
    if (!parsed.success) {
      console.error("COMPILED ARTIFACT REJECTED:\n" + parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n"));
      console.error(JSON.stringify(draft, null, 1).slice(0, 2500));
    }
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.provenance.traceDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(parsed.data.verification.replayResult).toBe("not_yet_verified");

    // The plan speaks SYMBOLS, resolved from the literals minting recorded.
    expect(parsed.data.plan.targets.map((t) => t.id).sort()).toEqual(["MEMBER_ID", "SUBMIT"]);
    // Risk came from the profile, which rates this flow's screen read_only, and
    // refinement 7 forces the contract to equal the maximum over the steps.
    expect(parsed.data.plan.steps.every((s) => s.risk === "read_only")).toBe(true);
    expect(parsed.data.contract.risk).toBe("read_only");

    // ---- 4. REPLAY THE COMPILED ARTIFACT ------------------------------------
    await fetch(`${entry}__admin/reset`, { method: "POST" });
    const replayDriver = await PlaywrightSurface.launch(entry, { headed: false });
    try {
      const { lease, log, surface } = stack(replayDriver);
      const result = await replay(parsed.data, binding, {}, {
        surface,
        lease,
        log,
        runId: "roundtrip-replay",
        budgets: { stepMs: 8000, runMs: 40000 },
        now: () => Date.now(),
      });

      if (result.status !== "success") console.error("REPLAY:", JSON.stringify(result, null, 1));
      expect(result.status).toBe("success");
      // The whole point: the production path ran the model's discovery without a model.
      expect(result.modelCalls).toBe(0);
    } finally {
      await replayDriver.close();
    }
  }, 120000);
});
