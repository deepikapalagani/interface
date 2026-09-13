/**
 * THE DISCOVERY LOOP — driven by a scripted provider, no key and no browser.
 *
 * A real discovery run costs money and needs a live model, so the loop's own
 * logic is proven here instead: a fake provider returns a fixed sequence of tool
 * calls, and a stub surface answers them. That makes the loop's control flow —
 * pruning, stop conditions, error recovery, step numbering — testable in
 * milliseconds and in CI.
 *
 * The property that gets the most attention is HISTORY PRUNING, because it is
 * the one that fails silently. Measured: keeping every snapshot costs ~686K
 * input tokens over 30 turns against ~136K keeping only the latest. If pruning
 * regressed, every test here would still pass and the only symptom would be a
 * surprise bill and a model confused by six stale copies of the same screen. So
 * it is asserted directly: older tool results must collapse to a summary while
 * the assistant/tool pairing the wire format requires stays intact.
 */
import { describe, expect, it } from "vitest";
import type { TargetDescriptor } from "../src/capability/schema.js";
import { RiskProfile } from "../src/compile/risk-profile.js";
import { isStepEntry } from "../src/discover/executor.js";
import { runDiscovery } from "../src/discover/loop.js";
import { EventSequencer } from "../src/evidence/events.js";
import type { ConverseOptions, ConverseResponse, ModelProvider, Turn, Usage } from "../src/model/provider.js";
import type {
  ActionContext,
  Observation,
  Resolution,
  Surface,
  SurfaceAction,
  TargetFacts,
} from "../src/surface/types.js";

const USAGE: Usage = { promptTokens: 100, completionTokens: 50 };
const RESOLVES: Resolution = { strategyUsed: "table_anchor", strategyExpected: "table_anchor", matched: 1, degraded: false };

const riskProfile = RiskProfile.parse({
  app: "MERIDIAN MSC",
  profileVersion: "test-profile@1",
  screens: [{ screen: "MEMBER_SEARCH", risk: "read_only", note: "a query form" }],
});

const observation = (over: Partial<Observation> = {}): Observation => ({
  location: "http://localhost:7101/screen/search",
  screen: "MEMBER_SEARCH",
  nodes: [
    { role: "textbox", name: "", ref: "f2e13", framePath: ["content"] },
    { role: "button", name: "SEARCH", ref: "f2e20", framePath: ["content"] },
  ],
  text: "MBR0300 MEMBER INQUIRY",
  dialog: null,
  digest: "d0",
  ...over,
});

/** Returns a scripted tool call per turn; records what history it was given. */
class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly seen: Turn[][] = [];
  private turn = 0;

  constructor(private readonly script: { name: string; args: Record<string, unknown> }[]) {}

  async converse(history: readonly Turn[], _o: ConverseOptions): Promise<ConverseResponse> {
    this.seen.push(history.map((t) => ({ ...t })));
    const next = this.script[this.turn++];
    return {
      text: "",
      toolCalls: next ? [{ id: `c${this.turn}`, name: next.name, args: next.args }] : [],
      raw: { role: "assistant" },
      usage: USAGE,
      stopReason: next ? "tool_calls" : "end_turn",
    };
  }
}

class StubSurface implements Surface {
  readonly acted: SurfaceAction[] = [];
  private calls = 0;
  constructor(private readonly screens: Observation[] = [observation()]) {}
  async observe(): Promise<Observation> {
    const o = this.screens[Math.min(this.calls, this.screens.length - 1)];
    this.calls += 1;
    return o ?? observation();
  }
  async find(_t: TargetDescriptor): Promise<Resolution | null> {
    return RESOLVES;
  }
  async describe(_ref: string): Promise<TargetFacts | null> {
    return { tag: "input", role: "", fieldName: "MBRNO", anchorText: "MEMBER ID", framePath: ["content"] };
  }
  async read(_t: TargetDescriptor): Promise<string | null> {
    return "400200101";
  }
  async act(a: SurfaceAction, _c: ActionContext): Promise<Resolution | null> {
    this.acted.push(a);
    return RESOLVES;
  }
  onDialog(): void {}
  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async close(): Promise<void> {}
}

