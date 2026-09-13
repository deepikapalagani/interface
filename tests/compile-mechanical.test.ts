/**
 * THE COMPILER — what a recording is allowed to become.
 *
 * `tests/roundtrip.integration.test.ts` proves the happy path end to end through
 * a real browser. This file is the other half: the cases where compiling
 * FAITHFULLY is impossible, and the compiler must refuse rather than emit an
 * artifact that parses cleanly and is wrong. Every refusal below replaced a
 * silent behaviour that shipped:
 *
 *   - `risk: "read_only"` stamped on every step, including a click that commits;
 *   - an executed dialog dropped on the floor, with `plan.recovery` hardcoded [];
 *   - a minted symbol passed through when the binding could not name it, which
 *     parsed and threw `UnboundSymbol` at load;
 *   - two different controls collapsing onto one symbol, which replay resolves to
 *     whichever came last.
 *
 * The traces here are synthetic, which is the point: each one is the shape a real
 * run produces on the mock, stripped to the entry the compiler has to reason
 * about.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Binding, resolve } from "../src/capability/bind.js";
import { parseCapability, safeParseCapability, type TargetDescriptor } from "../src/capability/schema.js";
import { CompileRefused, compileMechanical, type CompileInput } from "../src/compile/mechanical.js";
import { RiskNotEstablished, RiskProfile } from "../src/compile/risk-profile.js";
import type { TraceEntry } from "../src/discover/executor.js";
import { classify } from "../src/replay/classify.js";
import type { Observation, Surface } from "../src/surface/types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const binding = Binding.parse(JSON.parse(readFileSync(path.join(here, "fixtures", "fcu@4.2.json"), "utf8")));

const riskProfile = RiskProfile.parse({
  app: "MERIDIAN MSC",
  profileVersion: "test-profile@1",
  screens: [
    { screen: "MEMBER_SEARCH", risk: "read_only", note: "a query form" },
    {
      screen: "CARD_SERVICES",
      risk: "reversible",
      note: "the one screen that commits",
      controls: [{ target: "OVERRIDE_CODE", risk: "irreversible", note: "supervisor authority unlocks LOST_STOLEN" }],
    },
    { screen: "CONFIRMATION", risk: "read_only", note: "the transaction has already committed" },
  ],
});

/** A target as MINTING records one: literal keys, a frame name, a derived symbol. */
const minted = (over: Partial<TargetDescriptor> = {}): TargetDescriptor => ({
  id: "MEMBER_ID",
  screen: "MEMBER_SEARCH",
  framePath: [{ name: "content" }],
  strategies: [
    { kind: "table_anchor", key: "MEMBER ID", matchedAtRecord: 1 },
    { kind: "field_key", key: "MBRNO", matchedAtRecord: 1 },
  ],
  verify: {},
  nameMayContainPii: false,
  robustness: "Anchors recorded from the live element.",
  ...over,
});

const entry = (over: Partial<TraceEntry> & Pick<TraceEntry, "index" | "tool">): TraceEntry => ({
  screenBefore: "MEMBER_SEARCH",
  screenAfter: "MEMBER_SEARCH",
  ...over,
});

const compile = (trace: readonly TraceEntry[], over: Partial<CompileInput> = {}): Record<string, unknown> =>
  compileMechanical({
    trace,
    goal: "Do the thing the run did.",
    capabilityId: "msc.member.lookup",
    version: "1.0.0",
    app: "MERIDIAN MSC",
    model: "scripted",
    appProfileVersion: "meridian-msc@4.2",
    discoveredAt: "2026-09-12T00:00:00Z",
    binding,
    riskProfile,
    ...over,
  });

/**
 * A `dialog` atom is evaluated against the observation alone, so classification
 * of a recovery rule touches no surface. Throwing rather than stubbing means a
 * future change that DID reach the surface fails here instead of passing on a
 * quietly fabricated answer.
 */
