/**
 * THE DEAD-END DETECTOR, AND THE RUNS IT MUST NOT KILL.
 *
 * The no-progress stop exists to catch a model acting with confidence against an
 * application that is not responding. Its verdict is a STATEMENT — "the model is
 * acting, the application is not responding" — and the bug it had was that the
 * statement was false for two of the four tools feeding it.
 *
 * A `read` issues no surface action at all. A `fill` issues one, but the
 * observation digest is `digestOf(screenId|nodes.length|innerText)` and `innerText`
 * does not carry input VALUES, so a fill that lands is byte-identical to one that
 * does nothing — measured against a live mock: digest `7be0a02d` before two real
 * fills and `7be0a02d` after, while reading the field back returned the typed
 * value. So four consecutive reads, or four fills, ended the run.
 *
 * That is not a corner case. §3.2 requires typed outputs/extracted data, and a
 * capability that extracts five values from one servicing screen — the ordinary
 * shape of a back-office lookup — could not be discovered at all.
 *
 * THIS FILE HAS ITS OWN STUB DELIBERATELY. The shared fixture in
 * `discover-loop.test.ts` returns the same `describe()` facts for every ref, so
 * five reads there would mint five identical targets and the test could be
 * dismissed as a model looping on one control rather than extracting five values.
 * Varying that shared stub breaks five existing tests in that file, so the honest
 * move is a separate stub here rather than a fixture change there.
 *
 * Both directions are pinned: the runs that must survive, and — in the neighbouring
 * file at `discover-loop.test.ts` — the genuine dead end under repeated clicks that
 * must still stop.
 */
import { describe, expect, it } from "vitest";
import type { TargetDescriptor } from "../src/capability/schema.js";
import { RiskProfile } from "../src/compile/risk-profile.js";
import { runDiscovery } from "../src/discover/loop.js";
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
  screens: [{ screen: "MEMBER_DETAIL", risk: "read_only", note: "a servicing view" }],
});

/**
 * ONE screen, and it never changes — which is the whole point. A real member
 * detail screen does not move while a model reads four fields off it, and the
 * constant digest is exactly what the live surface produces in that situation.
 */
const DETAIL: Observation = {
  location: "http://localhost:7101/screen/detail?id=400200101",
  screen: "MEMBER_DETAIL",
  nodes: [
    { role: "textbox", name: "", ref: "r01", framePath: ["content"] },
    { role: "textbox", name: "", ref: "r02", framePath: ["content"] },
    { role: "textbox", name: "", ref: "r03", framePath: ["content"] },
    { role: "textbox", name: "", ref: "r04", framePath: ["content"] },
    { role: "textbox", name: "", ref: "r05", framePath: ["content"] },
    { role: "button", name: "SUBMIT", ref: "go", framePath: ["content"] },
  ],
  text: "MBR0400 MEMBER DETAIL",
  dialog: null,
  digest: "d-detail",
};

