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

  it("says out loud that the row count is PAGE-WIDE and ignores the grid it names", async () => {
    // `atom.grid` is required by the schema and used by nothing: `dataRowCount`
    // counts every data row in the observation, which spans the whole frameset.
    // The evaluator cannot scope it, so the one thing it can do is refuse to let
    // a reader assume it did — otherwise a bare "1 row(s)" reads as a measurement
    // of RESULTS that was never taken.
    const scoped = await evaluatePredicate(
      { all: [{ atom: "rowCount", grid: "RESULTS", op: "gte", n: 1 }], any: [] },
      obs({ nodes: grid(2) }),
      ctx(new Stub([obs()])),
    );
    expect(scoped.ok).toBe(true);
    const atom = scoped.atoms[0];
    expect(atom?.expected).toBe("rows gte 1 in RESULTS");
    expect(atom?.observed).toContain("PAGE-WIDE");
    expect(atom?.observed).toContain("not scoped to RESULTS");
    // This context declares only MEMBER_ID, so the grid symbol is undeclared and
    // the observation has to say so too.
    expect(atom?.observed).toContain("which plan.targets does not declare");
  });

  it("a failing rowCount still reports the page-wide scope, so the number is not mistaken for the grid's", async () => {
    const missed = await evaluatePredicate(
      { all: [{ atom: "rowCount", grid: "RESULTS_GRID", op: "eq", n: 0 }], any: [] },
      obs({ nodes: grid(3) }),
      ctx(new Stub([obs()])),
    );
    expect(missed.ok).toBe(false);
    expect(missed.summary).toContain("rows eq 0 in RESULTS_GRID");
    expect(missed.summary).toContain("3 data row(s) counted PAGE-WIDE");
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

  it("THE TWIN: `absent` fails on an undeclared symbol too, rather than passing because nobody declared it", async () => {
    // The phantom-success hole this pins. `absent` used to return ok:TRUE for an
    // undeclared symbol while `element present:false` — the identical question,
    // eight lines away in the same switch — returned ok:false. So "the danger is
    // gone" was satisfied by the plan never having said what the danger was.
    const r = await evaluatePredicate(
      { all: [{ atom: "absent", target: "NOT_DECLARED" }], any: [] },
      obs(),
      ctx(new Stub([obs()])),
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("not declared");

    // And the two atoms are pinned to the SAME behaviour, so they cannot drift
    // apart again: both fail, and both say why in the same words.
    const sibling = await evaluatePredicate(
      { all: [{ atom: "element", target: "NOT_DECLARED", present: false }], any: [] },
      obs(),
      ctx(new Stub([obs()])),
    );
    expect(sibling.ok).toBe(r.ok);
    expect(sibling.atoms[0]?.observed).toBe(r.atoms[0]?.observed);
  });

  it("a declared symbol that really is gone still satisfies `absent`", async () => {
    // The complement, so the fix above is a correction and not a blanket refusal:
    // MEMBER_ID is declared, and this surface finds nothing.
    const r = await evaluatePredicate(
      { all: [{ atom: "absent", target: "MEMBER_ID" }], any: [] },
      obs(),
      ctx(new Stub([obs()], null)),
    );
    expect(r.ok).toBe(true);
  });

  it("refuses to compare when a {{param}} was never supplied, instead of matching the template text", async () => {
    // `substituteParams` used to leave `{{member_id}}` in place, so this predicate
    // asked whether the screen literally contained the characters "{{member_id}}".
    const r = await evaluatePredicate(
      { all: [{ atom: "text", contains: "{{member_id}}" }], any: [] },
      obs({ text: "MEMBER {{member_id}} ABERNATHY" }),
      ctx(new Stub([obs()]), {}),
    );
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("member_id");
    expect(r.summary).toContain("were not supplied");
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