const unusedSurface: Surface = {
  observe: () => {
    throw new Error("classify is handed an observation; it must not perceive again");
  },
  find: () => {
    throw new Error("a dialog atom resolves no target");
  },
  describe: () => {
    throw new Error("unused by classification");
  },
  read: () => {
    throw new Error("unused by classification");
  },
  act: () => {
    throw new Error("classification never acts");
  },
  onDialog: () => {
    throw new Error("unused by classification");
  },
  screenshot: () => {
    throw new Error("unused by classification");
  },
  close: () => {
    throw new Error("unused by classification");
  },
};

/** Narrowing helpers, because the compiler deliberately returns a plain object. */
const plan = (c: Record<string, unknown>) => c["plan"] as { targets: TargetDescriptor[]; steps: Record<string, unknown>[]; recovery: Record<string, unknown>[]; checkpoint: unknown };
const contract = (c: Record<string, unknown>) => c["contract"] as Record<string, unknown>;

const lookupTrace: TraceEntry[] = [
  entry({ index: 1, tool: "type_text", target: minted(), value: "400200101" }),
  entry({
    index: 2,
    tool: "click",
    screenAfter: "MEMBER_RESULTS",
    target: minted({ id: "SUBMIT", strategies: [{ kind: "field_key", key: "SUBMIT", matchedAtRecord: 1 }] }),
  }),
];

describe("risk is established, never assumed", () => {
  it("rates each step from the profile and makes the contract equal the maximum", () => {
    const cardTrace: TraceEntry[] = [
      entry({ index: 1, tool: "type_text", screenBefore: "CARD_SERVICES", screenAfter: "CARD_SERVICES", value: "4021", target: minted({ id: "CARD_SELECT", screen: "CARD_SERVICES", strategies: [{ kind: "table_anchor", key: "CARD (LAST 4)", matchedAtRecord: 1 }] }) }),
      entry({ index: 2, tool: "click", screenBefore: "CARD_SERVICES", screenAfter: "CONFIRMATION", target: minted({ id: "CARD_APPLY", screen: "CARD_SERVICES", strategies: [{ kind: "field_key", key: "APPLY", matchedAtRecord: 1 }] }) }),
    ];

    const compiled = compile(cardTrace);
    const parsed = safeParseCapability(compiled);
    if (!parsed.success) console.error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));

    // The committing flow used to compile to read_only end to end, so a failed
    // replay answered `retry_safe` on a card that had already been actioned.
    expect(plan(compiled).steps.map((s) => s["risk"])).toEqual(["reversible", "reversible"]);
    expect(contract(compiled)["risk"]).toBe("reversible");
    expect(contract(compiled)["requiresSession"]).toBe(true);
    // Refinement 7 is EQUALITY, so the schema accepting this is the pin.
    expect(parsed.success).toBe(true);
  });

  it("a control entry RAISES a screen's rating, so supplying supervisor authority is irreversible", () => {
    const overrideTrace: TraceEntry[] = [
      entry({ index: 1, tool: "type_text", screenBefore: "CARD_SERVICES", screenAfter: "CARD_SERVICES", value: "SUP-1", target: minted({ id: "OVERRIDE_CODE", screen: "CARD_SERVICES", strategies: [{ kind: "table_anchor", key: "OVERRIDE CODE", matchedAtRecord: 1 }] }) }),
    ];

    const compiled = compile(overrideTrace);
    expect(plan(compiled).steps[0]?.["risk"]).toBe("irreversible");
    expect(contract(compiled)["risk"]).toBe("irreversible");
  });

  it("REFUSES an acting step on a screen the profile does not rate", () => {
    const unrated = [entry({ index: 1, tool: "click", screenBefore: "MEMBER_DETAIL", screenAfter: "CARD_SERVICES", target: minted({ id: "CARD_SERVICES_LINK", screen: "MEMBER_DETAIL", strategies: [{ kind: "table_anchor", key: "CARD SERVICES", matchedAtRecord: 1 }] }) })];

    expect(() => compile(unrated)).toThrow(RiskNotEstablished);
    try {
      compile(unrated);
    } catch (e) {
      // Actionable: it names the screen and what to do about it.
      expect((e as Error).message).toContain("MEMBER_DETAIL");
      expect((e as Error).message).toContain("re-compile");
    }
  });

  it("a read is read_only by the VERB, even on the screen that can commit", () => {
    // The replay engine's read path never reaches the gate, so a read cannot
    // commit whatever the screen is rated.
    const readTrace = [
      entry({
        index: 1,
        tool: "read",
        screenBefore: "CONFIRMATION",
        screenAfter: "CONFIRMATION",
        captured: { as: "confirmation number", value: "CNF4401" },
        target: minted({ id: "CONFIRMATION", screen: "CONFIRMATION", strategies: [{ kind: "table_anchor", key: "CONFIRMATION", matchedAtRecord: 1 }] }),
      }),
    ];

    const compiled = compile(readTrace);
    expect(plan(compiled).steps[0]?.["risk"]).toBe("read_only");
    // The model's free-text name is normalised to what the schema's output name
    // pattern accepts, rather than failing the whole compile over a space.
    expect((contract(compiled)["outputs"] as Record<string, unknown>[])[0]?.["name"]).toBe("confirmation_number");
    expect(safeParseCapability(compiled).success).toBe(true);
  });
});

