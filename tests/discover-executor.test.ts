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
 * — and these tests are what make it checkable. They pin four things:
 *
 *   1. a minted target NEVER contains a ref or a coordinate;
 *   2. a target that cannot be described durably is REFUSED, not approximated;
 *   3. a target is proven usable BEFORE it is recorded — an acting target must
 *      resolve, a read target must yield a value;
 *   4. a strategy key is the LITERAL the DOM reported, because the binding is
 *      what turns a literal into a symbol and minting does not hold one.
 *
 * The fourth is the one that changed. This file used to assert
 * `strategies[0].key === "MEMBER_ID"` — a SYMBOL, minted by upper-casing the
 * label — and that assertion was pinning a defect: the compiler then looked that
 * symbol up against the binding's label LITERALS and missed, so any label whose
 * symbolised form differs from the binding's own symbol name (every multi-word
 * label on the card screen) compiled to an id no binding defines. It parsed and
 * threw `UnboundSymbol` at load. The expectation is now the corrected behaviour:
 * the literal is recorded, and `canonicalLabel` maps it.
 *
 * The model's `why_stable` is also checked to be recorded as an attributed
 * belief. A reviewer opening an artifact has to be able to tell which parts were
 * measured and which parts a model merely claimed.
 */
import { describe, expect, it } from "vitest";
import { Binding, canonicalLabel } from "../src/capability/bind.js";
import type { TargetDescriptor } from "../src/capability/schema.js";
import { RiskProfile } from "../src/compile/risk-profile.js";
import { MintFailure, execute, isStepEntry, mint, stepRefOf, type ToolOutcome } from "../src/discover/executor.js";
import type {
  ActionContext,
  Observation,
  Resolution,
  Surface,
  SurfaceAction,
  TargetFacts,
} from "../src/surface/types.js";
import { SurfaceRefused } from "../src/surface/types.js";

const RESOLVES: Resolution = { strategyUsed: "table_anchor", strategyExpected: "table_anchor", matched: 1, degraded: false };

/** Two screens: one that can change nothing, one that can. */
const riskProfile = RiskProfile.parse({
  app: "MERIDIAN MSC",
  profileVersion: "test-profile@1",
  screens: [
    { screen: "MEMBER_SEARCH", risk: "read_only", note: "a query form" },
    {
      screen: "CARD_SERVICES",
      risk: "reversible",
      note: "the one screen that commits",
      controls: [{ target: "OVERRIDE_CODE", risk: "irreversible", note: "supervisor authority unlocks the irreversible code" }],
    },
  ],
});

const binding = Binding.parse({
  tenant: "fcu",
  appVersion: "4.2",
  frames: { content: "content", nav: "nav" },
  screens: { MEMBER_SEARCH: "MBR0300", CARD_SERVICES: "CRD0500" },
  fields: { MEMBER_ID: "MBRNO", CARD_SELECT: "SEL", OVERRIDE_CODE: "OVRCD" },
  labels: { MEMBER_ID: "MEMBER ID", CARD_SELECT: "CARD (LAST 4)", OVERRIDE_CODE: "OVERRIDE CODE" },
});

const facts = (over: Partial<TargetFacts> = {}): TargetFacts => ({
  tag: "input",
  role: "",
  fieldName: "MBRNO",
  anchorText: "MEMBER ID",
  framePath: ["content"],
  ...over,
});

