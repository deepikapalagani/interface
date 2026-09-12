/**
 * The M0 gate: a worked example parses green, and each safety refinement
 * rejects its own specific malformation.
 *
 * Every invalid case below is the VALID example with exactly one thing changed,
 * AND asserts the issue message that should be raised. That second half is the
 * point: a table that only checks `success === false` would pass just as well
 * against a refinement that rejected everything, which is the vacuity trap. By
 * pinning the message, a case that starts failing for an unrelated reason shows
 * up as a failure rather than a false green.
 *
 * `acceptedCases` is the mirror of that table: the malformations a refinement
 * must NOT fire on. A rejection is only as good as its false-positive rate, and
 * the card-shape refinement was measured raising 24 of them against tool-call
 * ids — something a rejection-only table cannot see.
 */
import { describe, expect, it } from "vitest";
import { safeParseCapability } from "../src/capability/schema.js";

/** A real flow: search a member, open the card screen, freeze a card, read the confirmation. */
const valid = () => ({
  schemaVersion: 1 as const,
  contract: {
    id: "msc.card.set_status",
    version: "1.0.0",
    goal: "Freeze a member's debit card and return the confirmation number.",
    purpose: "Card servicing without an API path on this screen.",
    inputs: [
      { name: "member_id", type: "string", pattern: "^\\d{9}$", required: true, sensitivity: "confidential", description: "Member account base number." },
      { name: "card_last4", type: "string", pattern: "^\\d{4}$", required: true, sensitivity: "confidential", description: "Last four of the card to act on." },
      { name: "action", type: "enum", enumValues: ["FREEZE", "UNFREEZE"], required: true, sensitivity: "public", description: "Reversible status change." },
    ],
    outputs: [
      { name: "confirmation_number", type: "string", sensitivity: "confidential", producedBy: "s05", description: "Audit confirmation for the change." },
    ],
    outcomes: [
      {
        code: "MEMBER_NOT_FOUND",
        message: "No member matches that id.",
        when: { all: [{ atom: "screen", is: "MEMBER_RESULTS" }, { atom: "rowCount", grid: "RESULTS_GRID", op: "eq", n: 0 }], any: [] },
        source: "app_profile",
        note: "A legitimate answer the caller must handle, not a failure.",
      },
    ],
    risk: "reversible",
    requiresSession: true,
  },
  plan: {
    app: "MERIDIAN MSC 4.2",
    targets: [
      {
        id: "MEMBER_ID", screen: "MEMBER_SEARCH", framePath: [{ name: "content", urlPattern: "/content$" }],
        strategies: [
          { kind: "table_anchor", key: "MEMBER ID", matchedAtRecord: 1 },
          { kind: "field_key", key: "MBRNO", matchedAtRecord: 1 },
        ],
        verify: { role: "textbox" }, nameMayContainPii: false,
        robustness: "Anchored on the visible label cell, which survived a frame rename and a field rename in testing.",
      },
      {
        id: "SEARCH_BUTTON", screen: "MEMBER_SEARCH", framePath: [{ name: "content" }],
        strategies: [{ kind: "field_key", key: "SUBMIT", matchedAtRecord: 1 }],
        verify: {}, nameMayContainPii: false,
        robustness: "Image submit with an empty alt, so it has no accessible name; the app's own control name is the stable handle.",
      },
      {
        id: "FREEZE_BUTTON", screen: "CARD_SERVICES", framePath: [{ name: "content" }],
        strategies: [{ kind: "table_anchor", key: "CARD STATUS", matchedAtRecord: 1 }],
        verify: {}, nameMayContainPii: false,
        robustness: "Anchored on the row label rather than column position, which survives an inserted column.",
      },
      {
        id: "CONFIRMATION_NUMBER", screen: "CONFIRMATION", framePath: [{ name: "content" }],
        strategies: [{ kind: "table_anchor", key: "CONFIRMATION", matchedAtRecord: 1 }],
        verify: {}, nameMayContainPii: false,
        robustness: "Read from the cell adjacent to its label, never by grid index.",
      },
    ],
    steps: [
      { ref: "s01", title: "Enter the member id", action: "fill", target: "MEMBER_ID", value: "{{member_id}}",
        pre: { all: [{ atom: "screen", is: "MEMBER_SEARCH" }], any: [] },
        post: { all: [{ atom: "valueEquals", target: "MEMBER_ID", value: "{{member_id}}" }], any: [] }, risk: "read_only" },
      { ref: "s02", title: "Submit the search", action: "click", target: "SEARCH_BUTTON",
        pre: { all: [{ atom: "screen", is: "MEMBER_SEARCH" }], any: [] },
        post: { all: [{ atom: "screen", is: "MEMBER_RESULTS" }], any: [] }, risk: "read_only" },
      { ref: "s03", title: "Open card services", action: "navigate", target: "FREEZE_BUTTON",
        pre: { all: [{ atom: "screen", is: "MEMBER_RESULTS" }, { atom: "rowCount", grid: "RESULTS_GRID", op: "eq", n: 1 }], any: [] },
        post: { all: [{ atom: "screen", is: "CARD_SERVICES" }], any: [] }, risk: "read_only" },
      { ref: "s04", title: "Apply the status change", action: "click", target: "FREEZE_BUTTON",
        pre: { all: [{ atom: "screen", is: "CARD_SERVICES" }], any: [] },
        post: { all: [{ atom: "screen", is: "CONFIRMATION" }], any: [] }, risk: "reversible", approval: "confirm_intent" },
      { ref: "s05", title: "Read the confirmation number", action: "read", target: "CONFIRMATION_NUMBER",
        pre: { all: [{ atom: "screen", is: "CONFIRMATION" }], any: [] },
        post: { all: [{ atom: "element", target: "CONFIRMATION_NUMBER", present: true }], any: [] }, risk: "read_only" },
    ],
    recovery: [
      { id: "dismiss-broadcast", when: { atom: "dialog", messageContains: "SYSTEM BROADCAST" }, do: "dismiss_dialog", maxAttempts: 1,
        note: "A known nightly interstitial; dismissing it changes no member state." },
    ],
    checkpoint: { all: [{ atom: "screen", is: "CONFIRMATION" }, { atom: "element", target: "CONFIRMATION_NUMBER", present: true }], any: [] },
  },
  provenance: {
    discoveredAt: "2026-09-12T10:00:00Z",
    model: "glm-4.7-flash",
    traceDigest: "a".repeat(64),
    appProfileVersion: "meridian-msc@4.2",
    modelAuthoredFields: ["contract.purpose", "plan.steps[].title", "plan.targets[].robustness"],
  },
  verification: { replayedAt: "2026-09-12T10:04:00Z", replayResult: "success", modelCalls: 0 },
});