describe("literals in, symbols out", () => {
  it("canonicalises a MULTI-WORD label, which the old symbolising mint could not", () => {
    const cardTrace = [
      entry({
        index: 1,
        tool: "type_text",
        screenBefore: "CARD_SERVICES",
        screenAfter: "CARD_SERVICES",
        value: "4021",
        target: minted({
          id: "CARD_LAST_4", // what mint derives from the literal; the compiler owns the real one
          screen: "CARD_SERVICES",
          strategies: [
            { kind: "table_anchor", key: "CARD (LAST 4)", matchedAtRecord: 1 },
            { kind: "field_key", key: "SEL", matchedAtRecord: 1 },
          ],
        }),
      }),
    ];

    const compiled = compile(cardTrace);
    const capability = parseCapability(compiled);

    expect(capability.plan.targets[0]?.id).toBe("CARD_SELECT");
    expect(capability.plan.steps[0]?.target).toBe("CARD_SELECT");

    // The proof that matters: it LOADS. A `CARD_LAST_4` id parsed cleanly and
    // threw UnboundSymbol here.
    const resolved = resolve(capability, binding);
    expect(resolved.targets[0]?.strategies[0]?.key).toBe("CARD (LAST 4)");
    expect(resolved.targets[0]?.strategies[1]?.key).toBe("SEL");
    expect(resolved.targets[0]?.screen).toBe("CRD0500");
    expect(resolved.targets[0]?.framePath[0]?.name).toBe("content");
  });

  it("REFUSES a literal the binding cannot name, instead of passing it through", () => {
    const unknown = [entry({ index: 1, tool: "click", target: minted({ strategies: [{ kind: "table_anchor", key: "MEMO LINE", matchedAtRecord: 1 }] }) })];

    expect(() => compile(unknown)).toThrow(CompileRefused);
    try {
      compile(unknown);
    } catch (e) {
      expect((e as Error).message).toContain("MEMO LINE");
      expect((e as Error).message).toContain("binding");
    }
  });

  it("records the frame by the ROLE it plays, so the artifact is not welded to one tenant", () => {
    const compiled = compile(lookupTrace);
    expect(plan(compiled).targets[0]?.framePath[0]?.name).toBe("content");
  });
});

