/**
 * The predicate evaluator and the settle primitive — pure, no browser, no clock.
 *
 * This is where the three result classes are actually distinguished, so it is
 * the closest thing the repo has to a test of criterion 3. Two properties get
 * particular attention:
 *
 *   - an evaluation reports EXPECTED and OBSERVED, not a boolean, because
 *     §3.3-g requires a failure to be debuggable;
 *   - a budget expiring is a returned outcome, never a throw and never a hang.
 */
import { describe, expect, it } from "vitest";
import { evaluatePredicate, type EvalContext } from "../src/replay/predicate.js";
import { settle } from "../src/replay/settle.js";
import type { Observation, Resolution, Surface, SurfaceAction, ActionContext } from "../src/surface/types.js";
import type { TargetDescriptor } from "../src/capability/schema.js";

const obs = (over: Partial<Observation> = {}): Observation => ({
  location: "http://localhost:7101/screen/search",
  screen: "MEMBER_SEARCH",
  nodes: [],
  text: "MBR0300 MEMBER INQUIRY",
  dialog: null,
  digest: "d0",
  ...over,
});

/** Grid shape: one table plus N rows, of which the first is the header. */
const grid = (dataRows: number): Observation["nodes"] => [
  { role: "table", name: "", ref: "t1", framePath: [] },
  ...Array.from({ length: dataRows + 1 }, (_, i) => ({
    role: "row",
    name: `r${i}`,
    ref: `r${i}`,
    framePath: [] as readonly string[],
  })),
];

class Stub implements Surface {
  constructor(
    private readonly observations: Observation[],
    private readonly found: Resolution | null = null,
    private readonly value: string | null = null,
  ) {}
  private i = 0;
  async observe(): Promise<Observation> {
    const next = this.observations[Math.min(this.i, this.observations.length - 1)];
    this.i += 1;
    return next ?? obs();
  }
  async find(_t: TargetDescriptor): Promise<Resolution | null> {
    return this.found;
  }
  async describe(_ref: string): Promise<null> {
    return null;
  }
  async read(_t: TargetDescriptor): Promise<string | null> {
    return this.value;
  }
  async act(_a: SurfaceAction, _c: ActionContext): Promise<Resolution | null> {
    return null;
  }
  onDialog(): void {}
  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async close(): Promise<void> {}
}

const ctx = (surface: Surface, params: Record<string, string> = {}): EvalContext => ({
  surface,
  targets: new Map([["MEMBER_ID", { id: "MEMBER_ID" } as unknown as TargetDescriptor]]),
  params,
});