type Doc = ReturnType<typeof valid>;

/**
 * Each case mutates exactly one thing and pins the message it must raise, so the
 * table proves the refinement fired — not merely that something rejected it.
 */
const invalidCases: ReadonlyArray<{ name: string; mutate: (c: Doc) => void; expectMessage: RegExp }> = [
  { name: "a secret input", expectMessage: /secrets never enter an artifact/,
    mutate: (c) => { c.contract.inputs[0]!.sensitivity = "secret"; } },
  { name: "a card-number literal instead of a param", expectMessage: /card-number-shaped literal must be a \{\{param\}\}/,
    mutate: (c) => { c.plan.steps[0]!.value = "4111111111111111"; } },
  // A PAN as actually seeded in mock/seed.ts. All four seeded PANs are Luhn-
  // INVALID by construction, so this case is what fails if anyone "tightens" the
  // shape with a Luhn gate — which, measured on this corpus, would pass every
  // genuine leak and keep the tool-call-id false positive instead.
  { name: "a seeded PAN literal, which is Luhn-invalid", expectMessage: /card-number-shaped literal must be a \{\{param\}\}/,
    mutate: (c) => { c.plan.steps[0]!.value = "4111111111114021"; } },
  { name: "an acting step with no postcondition", expectMessage: /acts but asserts no postcondition/,
    mutate: (c) => { c.plan.steps[1]!.post = { all: [], any: [] }; } },
  { name: "retry recovery alongside an irreversible step", expectMessage: /cannot coexist with an irreversible step/,
    mutate: (c) => {
      c.plan.steps[3]!.risk = "irreversible"; c.contract.risk = "irreversible";
      c.plan.recovery[0]!.do = "wait_and_retry"; c.plan.recovery[0]!.maxAttempts = 3; } },
  { name: "an output produced by a step that does not exist", expectMessage: /names step s99, which does not exist/,
    mutate: (c) => { c.contract.outputs[0]!.producedBy = "s99"; } },
  { name: "a snapshot ref persisted as a durable target", expectMessage: /refs are never durable targets/,
    mutate: (c) => { c.plan.targets[0]!.strategies[0]!.key = "f1e12"; } },
  { name: "a contract understating its own risk", expectMessage: /but the steps reach "reversible"/,
    mutate: (c) => { c.contract.risk = "read_only"; } },
  { name: "a step targeting an undeclared symbol", expectMessage: /targets undeclared symbol NOT_DECLARED/,
    mutate: (c) => { c.plan.steps[0]!.target = "NOT_DECLARED"; } },
];

