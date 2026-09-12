/**
 * THE REUSE CLAIM, as a test.
 *
 * §3.7-c asks how an artifact is reused across tenants running the same vendor
 * product "rather than being rebuilt from scratch each time", and §3.7-e makes
 * the surface/tenant seam a MUST rather than design-only. The headline assertion
 * below is that one UNMODIFIED capability resolves against two different
 * tenants — different screen ids, different field names, different visible
 * labels, and a renamed content frame — with zero edits to the plan.
 *
 * The second assertion is the one that keeps the claim honest: a symbol the
 * binding cannot supply throws, naming the symbol. Variation a binding CAN
 * express is configuration; anything it cannot is drift, and drift surfaces
 * loudly instead of being silently absorbed (§3.7-d).
 */
import { describe, expect, it } from "vitest";
import {
  Binding,
  BindingChecked,
  UnboundSymbol,
  canonicalField,
  canonicalLabel,
  canonicalScreen,
  resolve,
  resolveTarget,
} from "../src/capability/bind.js";
import type { Capability, TargetDescriptor } from "../src/capability/schema.js";

/** Tenant A — FIRST COMMUNITY CU, MERIDIAN MSC 4.2. Mirrors mock/tenant.ts. */
const fcu = Binding.parse({
  tenant: "fcu",
  appVersion: "4.2",
  frames: { content: "content", nav: "nav" },
  screens: { MEMBER_SEARCH: "MBR0300", MEMBER_RESULTS: "MBR0310", MEMBER_DETAIL: "MBR0400" },
  fields: { MEMBER_ID: "MBRNO", LAST_NAME: "LNAME", SUBMIT: "SUBMIT" },
  labels: { MEMBER_ID: "MEMBER ID", LAST_NAME: "LAST NAME" },
});

/** Tenant B — HARBORLIGHT CU, 4.4. Everything a real deployment varies. */
const hcu = Binding.parse({
  tenant: "hcu",
  appVersion: "4.4",
  frames: { content: "main", nav: "sidebar" }, // the frame rename, measured in the spike
  screens: { MEMBER_SEARCH: "MS0300", MEMBER_RESULTS: "MS0310", MEMBER_DETAIL: "MS0400" },
  fields: { MEMBER_ID: "MEMBERNO", LAST_NAME: "SURNAME", SUBMIT: "GO" },
  labels: { MEMBER_ID: "MEMBER NO", LAST_NAME: "SURNAME" },
});

const memberIdTarget: TargetDescriptor = {
  id: "MEMBER_ID",
  screen: "MEMBER_SEARCH",
  framePath: [{ name: "content", urlPattern: "/content$" }],
  strategies: [
    { kind: "table_anchor", key: "MEMBER_ID", matchedAtRecord: 1 },
    { kind: "field_key", key: "MEMBER_ID", matchedAtRecord: 1 },
  ],
  verify: { role: "textbox" },
  nameMayContainPii: false,
  robustness: "Anchored on the visible label cell; survived a frame rename and a field rename.",
};

/** Minimal: resolve() reads targets, step predicates, the checkpoint and outcomes. */
const capability = (): Capability =>
  ({
    contract: {
      outcomes: [
        { code: "MEMBER_NOT_FOUND", when: { all: [{ atom: "screen", is: "MEMBER_RESULTS" }], any: [] } },
      ],
    },
    plan: {
      targets: [memberIdTarget],
      steps: [
        {
          ref: "s01",
          pre: { all: [{ atom: "screen", is: "MEMBER_SEARCH" }], any: [] },
          post: { all: [{ atom: "screen", is: "MEMBER_RESULTS" }], any: [] },
        },
      ],
      checkpoint: { all: [{ atom: "screen", is: "MEMBER_DETAIL" }], any: [] },
    },
  }) as unknown as Capability;