describe("predicate evaluation", () => {
  it("reports expected and observed, not merely a boolean", async () => {
    const r = await evaluatePredicate(
      { all: [{ atom: "screen", is: "CARD_SERVICES" }], any: [] },
      obs({ screen: "MEMBER_SEARCH" }),
      ctx(new Stub([obs()])),
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("screen CARD_SERVICES");
    expect(r.summary).toContain("saw screen MEMBER_SEARCH");
  });

  it("counts DATA rows, excluding the header — this is what carries not-found", async () => {
    const empty = await evaluatePredicate(
      { all: [{ atom: "rowCount", grid: "RESULTS", op: "eq", n: 0 }], any: [] },
      obs({ nodes: [] }),
      ctx(new Stub([obs()])),
    );
    expect(empty.ok).toBe(true);

    const one = await evaluatePredicate(
      { all: [{ atom: "rowCount", grid: "RESULTS", op: "eq", n: 1 }], any: [] },
      obs({ nodes: grid(1) }),
      ctx(new Stub([obs()])),
    );
    expect(one.ok).toBe(true);
  });

  it("substitutes {{param}} references before comparing", async () => {
    const r = await evaluatePredicate(
      { all: [{ atom: "text", contains: "{{member_id}}" }], any: [] },
      obs({ text: "MEMBER 400200101 ABERNATHY" }),
      ctx(new Stub([obs()]), { member_id: "400200101" }),
    );
    expect(r.ok).toBe(true);
  });

  it("reads a value through the surface for valueEquals", async () => {
    const r = await evaluatePredicate(
      { all: [{ atom: "valueEquals", target: "MEMBER_ID", value: "{{member_id}}" }], any: [] },
      obs(),
      ctx(new Stub([obs()], null, "400200101"), { member_id: "400200101" }),
    );
    expect(r.ok).toBe(true);
  });

  it("an undeclared symbol fails loudly rather than passing vacuously", async () => {
    const r = await evaluatePredicate(
      { all: [{ atom: "element", target: "NOT_DECLARED", present: true }], any: [] },
      obs(),
      ctx(new Stub([obs()])),
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("not declared");
  });

  it("all must every hold; any needs one; an empty any is satisfied", async () => {
    const s = new Stub([obs()]);
    const bothFail = await evaluatePredicate(
      { all: [{ atom: "screen", is: "MEMBER_SEARCH" }], any: [{ atom: "text", contains: "NOPE" }] },
      obs(),
      ctx(s),
    );
    expect(bothFail.ok).toBe(false);

    const anySatisfied = await evaluatePredicate(
      { all: [{ atom: "screen", is: "MEMBER_SEARCH" }], any: [{ atom: "text", contains: "NOPE" }, { atom: "text", contains: "MBR0300" }] },
      obs(),
      ctx(s),
    );
    expect(anySatisfied.ok).toBe(true);
  });
});

describe("settle", () => {
  /** A clock that only advances when the code under test sleeps. No real time passes. */
  const fakeClock = () => {
    let t = 0;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it("returns on the first poll when the condition already holds", async () => {
    const clock = fakeClock();
    const r = await settle(
      new Stub([obs()]),
      [{ id: "pre", predicate: { all: [{ atom: "screen", is: "MEMBER_SEARCH" }], any: [] } }],
      ctx(new Stub([obs()])),
      { budgetMs: 5000, ...clock },
    );
    expect(r.matched).toBe("pre");
    expect(r.polls).toBe(1);
    expect(r.elapsedMs).toBe(0);
  });

  it("waits for the application's own state, not a fixed delay", async () => {
    const clock = fakeClock();
    const surface = new Stub([obs(), obs(), obs({ screen: "MEMBER_RESULTS" })]);
    const r = await settle(
      surface,
      [{ id: "post", predicate: { all: [{ atom: "screen", is: "MEMBER_RESULTS" }], any: [] } }],
      ctx(surface),
      { budgetMs: 5000, intervalMs: 100, ...clock },
    );
    expect(r.matched).toBe("post");
    expect(r.polls).toBe(3);
  });

  it("races expectations and names which one held — success versus business outcome", async () => {
    const surface = new Stub([obs({ screen: "MEMBER_RESULTS", text: "NO RECORDS MATCH SELECTION — MSG 0071" })]);
    const r = await settle(
      surface,
      [
        { id: "success", predicate: { all: [{ atom: "rowCount", grid: "G", op: "gte", n: 1 }], any: [] } },
        { id: "not_found", predicate: { all: [{ atom: "text", contains: "MSG 0071" }], any: [] } },
      ],
      ctx(surface),
      { budgetMs: 5000, ...fakeClock() },
    );
    expect(r.matched).toBe("not_found");
  });

  it("an expired budget is a returned outcome carrying evidence — never a throw or a hang", async () => {
    const surface = new Stub([obs()]);
    const r = await settle(
      surface,
      [{ id: "post", predicate: { all: [{ atom: "screen", is: "CONFIRMATION" }], any: [] } }],
      ctx(surface),
      { budgetMs: 300, intervalMs: 100, ...fakeClock() },
    );
    expect(r.matched).toBeNull();
    expect(r.elapsedMs).toBeGreaterThanOrEqual(300);
    // The timeout still explains itself, which is what makes it debuggable.
    expect(r.evaluations["post"]?.summary).toContain("screen CONFIRMATION");
    expect(r.evaluations["post"]?.summary).toContain("saw screen MEMBER_SEARCH");
  });
});
