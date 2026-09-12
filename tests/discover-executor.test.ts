/**
 * MINTING — the invariant the whole system rests on.
 *
 * A `ref` is valid only until the surface changes. The entire value of this
 * project depends on never recording one: an artifact whose targets are refs
 * replays today and breaks tomorrow, which is precisely the failure the spec
 * exists to avoid. So the rule is structural rather than aspirational —
 *
 *     THE MODEL CONTRIBUTES INTENT. MECHANICAL CODE CONTRIBUTES THE LOCATOR.
 *
 * — and these tests are what make it checkable. They pin three things:
 *
 *   1. a minted target NEVER contains a ref or a coordinate;
 *   2. a target that cannot be described durably is REFUSED, not approximated;
 *   3. a target is proven to resolve BEFORE it is recorded, so a trace cannot
 *      contain a step whose target was never once findable.
 *
 * The model's `why_stable` is also checked to be recorded as an attributed
 * belief. A reviewer opening an artifact has to be able to tell which parts were
 * measured and which parts a model merely claimed.
 */
import { describe, expect, it } from "vitest";
import { MintFailure, execute, mint, type ToolOutcome } from "../src/discover/executor.js";
import type { TargetDescriptor } from "../src/capability/schema.js";
import type {
  ActionContext,
  Observation,
  Resolution,
  Surface,
  SurfaceAction,
  TargetFacts,
} from "../src/surface/types.js";

const RESOLVES: Resolution = { strategyUsed: "table_anchor", strategyExpected: "table_anchor", matched: 1, degraded: false };

const facts = (over: Partial<TargetFacts> = {}): TargetFacts => ({
  tag: "input",
  role: "",
  fieldName: "MBRNO",
  anchorText: "MEMBER ID",
  framePath: ["content"],
  ...over,
});

const observation = (over: Partial<Observation> = {}): Observation => ({
  location: "http://localhost:7101/screen/search",
  screen: "MEMBER_SEARCH",
  nodes: [],
  text: "MBR0300",
  dialog: null,
  digest: "d0",
  ...over,
});