describe("binding", () => {
  it("THE REUSE CLAIM: one unmodified artifact resolves against both tenants", () => {
    const cap = capability();
    const a = resolve(cap, fcu);
    const b = resolve(cap, hcu);

    expect(a.targets[0]?.screen).toBe("MBR0300");
    expect(b.targets[0]?.screen).toBe("MS0300");
    // The capability object itself was never touched — no per-tenant plan edits.
    expect(cap.plan.targets[0]?.screen).toBe("MEMBER_SEARCH");
  });

  it("an anchor keys on the LABEL while a field keys on the FIELD NAME — two tables, one target", () => {
    const a = resolveTarget(memberIdTarget, fcu);
    expect(a.strategies[0]?.key).toBe("MEMBER ID"); // table_anchor -> visible label
    expect(a.strategies[1]?.key).toBe("MBRNO"); // field_key -> form field name

    const b = resolveTarget(memberIdTarget, hcu);
    expect(b.strategies[0]?.key).toBe("MEMBER NO");
    expect(b.strategies[1]?.key).toBe("MEMBERNO");
  });

  it("rewrites the frame path for a tenant that renamed its content frame", () => {
    expect(resolveTarget(memberIdTarget, fcu).framePath[0]?.name).toBe("content");
    expect(resolveTarget(memberIdTarget, hcu).framePath[0]?.name).toBe("main");
  });

  it("translates back: the surface sees a literal, predicates assert a symbol", () => {
    expect(canonicalScreen(fcu, "MBR0300")).toBe("MEMBER_SEARCH");
    expect(canonicalScreen(hcu, "MS0300")).toBe("MEMBER_SEARCH");
    // Same literal, different tenant — no accidental cross-tenant match.
    expect(canonicalScreen(hcu, "MBR0300")).toBeNull();
    expect(canonicalScreen(fcu, null)).toBeNull();
  });

  it("an unsuppliable symbol is DRIFT, and says which symbol", () => {
    const partial = Binding.parse({ ...hcu, labels: { LAST_NAME: "SURNAME" } }); // MEMBER_ID label missing
    expect(() => resolveTarget(memberIdTarget, partial)).toThrow(UnboundSymbol);
    try {
      resolveTarget(memberIdTarget, partial);
    } catch (e) {
      expect((e as UnboundSymbol).symbol).toBe("MEMBER_ID");
      expect((e as UnboundSymbol).kind).toBe("label");
      expect((e as Error).message).toContain("drift, not configuration");
    }
  });

  it("an unbound screen fails at LOAD time, not mid-flight on a screen check", () => {
    // The checkpoint asserts MEMBER_DETAIL; this binding omits it.
    const partial = Binding.parse({
      ...fcu,
      screens: { MEMBER_SEARCH: "MBR0300", MEMBER_RESULTS: "MBR0310" },
    });
    expect(() => resolve(capability(), partial)).toThrow(UnboundSymbol);
  });
});

/**
 * THE REVERSE DIRECTION — what minting needs.
 *
 * Resolving a plan goes symbol -> literal. Recording one goes the other way: a
 * surface reports `MBRNO` and the artifact must say `MEMBER_ID`, or the recording
 * is welded to a single institution. Measured: an artifact compiled from raw
 * literals was rejected by `resolve()` on its own tenant, asking for a field
 * symbol no binding defines.
 */
describe("canonicalising what a surface reports", () => {
  it("maps a field literal and a label literal back to their symbols", () => {
    expect(canonicalField(fcu, "MBRNO")).toBe("MEMBER_ID");
    expect(canonicalLabel(fcu, "MEMBER ID")).toBe("MEMBER_ID");
    // ...and the same literals mean different symbols nowhere else.
    expect(canonicalField(hcu, "MEMBERNO")).toBe("MEMBER_ID");
    expect(canonicalField(hcu, "MBRNO")).toBeNull();
  });

  it("round-trips every entry: symbol -> literal -> symbol is the identity", () => {
    for (const [symbol, literal] of Object.entries(fcu.fields)) {
      expect(canonicalField(fcu, literal), `field ${symbol}`).toBe(symbol);
    }
    for (const [symbol, literal] of Object.entries(fcu.labels)) {
      expect(canonicalLabel(fcu, literal), `label ${symbol}`).toBe(symbol);
    }
    for (const [symbol, literal] of Object.entries(hcu.fields)) {
      expect(canonicalField(hcu, literal), `field ${symbol}`).toBe(symbol);
    }
  });

  it("returns null for anything the binding does not know, rather than guessing", () => {
    expect(canonicalField(fcu, "NOT_A_FIELD")).toBeNull();
    expect(canonicalLabel(fcu, "")).toBeNull();
    expect(canonicalField(fcu, null)).toBeNull();
  });

  it("REFUSES a binding whose reverse direction would be ambiguous", () => {
    // Two symbols sharing one literal would make minting guess, and a guess in a
    // recorded artifact only surfaces on some other tenant months later. So the
    // collision is unrepresentable rather than handled.
    const ambiguous = {
      ...fcu,
      fields: { MEMBER_ID: "MBRNO", ACCOUNT_ID: "MBRNO", SUBMIT: "SUBMIT" },
    };
    const parsed = BindingChecked.safeParse(ambiguous);
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(parsed.error.issues[0]?.message).toContain("reversible");
    expect(parsed.error.issues[0]?.message).toContain("MBRNO");
  });

  it("accepts the real bindings, so the rule is a guard and not an obstacle", () => {
    expect(BindingChecked.safeParse(fcu).success).toBe(true);
    expect(BindingChecked.safeParse(hcu).success).toBe(true);
  });
});