const ctx = (over: Partial<Parameters<typeof mint>[1]> = {}) => ({
  screen: "MEMBER_SEARCH",
  ref: "f2e13",
  belief: "because",
  screenText: "MBR0300 MEMBER INQUIRY",
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
  readonly contexts: ActionContext[] = [];
  constructor(
    private readonly opts: {
      describe?: TargetFacts | null;
      find?: Resolution | null;
      obs?: Observation;
      readValue?: string | null;
      refuse?: SurfaceRefused;
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
    return this.opts.readValue === undefined ? "CNF4401" : this.opts.readValue;
  }
  async act(a: SurfaceAction, c: ActionContext): Promise<Resolution | null> {
    if (this.opts.refuse) throw this.opts.refuse;
    this.acted.push(a);
    this.contexts.push(c);
    return RESOLVES;
  }
  onDialog(): void {}
  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async close(): Promise<void> {}
}

const deps = (surface: Surface) => ({ surface, actor: () => "automation" as const, epoch: () => 0, riskProfile });
const at = { index: 1, stepRef: "s01" };
const click = { ref: "f2e13", screen_id: "MEMBER_SEARCH", why_stable: "it is the only field beside the MEMBER ID label" };

describe("mint", () => {
  it("orders the anchor first and the field name second — the measured ordering", () => {
    const t = mint(facts(), ctx());
    expect(t.strategies.map((s) => s.kind)).toEqual(["table_anchor", "field_key"]);
    expect(t.id).toBe("MEMBER_ID");
  });

  it("records the LITERALS the DOM reported, which is what the binding can translate", () => {
    const t = mint(facts(), ctx());
    expect(t.strategies[0]?.key).toBe("MEMBER ID"); // the visible label, verbatim
    expect(t.strategies[1]?.key).toBe("MBRNO"); // the app's own field name
  });

  it("a multi-word label survives the round trip that the old symbolising mint broke", () => {
    // `toSymbol("CARD (LAST 4)")` is CARD_LAST_4, which the binding's label table
    // does not contain — so the compiled artifact carried a symbol no binding
    // defines, parsed cleanly, and threw UnboundSymbol at resolve(). Recording the
    // literal is what makes this lookup possible at all.
    const t = mint(facts({ anchorText: "CARD (LAST 4)", fieldName: "SEL" }), ctx({ screen: "CARD_SERVICES" }));

    expect(t.strategies[0]?.key).toBe("CARD (LAST 4)");
    expect(canonicalLabel(binding, t.strategies[0]?.key ?? "")).toBe("CARD_SELECT");
  });

  it("NEVER records a ref or a coordinate, whatever it was handed", () => {
    const t = mint(facts(), ctx());
    for (const s of t.strategies) {
      expect(s.kind).not.toBe("viewport_box");
      expect(s.key).not.toBe("f2e13");
      expect(s.key).not.toMatch(/^f?\d*e\d+$/);
    }
    expect(JSON.stringify(t)).not.toContain("f2e13");
  });

  it("falls back to the field name alone when there is no label", () => {
    const t = mint(facts({ anchorText: null }), ctx());
    expect(t.strategies.map((s) => s.kind)).toEqual(["field_key"]);
    expect(t.strategies[0]?.key).toBe("MBRNO");
    expect(t.id).toBe("MBRNO");
  });

  it("REFUSES to record when nothing durable exists, and NAMES THE REF it refused", () => {
    // The tempting fallback here is a coordinate or the ref itself. Both would
    // produce an artifact that passes today and fails silently later. The ref
    // matters because this message goes back to the model verbatim: it used to
    // read "cannot record a durable target for ref : ..." and name no control.
    try {
      mint(facts({ anchorText: null, fieldName: null }), ctx({ ref: "f9e42" }));
      expect.unreachable("should have refused");
    } catch (e) {
      expect(e).toBeInstanceOf(MintFailure);
      expect((e as MintFailure).ref).toBe("f9e42");
      expect((e as Error).message).toContain("f9e42");
    }
  });

  it("records the role the element DECLARES, never one inferred from its tag", () => {
    // `<input type="image">` is a submit. The tag map this replaced answered
    // `textbox` for every input, so the verify gate — which re-derives from the
    // same tag — could not reject any input at all.
    expect(mint(facts({ tag: "input", role: "" }), ctx()).verify).toEqual({});
    expect(mint(facts({ tag: "input", role: "button" }), ctx()).verify).toEqual({ role: "button" });
  });

  it("flags a target recorded on a screen whose TEXT carries a PII shape", () => {
    // A screen-level observation, which is all the evidence supports: replay uses
    // it to decide which regions to black out of an escalation screenshot.
    expect(mint(facts(), ctx({ screenText: "MBR0300 MEMBER INQUIRY" })).nameMayContainPii).toBe(false);
    expect(mint(facts(), ctx({ screenText: "MEMBER 400200101\nSSN 900-55-0101" })).nameMayContainPii).toBe(true);
    expect(mint(facts(), ctx({ screenText: "CARD 4111111111114021 DEBIT" })).nameMayContainPii).toBe(true);
  });

  it("records the model's reason as an attributed belief, not as fact", () => {
    const t = mint(facts(), ctx({ belief: "the search button never moves" }));
    expect(t.robustness).toContain("Model's stated reason");
    expect(t.robustness).toContain("the search button never moves");
    // ...alongside what was actually measured from the element.
    expect(t.robustness).toContain("MEMBER ID");
    expect(t.robustness).toContain("MBRNO");
  });

  it("carries the frame it was found in", () => {
    expect(mint(facts(), ctx()).framePath[0]?.name).toBe("content");
  });
});

describe("execute", () => {
  const acted = (o: ToolOutcome) => (o.kind === "acted" ? o.entry : null);

  it("mints, verifies and acts on the happy path", async () => {
    const s = new Stub();
    const out = await execute(at, "click", click, deps(s));
    expect(out.kind).toBe("acted");
    expect(acted(out)?.target?.strategies[0]?.key).toBe("MEMBER ID");
    expect(s.acted).toHaveLength(1);
  });

  it("ESTABLISHES the risk it acts at from the profile, rather than assuming read_only", async () => {
    const s = new Stub();
    await execute(at, "click", click, deps(s));
    expect(s.contexts[0]?.risk).toBe("read_only");
    expect(s.contexts[0]?.stepRef).toBe("s01");

    // The same code on the screen that can change something, with the control
    // that unlocks the irreversible action.
    const card = new Stub({
      obs: observation({ screen: "CARD_SERVICES", text: "CRD0500 CARD SERVICES" }),
      describe: { tag: "input", role: "", fieldName: "OVRCD", anchorText: "OVERRIDE CODE", framePath: ["content"] },
    });
    await execute(at, "type_text", { ...click, screen_id: "CARD_SERVICES", text: "SUP-1" }, deps(card));
    expect(card.contexts[0]?.risk).toBe("irreversible");
  });

  it("REFUSES to act on a screen the risk profile does not rate", async () => {
    const s = new Stub({ obs: observation({ screen: "MEMBER_DETAIL" }) });
    const out = await execute(at, "click", { ...click, screen_id: "MEMBER_DETAIL" }, deps(s));
    expect(out.kind).toBe("error");
    if (out.kind !== "error") return;
    expect(out.message).toContain("risk profile");
    expect(s.acted).toHaveLength(0);
  });

  it("REFUSES to mint on a screen the binding cannot name, instead of inventing a symbol", async () => {
    // Reachable on the shipped app via SYS0500. Minting here used to record the
    // literal symbol UNKNOWN_SCREEN: the artifact parsed and threw UnboundSymbol
    // the moment anyone loaded it.
    const s = new Stub({ obs: observation({ screen: null }) });
    const out = await execute(at, "click", click, deps(s));
    expect(out.kind).toBe("error");
    if (out.kind !== "error") return;
    expect(out.message).toContain("does not name");
    expect(JSON.stringify(out)).not.toContain("UNKNOWN_SCREEN");
    expect(s.acted).toHaveLength(0);
  });

  it("refuses to record a target that does not resolve — and does not act", async () => {
    const s = new Stub({ find: null });
    const out = await execute(at, "click", click, deps(s));
    expect(out.kind).toBe("error");
    // The crucial half: nothing was done to the target system.
    expect(s.acted).toHaveLength(0);
  });

  it("catches the model drifting from the surface before it corrupts the trace", async () => {
    const s = new Stub({ obs: observation({ screen: "MEMBER_RESULTS" }) });
    const out = await execute(at, "click", click, deps(s));
    expect(out.kind).toBe("error");
    if (out.kind !== "error") return;
    expect(out.message).toContain("MEMBER_SEARCH");
    expect(out.message).toContain("MEMBER_RESULTS");
    expect(s.acted).toHaveLength(0);
  });

  it("returns a stale ref as a correctable error rather than throwing", async () => {
    const s = new Stub({ describe: null });
    const out = await execute(at, "click", click, deps(s));
    expect(out.kind).toBe("error");
    if (out.kind !== "error") return;
    expect(out.message).toContain("observe again");
  });

  it("hands malformed arguments back as a message the model can act on", async () => {
    const s = new Stub();
    const out = await execute(at, "click", { ref: "f2e13" }, deps(s));
    expect(out.kind).toBe("error");
    if (out.kind !== "error") return;
    expect(out.message).toContain("screen_id");
    expect(s.acted).toHaveLength(0);
  });

  it("captures a read through surface.read(), so STATIC TEXT is recordable", async () => {
    // `locate()` matches only input/select/textarea/a/button, so verifying a read
    // target with find() refused every value that is not a control — which is
    // every confirmation number on this surface. The value coming back IS the
    // proof the target resolves.
    const s = new Stub({ find: null, readValue: "CNF4407" });
    const out = await execute({ index: 2, stepRef: "s02" }, "read", { ...click, as: "confirmation_number" }, deps(s));
    expect(acted(out)?.captured).toEqual({ as: "confirmation_number", value: "CNF4407" });
  });

  it("reports an unreadable read as a correctable error", async () => {
    const s = new Stub({ find: null, readValue: null });
    const out = await execute(at, "read", { ...click, as: "confirmation_number" }, deps(s));
    expect(out.kind).toBe("error");
  });

  it("records what a DIALOG said and how it was answered, not just the model's belief", async () => {
    // The compiler turns this entry into a plan.recovery[] rule whose trigger is
    // that text. Recording only the model's stated reason left it nothing to
    // compile, and an executed dismissal vanished from the artifact.
    const s = new Stub({ obs: observation({ dialog: { message: "SYSTEM BROADCAST: NIGHTLY MAINTENANCE 22:00" } }) });
    const out = await execute(at, "dialog", { action: "dismiss", reason: "an operations notice" }, deps(s));

    expect(acted(out)?.dialog).toEqual({ message: "SYSTEM BROADCAST: NIGHTLY MAINTENANCE 22:00", answer: "dismiss" });
    expect(s.acted[0]?.kind).toBe("dismiss_dialog");
    // Dismissing cancels, so it commits nothing whatever the screen is rated.
    expect(s.contexts[0]?.risk).toBe("read_only");
    // It is not an ordered step, so it cites no step ref.
    expect(s.contexts[0]?.stepRef).toBeNull();
  });

  it("a policy refusal on the DIALOG tool is recoverable, exactly like one on click", async () => {
    // It used to act outside the guarded region, so a refused accept_dialog threw
    // out of runDiscovery and ended the one run the brief requires to be genuine.
    // Reachable as shipped: no policy permits accept_dialog.
    const refuse = new SurfaceRefused("policy_denied", 'action "accept_dialog" is not permitted');
    const s = new Stub({ obs: observation({ dialog: { message: "CONFIRM CARD STATUS CHANGE" } }), refuse });

    const out = await execute(at, "dialog", { action: "accept", reason: "the app asked" }, deps(s));

    expect(out.kind).toBe("error");
    if (out.kind !== "error") return;
    expect(out.message).toContain("refused");
    expect(out.message).toContain("accept_dialog");
  });

  it("refuses to ACCEPT a dialog on a screen whose risk nothing established", async () => {
    const s = new Stub({ obs: observation({ screen: "MEMBER_DETAIL", dialog: { message: "PROCEED?" } }) });
    const out = await execute(at, "dialog", { action: "accept", reason: "the app asked" }, deps(s));
    expect(out.kind).toBe("error");
    if (out.kind !== "error") return;
    expect(out.message).toContain("risk");
    expect(s.acted).toHaveLength(0);
  });

  it("treats finish and stuck as terminal without touching the surface", async () => {
    const s = new Stub();
    const done = await execute({ index: 9, stepRef: "s09" }, "finish", { summary: "found the member", checkpoint: "results grid shows one row" }, deps(s));
    expect(done.kind).toBe("terminal");
    const gave = await execute({ index: 9, stepRef: "s09" }, "stuck", { reason: "no route to the card screen" }, deps(s));
    expect(gave.kind).toBe("terminal");
    expect(s.acted).toHaveLength(0);
  });
});

/**
 * ONE numbering rule, two readers. The loop cites a step ref in the evidence and
 * the compiler emits one into the artifact; they used to count different things,
 * so after any dialog every citation named a step the artifact did not have.
 */
describe("step numbering", () => {
  it("a dialog entry is not an ordered step, so it does not consume a step number", async () => {
    const dialogStub = new Stub({ obs: observation({ dialog: { message: "SYSTEM BROADCAST" } }) });
    const dialog = await execute(at, "dialog", { action: "dismiss", reason: "notice" }, deps(dialogStub));
    const acted = await execute({ index: 2, stepRef: "s01" }, "click", click, deps(new Stub()));

    expect(dialog.kind === "acted" && isStepEntry(dialog.entry)).toBe(false);
    expect(acted.kind === "acted" && isStepEntry(acted.entry)).toBe(true);
    expect(stepRefOf(1)).toBe("s01");
    expect(stepRefOf(12)).toBe("s12");
  });
});