describe("targets are keyed on the control, not on the id alone", () => {
  it("the same label on two screens is TWO targets, each pinned to its own screen", () => {
    const twoScreens = [
      entry({ index: 1, tool: "type_text", value: "400200101", target: minted() }),
      entry({
        index: 2,
        tool: "type_text",
        screenBefore: "CARD_SERVICES",
        screenAfter: "CARD_SERVICES",
        value: "4021",
        target: minted({ id: "CARD_SELECT", screen: "CARD_SERVICES", strategies: [{ kind: "table_anchor", key: "CARD (LAST 4)", matchedAtRecord: 1 }] }),
      }),
    ];

    const compiled = compile(twoScreens);
    expect(plan(compiled).targets).toHaveLength(2);
    expect(plan(compiled).targets.map((t) => t.screen)).toEqual(["MEMBER_SEARCH", "CARD_SERVICES"]);
  });

  it("REFUSES when two different controls canonicalise to one symbol", () => {
    // Reachable on this exact surface: the nav frame's quick-lookup box has field
    // MBRNO and no label (mints `MBRNO`), the content frame's member-id box has
    // the label MEMBER ID (mints `MEMBER_ID`), and the binding maps field MBRNO
    // to MEMBER_ID — so both land on one symbol. Replay's own `new Map(...)`
    // would keep the last silently, and every step would resolve into the nav frame.
    const collision = [
      entry({ index: 1, tool: "type_text", value: "400200101", target: minted() }),
      entry({
        index: 2,
        tool: "type_text",
        value: "400200101",
        target: minted({ id: "MBRNO", framePath: [{ name: "nav" }], strategies: [{ kind: "field_key", key: "MBRNO", matchedAtRecord: 1 }] }),
      }),
    ];

    expect(() => compile(collision)).toThrow(CompileRefused);
    try {
      compile(collision);
    } catch (e) {
      expect((e as Error).message).toContain("MEMBER_ID");
      expect((e as Error).message).toContain("nav");
    }
  });
});

describe("an executed dialog becomes a declared recovery rule", () => {
  const withDialog: TraceEntry[] = [
    entry({
      index: 1,
      tool: "dialog",
      screenBefore: "CARD_SERVICES",
      screenAfter: "CARD_SERVICES",
      dialog: { message: "SYSTEM BROADCAST: NIGHTLY MAINTENANCE 22:00", answer: "dismiss" },
      modelBelief: "an operations notice, not a prompt about my transaction",
    }),
    ...lookupTrace.map((e) => entry({ ...e, index: e.index + 1 })),
  ];

  it("compiles the dismissal into plan.recovery[] instead of dropping it", () => {
    const compiled = compile(withDialog);
    const rules = plan(compiled).recovery;

    expect(rules).toHaveLength(1);
    expect(rules[0]?.["do"]).toBe("dismiss_dialog");
    expect(rules[0]?.["when"]).toEqual({ atom: "dialog", messageContains: "SYSTEM BROADCAST: NIGHTLY MAINTENANCE 22:00" });
    expect(safeParseCapability(compiled).success).toBe(true);
  });

  it("the rule it emits is one the REPLAY ENGINE actually classifies as recoverable", async () => {
    // Shape is not enough: the point of compiling a dismissal is that replay's own
    // classifier recognises it, so the third result class survives the round trip
    // from a run that met an interstitial to a capability that handles one.
    const capability = parseCapability(compile(withDialog));
    const blocked: Observation = {
      location: "http://localhost:7101/screen/cards",
      screen: "CARD_SERVICES",
      nodes: [],
      text: "CRD0500 CARD SERVICES",
      dialog: { message: "SYSTEM BROADCAST: NIGHTLY MAINTENANCE 22:00" },
      digest: "d-dialog",
    };

    const classified = await classify(
      { observation: blocked, capability, expectation: capability.plan.steps[0]?.post ?? null, usedRecoveries: [] },
      { surface: unusedSurface, targets: new Map(), params: {} },
    );

    expect(classified.kind).toBe("recoverable");
    if (classified.kind !== "recoverable") return;
    expect(classified.action).toBe("dismiss_dialog");
    expect(classified.ruleId).toBe("dismiss-dialog-01");
  });

  it("the step count a reviewer reads agrees with the trace it was compiled from", () => {
    const compiled = compile(withDialog);
    // "Compiled from a discovery run of 2 executed step(s)" over a 3-entry trace
    // was the disagreement: the dismissal was executed and reported nowhere.
    expect(contract(compiled)["purpose"]).toContain("3 recorded tool call(s)");
    expect(contract(compiled)["purpose"]).toContain("2 ordered step(s)");
    expect(contract(compiled)["purpose"]).toContain("1 recovery rule(s)");
  });

  it("numbers the steps from the STEP sequence, so a dialog shifts nothing", () => {
    expect(plan(compile(withDialog)).steps.map((s) => s["ref"])).toEqual(["s01", "s02"]);
  });

  it("REFUSES to record a dialog message carrying a PII shape", () => {
    const leaky = [
      entry({
        index: 1,
        tool: "dialog",
        screenBefore: "CARD_SERVICES",
        screenAfter: "CARD_SERVICES",
        dialog: { message: "VERIFY MEMBER SSN 900-55-0101 BEFORE PROCEEDING", answer: "dismiss" },
      }),
      ...lookupTrace.map((e) => entry({ ...e, index: e.index + 1 })),
    ];

    expect(() => compile(leaky)).toThrow(CompileRefused);
    try {
      compile(leaky);
    } catch (e) {
      expect((e as Error).message).toContain("SSN-shaped");
      // Never echoes the value it refused.
      expect((e as Error).message).not.toContain("900-55-0101");
    }
  });
});