/** Distinct facts per ref, so five reads are five DIFFERENT values, not a loop. */
const FACTS: Readonly<Record<string, TargetFacts>> = {
  r01: { tag: "td", role: "", fieldName: null, anchorText: "MEMBER", framePath: ["content"] },
  r02: { tag: "td", role: "", fieldName: null, anchorText: "NAME", framePath: ["content"] },
  r03: { tag: "td", role: "", fieldName: null, anchorText: "BRANCH", framePath: ["content"] },
  r04: { tag: "td", role: "", fieldName: null, anchorText: "STATUS", framePath: ["content"] },
  r05: { tag: "td", role: "", fieldName: null, anchorText: "OPENED", framePath: ["content"] },
  go: { tag: "input", role: "", fieldName: "SUBMIT", anchorText: "SUBMIT", framePath: ["content"] },
};

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  private turn = 0;
  constructor(private readonly script: { name: string; args: Record<string, unknown> }[]) {}
  async converse(_history: readonly Turn[], _o: ConverseOptions): Promise<ConverseResponse> {
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

class DetailSurface implements Surface {
  readonly acted: SurfaceAction[] = [];
  readonly reads: string[] = [];
  async observe(): Promise<Observation> {
    return DETAIL;
  }
  async find(_t: TargetDescriptor): Promise<Resolution | null> {
    return RESOLVES;
  }
  async describe(ref: string): Promise<TargetFacts | null> {
    return FACTS[ref] ?? null;
  }
  async read(t: TargetDescriptor): Promise<string | null> {
    this.reads.push(t.id);
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

const run = async (script: { name: string; args: Record<string, unknown> }[]) => {
  const surface = new DetailSurface();
  const result = await runDiscovery("read the member's details", {
    provider: new ScriptedProvider(script),
    surface,
    actor: () => "automation" as const,
    epoch: () => 0,
    riskProfile,
  });
  return { surface, result };
};

const readCall = (ref: string, as: string) => ({
  name: "read",
  args: { ref, screen_id: "MEMBER_DETAIL", why_stable: `beside the ${FACTS[ref]?.anchorText} label`, as },
});

describe("a screen that does not move is not a dead end", () => {
  it("reads five values from one unchanged screen instead of aborting at four", async () => {
    const { surface, result } = await run([
      readCall("r01", "member_id"),
      readCall("r02", "member_name"),
      readCall("r03", "branch"),
      readCall("r04", "status"),
      readCall("r05", "opened"),
      // `finish` requires a checkpoint as well as a summary — the schema will not
      // let a run declare success without naming what on screen proves it.
      {
        name: "finish",
        args: { summary: "captured the member's details", checkpoint: "MBR0400 MEMBER DETAIL is on screen" },
      },
    ]);

    // Before the fix this stopped at `no_progress` on the fourth read, with a
    // detail claiming the model was acting — while `surface.act()` had been called
    // zero times, because a read issues nothing.
    expect(result.stopped).toBe("goal_reached");
    expect(surface.acted).toHaveLength(0);

    // The stop reason alone is not the point. §3.2 asks for extracted data, so
    // assert the values actually came out — a run that stopped for the right
    // reason having captured four of five would still be the bug.
    expect(surface.reads).toHaveLength(5);
    expect(result.trace).toHaveLength(5);
  });

  it("fills four fields of one form before submitting, without calling it a dead end", async () => {
    const fill = (ref: string, text: string) => ({
      name: "type_text",
      args: { ref, screen_id: "MEMBER_DETAIL", why_stable: `beside the ${FACTS[ref]?.anchorText} label`, text },
    });

    const { surface, result } = await run([
      fill("r01", "400200101"),
      fill("r02", "SMITH"),
      fill("r03", "004"),
      fill("r04", "ACTIVE"),
      { name: "click", args: { ref: "go", screen_id: "MEMBER_DETAIL", why_stable: "the SUBMIT button" } },
      { name: "finish", args: { summary: "submitted the form", checkpoint: "MBR0400 MEMBER DETAIL is on screen" } },
    ]);

    // Four fills DO issue real actions — so this half is not about whether an
    // action happened, but about the digest being structurally unable to see it.
    expect(result.stopped).toBe("goal_reached");
    expect(surface.acted.filter((a) => a.kind === "fill")).toHaveLength(4);
  });

  it("still stops when the screen will not move under repeated CLICKS", async () => {
    // The other direction, and the reason the fix is a tool-level gate rather than
    // switching the detector off: a click SHOULD move this screen, and when four in
    // a row do not, the verdict is true and the run must end.
    const { result } = await run(
      Array.from({ length: 10 }, () => ({
        name: "click",
        args: { ref: "go", screen_id: "MEMBER_DETAIL", why_stable: "the SUBMIT button" },
      })),
    );

    expect(result.stopped).toBe("no_progress");
  });
});
