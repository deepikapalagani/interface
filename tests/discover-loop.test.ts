/**
 * THE DISCOVERY LOOP — driven by a scripted provider, no key and no browser.
 *
 * A real discovery run costs money and needs a live model, so the loop's own
 * logic is proven here instead: a fake provider returns a fixed sequence of tool
 * calls, and a stub surface answers them. That makes the loop's control flow —
 * pruning, stop conditions, error recovery — testable in milliseconds and in CI.
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
import { runDiscovery } from "../src/discover/loop.js";
import type { ConverseOptions, ConverseResponse, ModelProvider, Turn, Usage } from "../src/model/provider.js";
import type { TargetDescriptor } from "../src/capability/schema.js";
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

  async parseJson(): Promise<{ value: unknown; usage: Usage }> {
    return { value: {}, usage: USAGE };
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

const target = { ref: "f2e13", screen_id: "MEMBER_SEARCH", why_stable: "beside the MEMBER ID label" };
const deps = (provider: ModelProvider, surface: Surface) => ({ provider, surface, actor: () => "automation" as const, epoch: () => 0 });

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
    // Every recorded step carries a minted target, never the ref it came from.
    expect(result.trace[0]?.target?.strategies[0]?.key).toBe("MEMBER_ID");
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

  it("detects a dead end when the surface stops changing", async () => {
    // The model keeps acting with total confidence; the application does not move.
    const provider = new ScriptedProvider(
      Array.from({ length: 10 }, () => ({ name: "click", args: { ...target, ref: "f2e20" } })),
    );

    const result = await runDiscovery("click forever", deps(provider, new StubSurface()));

    expect(result.stopped).toBe("no_progress");
    expect(result.detail).toContain("did not change");
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