class Stub implements Surface {
  readonly acted: SurfaceAction[] = [];
  constructor(
    private readonly opts: {
      describe?: TargetFacts | null;
      find?: Resolution | null;
      obs?: Observation;
      readValue?: string | null;
    } = {},
  ) {}
  async observe(): Promise<Observation> {
    return this.opts.obs ?? observation();
  }
  async find(_t: TargetDescriptor): Promise<Resolution | null> {
    return this.opts.find === undefined ? RESOLVES : this.opts.find;
  }
  async describe(_ref: string): Promise<TargetFacts | null> {
    return this.opts.describe === undefined ? facts() : this.opts.describe;
  }
  async read(_t: TargetDescriptor): Promise<string | null> {
    return this.opts.readValue ?? "CNF4401";
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

const deps = (surface: Surface) => ({ surface, actor: () => "automation" as const, epoch: () => 0 });
const click = { ref: "f2e13", screen_id: "MEMBER_SEARCH", why_stable: "it is the only field beside the MEMBER ID label" };

describe("mint", () => {
  it("orders the anchor first and the field name second — the measured ordering", () => {
    const t = mint(facts(), "MEMBER_SEARCH", "because");
    expect(t.strategies.map((s) => s.kind)).toEqual(["table_anchor", "field_key"]);
    expect(t.strategies[0]?.key).toBe("MEMBER_ID");
    expect(t.strategies[1]?.key).toBe("MBRNO");
    expect(t.id).toBe("MEMBER_ID");
  });

  it("NEVER records a ref or a coordinate, whatever it was handed", () => {
    const t = mint(facts(), "MEMBER_SEARCH", "because");
    for (const s of t.strategies) {
      expect(s.kind).not.toBe("viewport_box");
      expect(s.key).not.toBe("f2e13");
      expect(s.key).not.toMatch(/^f?\d*e\d+$/);
    }
    expect(JSON.stringify(t)).not.toContain("f2e13");
  });

  it("falls back to the field name alone when there is no label", () => {
    const t = mint(facts({ anchorText: null }), "MEMBER_SEARCH", "because");
    expect(t.strategies.map((s) => s.kind)).toEqual(["field_key"]);
  });

  it("REFUSES to record when nothing durable exists, rather than approximating", () => {
    // The tempting fallback here is a coordinate or the ref itself. Both would
    // produce an artifact that passes today and fails silently later.
    expect(() => mint(facts({ anchorText: null, fieldName: null }), "MEMBER_SEARCH", "because")).toThrow(MintFailure);
  });

  it("records the model's reason as an attributed belief, not as fact", () => {
    const t = mint(facts(), "MEMBER_SEARCH", "the search button never moves");
    expect(t.robustness).toContain("Model's stated reason");
    expect(t.robustness).toContain("the search button never moves");
    // ...alongside what was actually measured from the element.
    expect(t.robustness).toContain("MEMBER ID");
    expect(t.robustness).toContain("MBRNO");
  });

  it("carries the frame it was found in", () => {
    expect(mint(facts(), "MEMBER_SEARCH", "x").framePath[0]?.name).toBe("content");
  });
});

describe("execute", () => {
  const acted = (o: ToolOutcome) => (o.kind === "acted" ? o.entry : null);

  it("mints, verifies and acts on the happy path", async () => {
    const s = new Stub();
    const out = await execute(1, "click", click, deps(s));
    expect(out.kind).toBe("acted");
    expect(acted(out)?.target?.strategies[0]?.key).toBe("MEMBER_ID");
    expect(s.acted).toHaveLength(1);
  });

  it("refuses to record a target that does not resolve — and does not act", async () => {
    const s = new Stub({ find: null });
    const out = await execute(1, "click", click, deps(s));
    expect(out.kind).toBe("error");
    // The crucial half: nothing was done to the target system.
    expect(s.acted).toHaveLength(0);
  });

  it("catches the model drifting from the surface before it corrupts the trace", async () => {
    const s = new Stub({ obs: observation({ screen: "MEMBER_RESULTS" }) });
    const out = await execute(1, "click", click, deps(s));
    expect(out.kind).toBe("error");
    if (out.kind !== "error") return;
    expect(out.message).toContain("MEMBER_SEARCH");
    expect(out.message).toContain("MEMBER_RESULTS");
    expect(s.acted).toHaveLength(0);
  });

  it("returns a stale ref as a correctable error rather than throwing", async () => {
    const s = new Stub({ describe: null });
    const out = await execute(1, "click", click, deps(s));
    expect(out.kind).toBe("error");
    if (out.kind !== "error") return;
    expect(out.message).toContain("observe again");
  });

  it("hands malformed arguments back as a message the model can act on", async () => {
    const s = new Stub();
    const out = await execute(1, "click", { ref: "f2e13" }, deps(s));
    expect(out.kind).toBe("error");
    if (out.kind !== "error") return;
    expect(out.message).toContain("screen_id");
    expect(s.acted).toHaveLength(0);
  });

  it("captures a read as a candidate output", async () => {
    const s = new Stub({ readValue: "CNF4407" });
    const out = await execute(2, "read", { ...click, as: "confirmation_number" }, deps(s));
    expect(acted(out)?.captured).toEqual({ as: "confirmation_number", value: "CNF4407" });
  });

  it("treats finish and stuck as terminal without touching the surface", async () => {
    const s = new Stub();
    const done = await execute(9, "finish", { summary: "found the member", checkpoint: "results grid shows one row" }, deps(s));
    expect(done.kind).toBe("terminal");
    const gave = await execute(9, "stuck", { reason: "no route to the card screen" }, deps(s));
    expect(gave.kind).toBe("terminal");
    expect(s.acted).toHaveLength(0);
  });
});