/** A surface holding one dialog until it is answered — the recoverable interstitial. */
class DialogSurface extends StubSurface {
  private blocking = true;
  override async observe(): Promise<Observation> {
    return observation(this.blocking ? { dialog: { message: "SYSTEM BROADCAST: NIGHTLY MAINTENANCE 22:00" }, digest: "d-dialog" } : { digest: `d${Math.random()}` });
  }
  override async act(a: SurfaceAction, c: ActionContext): Promise<Resolution | null> {
    if (a.kind === "dismiss_dialog") this.blocking = false;
    return super.act(a, c);
  }
}

const target = { ref: "f2e13", screen_id: "MEMBER_SEARCH", why_stable: "beside the MEMBER ID label" };
const deps = (provider: ModelProvider, surface: Surface) => ({
  provider,
  surface,
  actor: () => "automation" as const,
  epoch: () => 0,
  riskProfile,
});

describe("discovery loop", () => {
  it("records executed steps and stops when the model declares the goal reached", async () => {
    const provider = new ScriptedProvider([
      { name: "type_text", args: { ...target, text: "400200101" } },
      { name: "click", args: { ...target, ref: "f2e20" } },
      { name: "finish", args: { summary: "found the member", checkpoint: "one row in the results grid" } },
    ]);
    const surface = new StubSurface();

    const result = await runDiscovery("Look up member 400200101", deps(provider, surface));

    expect(result.stopped).toBe("goal_reached");
    expect(result.trace).toHaveLength(2);
    expect(result.trace[0]?.tool).toBe("type_text");
    // Every recorded step carries a minted target keyed on the LITERAL the DOM
    // reported, never the ref it came from.
    expect(result.trace[0]?.target?.strategies[0]?.key).toBe("MEMBER ID");
    expect(JSON.stringify(result.trace)).not.toContain("f2e13");
  });

  it("PRUNES older observations while keeping the assistant/tool pairing valid", async () => {
    const provider = new ScriptedProvider([
      { name: "observe", args: {} },
      { name: "observe", args: {} },
      { name: "observe", args: {} },
      { name: "finish", args: { summary: "done", checkpoint: "visible" } },
    ]);

    await runDiscovery("look around", deps(provider, new StubSurface()));

    // The history handed over on the final turn is the one that matters.
    const last = provider.seen[provider.seen.length - 1] ?? [];
    const toolTurns = last.filter((t) => t.role === "tool");
    expect(toolTurns.length).toBeGreaterThan(1);

    const full = toolTurns.filter((t) => t.role === "tool" && t.content.includes("PAGE TEXT"));
    // Exactly one screen is rendered in full: the current one.
    expect(full).toHaveLength(1);
    expect(full[0]).toBe(toolTurns[toolTurns.length - 1]);

    // The collapsed ones are still present and still paired — not deleted.
    for (const t of toolTurns.slice(0, -1)) {
      expect(t.role === "tool" && t.callId).toBeTruthy();
      expect(t.role === "tool" && t.content.length).toBeLessThan(120);
    }
  });

  it("hands a malformed tool call back as a correction instead of failing the run", async () => {
    const provider = new ScriptedProvider([
      { name: "click", args: { ref: "f2e13" } }, // missing screen_id and why_stable
      { name: "click", args: { ...target, ref: "f2e20" } },
      { name: "finish", args: { summary: "recovered", checkpoint: "visible" } },
    ]);
    const surface = new StubSurface();

    const result = await runDiscovery("recover from a bad call", deps(provider, surface));

    expect(result.stopped).toBe("goal_reached");
    // The bad call was not recorded, and the good one that followed was.
    expect(result.trace).toHaveLength(1);
    expect(surface.acted).toHaveLength(1);
  });

  it("detects a dead end when the surface stops changing under repeated ACTIONS", async () => {
    // The model keeps acting with total confidence; the application does not move.
    const provider = new ScriptedProvider(
      Array.from({ length: 10 }, () => ({ name: "click", args: { ...target, ref: "f2e20" } })),
    );

    const result = await runDiscovery("click forever", deps(provider, new StubSurface()));

    expect(result.stopped).toBe("no_progress");
    expect(result.detail).toContain("did not change");
  });

  it("does NOT call consecutive perception turns a dead end, because no action was issued", async () => {
    // The detector's own detail says "the model is acting, the application is not
    // responding". Feeding it from `observe` made that a false statement about
    // what happened — and it terminated a run that had done nothing wrong.
    const provider = new ScriptedProvider(Array.from({ length: 10 }, () => ({ name: "observe", args: {} })));

    const result = await runDiscovery("look repeatedly", {
      ...deps(provider, new StubSurface()),
      limits: { maxSteps: 6, maxSeconds: 300, noProgressLimit: 2, repeatedErrorLimit: 3, maxTokens: 1_000_000 },
    });

    expect(result.stopped).toBe("max_steps");
  });

  it("stops at the step ceiling rather than running unbounded", async () => {
    const provider = new ScriptedProvider(Array.from({ length: 50 }, () => ({ name: "observe", args: {} })));
    const screens = Array.from({ length: 60 }, (_, i) => observation({ digest: `d${i}` }));

    const result = await runDiscovery("look forever", {
      ...deps(provider, new StubSurface(screens)),
      limits: { maxSteps: 5, maxSeconds: 300, noProgressLimit: 99, repeatedErrorLimit: 99, maxTokens: 1_000_000 },
    });

    expect(result.stopped).toBe("max_steps");
  });

  it("numbers the evidence from the STEP sequence, so a dialog does not shift every citation", async () => {
    // The loop used to cite `s0{trace.length}`, which counts dialog entries; the
    // compiler numbers the filtered step list. After any dialog, every evidence
    // stepRef therefore named a different step than the artifact has — on the arm
    // the event log sells as a citation a reviewer can open and check.
    const provider = new ScriptedProvider([
      { name: "dialog", args: { action: "dismiss", reason: "an operations broadcast" } },
      { name: "type_text", args: { ...target, text: "400200101" } },
      { name: "click", args: { ...target, ref: "f2e20" } },
      { name: "finish", args: { summary: "done", checkpoint: "visible" } },
    ]);
    const log = new EventSequencer({
      runId: "numbering",
      phase: "discovery",
      now: () => "1970-01-01T00:00:00.000Z",
      controlOwner: () => "automation",
    });

    const result = await runDiscovery("dismiss then search", { ...deps(provider, new DialogSurface()), log });

    expect(result.trace).toHaveLength(3);
    expect(result.trace.filter(isStepEntry)).toHaveLength(2);

    // The two recorded STEPS are cited s01 and s02 — the refs the compiler emits
    // for the same filtered list. The dialog cites no step at all.
    const cited = log.all.filter((e) => e.stepRef !== null).map((e) => e.stepRef);
    expect(cited).toEqual(["s01", "s02"]);
    expect(log.all.find((e) => e.event === "model.dialog")?.stepRef).toBeNull();
  });

  it("keeps the transcript for evidence and the trace for compilation, separately", async () => {
    const provider = new ScriptedProvider([
      { name: "click", args: { ...target, ref: "f2e20" } },
      { name: "finish", args: { summary: "done", checkpoint: "visible" } },
    ]);

    const result = await runDiscovery("do one thing", deps(provider, new StubSurface()));

    // The compiler reads the trace only; the transcript exists so a reviewer can
    // see what the model was actually told and actually said.
    expect(result.trace).toHaveLength(1);
    expect(result.transcript.length).toBeGreaterThan(result.trace.length);
    expect(result.transcript[0]?.role).toBe("system");
    expect(result.usage.completionTokens).toBeGreaterThan(0);
  });
});