describe("what the compiler deliberately does not do", () => {
  it("asserts a checkpoint it OBSERVED, not the sentence the model wrote", () => {
    // `finish` collects the model's prose checkpoint and it stays in the trace and
    // the transcript as evidence. It is not compiled: a sentence is not a
    // predicate, and converting one would mean a model in the compile path.
    const compiled = compile(lookupTrace);
    expect(plan(compiled).checkpoint).toEqual({ all: [{ atom: "screen", is: "MEMBER_RESULTS" }], any: [] });
  });

  it("REFUSES rather than fabricating a checkpoint when the run ended nowhere nameable", () => {
    // The last defect of this class left in the file. `BoundSurface` reports
    // `screen: null` for a screen the binding cannot name — SYS0500, the abend
    // screen, is reachable as shipped — so a final click that lands there left
    // `lastScreen` null and the checkpoint fell back to the symbol `UNKNOWN`.
    // MEASURED before this refusal: safeParseCapability accepted that artifact
    // and resolve() then threw `UnboundSymbol ... screen symbol "UNKNOWN"`. It is
    // exactly the "parses cleanly, fails at load" failure minting was fixed for,
    // one layer down.
    const endedNowhere = [entry({ index: 1, tool: "click", screenAfter: null, target: minted({ id: "SUBMIT", strategies: [{ kind: "field_key", key: "SUBMIT", matchedAtRecord: 1 }] }) })];

    expect(() => compile(endedNowhere)).toThrow(CompileRefused);
    try {
      compile(endedNowhere);
    } catch (e) {
      expect((e as Error).message).toContain("nothing OBSERVED");
      // Never emits the fabricated symbol on any path.
      expect((e as Error).message).not.toContain("UNKNOWN");
    }
  });

  it("declares no inputs and no model-authored fields, because no pass writes either", () => {
    const compiled = compile(lookupTrace);
    expect(contract(compiled)["inputs"]).toEqual([]);
    expect((compiled["provenance"] as Record<string, unknown>)["modelAuthoredFields"]).toEqual([]);
    // And it says so honestly about replay, which nothing here has done.
    expect((compiled["verification"] as Record<string, unknown>)["replayResult"]).toBe("not_yet_verified");
  });
});