/**
 * Mutations that must still PARSE, for the same reason the table above pins
 * messages: a refinement that rejects too much is as broken as one that rejects
 * too little, and only silently so.
 */
const acceptedCases: ReadonlyArray<{ name: string; mutate: (c: Doc) => void }> = [
  // MEASURED 2026-09-12: the pre-guard `\b\d{13,19}\b` flagged 24 strings across
  // the committed evidence, every one a Z.ai tool-call id of this exact shape —
  // `\b` matches at the boundary between the `-` and the first digit.
  { name: "a tool-call-id-shaped literal, which is not a card number",
    mutate: (c) => { c.plan.steps[0]!.value = "call_-7267060200698277786"; } },
];

describe("capability schema", () => {
  it("accepts the worked example with zero issues", () => {
    const r = safeParseCapability(valid());
    if (!r.success) console.error(r.error.issues);
    expect(r.success).toBe(true);
  });

  it.each(invalidCases)("rejects $name — for the right reason", ({ mutate, expectMessage }) => {
    const c = valid();
    mutate(c);
    const r = safeParseCapability(c);
    expect(r.success).toBe(false);
    if (r.success) return;
    const messages = r.error.issues.map((i) => i.message);
    expect(
      messages.some((m) => expectMessage.test(m)),
      `expected an issue matching ${expectMessage}, got: ${JSON.stringify(messages)}`,
    ).toBe(true);
  });

  it.each(acceptedCases)("accepts $name — the refinement must not overreach", ({ mutate }) => {
    const c = valid();
    mutate(c);
    const r = safeParseCapability(c);
    expect(
      r.success,
      r.success ? "" : `expected no issues, got: ${JSON.stringify(r.error.issues.map((i) => i.message))}`,
    ).toBe(true);
  });

  it("is not blanket-rejecting: every mutation is individually necessary", () => {
    // If the schema rejected regardless of the mutation, the unmutated example
    // would fail too. This is the control case for the whole table.
    expect(safeParseCapability(valid()).success).toBe(true);
  });

  // NOTE: there is deliberately no test asserting that a tenant literal like
  // "MBR0300" is refused as a symbol. It would pass, but for the wrong reason —
  // "MBR0300" satisfies the symbol pattern and is caught only by the undeclared-
  // symbol refinement, which case 8 already covers. Keeping symbols free of
  // tenant vocabulary is enforced by the binding layer and by review, not by a
  // regex, and a test implying otherwise would overstate the schema.
});
