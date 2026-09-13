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
 * Reach a shape the worked example's literal type does not admit — adding an
 * atom the union never held, or dropping a field the literal declares. The cast
 * is confined to these two helpers so no case has to spell one out.
 */
const loose = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const pushLoose = (arr: unknown, value: unknown): void => void (arr as unknown[]).push(value);

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

  // ---- refinement 2 now walks EVERY string in plan AND contract. These two are
  //      the cases the old one-field version could not see at all.
  { name: "an SSN-shaped literal in a robustness note rather than a value", expectMessage: /SSN-shaped literal must be a \{\{param\}\}/,
    mutate: (c) => { c.plan.targets[0]!.robustness = "Anchored beside the member's SSN 900-55-0101 on this screen."; } },
  { name: "an SSN-shaped literal in the contract, not the plan", expectMessage: /SSN-shaped literal must be a \{\{param\}\}/,
    mutate: (c) => { c.contract.outcomes[0]!.message = "No member matches SSN 900-55-0101."; } },

  { name: "an acting step with no postcondition", expectMessage: /acts but asserts no postcondition/,
    mutate: (c) => { c.plan.steps[1]!.post = { all: [], any: [] }; } },
  // Refinement 3's new half. Without it the refinement was a strict subset of the
  // Predicate type's own "a predicate must assert something" and could never be
  // the sole cause of a rejection.
  { name: "an acting step whose postcondition repeats its precondition", expectMessage: /asserts the same condition before and after acting/,
    mutate: (c) => { loose(c.plan.steps[1]!)["post"] = { all: [{ atom: "screen", is: "MEMBER_SEARCH" }], any: [] }; } },

  { name: "retry recovery alongside an irreversible step", expectMessage: /cannot coexist with an irreversible step/,
    mutate: (c) => {
      c.plan.steps[3]!.risk = "irreversible"; c.contract.risk = "irreversible";
      c.plan.recovery[0]!.do = "wait_and_retry"; c.plan.recovery[0]!.maxAttempts = 3; } },
  { name: "an output produced by a step that does not exist", expectMessage: /names step s99, which does not exist/,
    mutate: (c) => { c.contract.outputs[0]!.producedBy = "s99"; } },
  // The executor populates an output ONLY on its `read` branch, so an output
  // pointed at a click is one the engine can never produce.
  { name: "an output produced by a step that does not read", expectMessage: /whose action is "click"; only a read step can produce an output/,
    mutate: (c) => { c.contract.outputs[0]!.producedBy = "s02"; } },

  { name: "a snapshot ref persisted as a durable target", expectMessage: /refs are never durable targets/,
    mutate: (c) => { c.plan.targets[0]!.strategies[0]!.key = "f1e12"; } },
  { name: "a contract understating its own risk", expectMessage: /but the steps reach "reversible"/,
    mutate: (c) => { c.contract.risk = "read_only"; } },

  // ---- refinement 8 now covers predicate atoms, not just steps[].target.
  { name: "a step targeting an undeclared symbol", expectMessage: /symbol NOT_DECLARED is targeted but not declared/,
    mutate: (c) => { c.plan.steps[0]!.target = "NOT_DECLARED"; } },
  { name: "a predicate atom naming an undeclared symbol", expectMessage: /symbol GHOST_FIELD is targeted but not declared/,
    mutate: (c) => { pushLoose(c.plan.checkpoint.all, { atom: "element", target: "GHOST_FIELD", present: true }); } },

  // ---- refinement 9: a plan may not interpolate a parameter nobody declared.
  //      Before it, replay typed the literal text `{{note}}` into a live form.
  { name: "a plan that references an undeclared parameter", expectMessage: /references \{\{note\}\}, which is not a declared input/,
    mutate: (c) => { c.plan.steps[0]!.value = "{{note}}"; } },

  // ---- refinement 10: an acting verb with nothing to act on was silently
  //      skipped by the executor while stepsCompleted still counted it.
  { name: "an acting step that names no target", expectMessage: /performs "click" but names no target/,
    mutate: (c) => { delete loose(c.plan.steps[1]!)["target"]; } },

  // ---- refinement 11: every identity a lookup keys on must be unique.
  { name: "a duplicate target id", expectMessage: /target id MEMBER_ID is declared more than once/,
    mutate: (c) => { pushLoose(c.plan.targets, { ...c.plan.targets[0]! }); } },
  { name: "a duplicate step ref", expectMessage: /step ref s01 is used more than once/,
    mutate: (c) => { c.plan.steps[1]!.ref = "s01"; } },
  { name: "a duplicate input name", expectMessage: /input "member_id" is declared more than once/,
    mutate: (c) => { c.contract.inputs[1]!.name = "member_id"; } },
  { name: "two outputs claiming the same producing step", expectMessage: /named as the producer of more than one output/,
    mutate: (c) => { pushLoose(c.contract.outputs, { ...c.contract.outputs[0]!, name: "second_value" }); } },

  // ---- the vocabulary deletion: `press` carried a key the schema could not
  //      record, so the executor silently issued a CLICK for it instead.
  { name: "the removed press verb", expectMessage: /Invalid enum value.*received 'press'/,
    mutate: (c) => { loose(c.plan.steps[1]!)["action"] = "press"; } },

  // ---- refinement 12 and the provenance tightening.
  { name: "a verified artifact with no model-call count", expectMessage: /must record modelCalls: 0/,
    mutate: (c) => { delete loose(c.verification)["modelCalls"]; } },
  { name: "a provenance timestamp that is not an instant", expectMessage: /Invalid datetime/,
    mutate: (c) => { c.provenance.discoveredAt = "12 September 2026"; } },
  { name: "an artifact attributed to nobody", expectMessage: /at least 1 character/,
    mutate: (c) => { c.provenance.model = ""; } },
];

/**
 * Mutations that must still PARSE, for the same reason the table above pins
 * messages: a refinement that rejects too much is as broken as one that rejects
 * too little, and only silently so.
 *
 * This table grew with the refinements, and it is the half that matters most for
 * the two that were WIDENED. A PII scan that walks every string in the artifact
 * and a parameter rule that reads every `{{...}}` both have far more surface to
 * over-reject on than the single-field versions they replaced, and the corpus
 * they must not reject is full of nine-digit member ids, four-digit card
 * suffixes and app message codes.
 */
const acceptedCases: ReadonlyArray<{ name: string; mutate: (c: Doc) => void }> = [
  // MEASURED 2026-09-12: the pre-guard `\b\d{13,19}\b` flagged 24 strings across
  // the committed evidence, every one a Z.ai tool-call id of this exact shape —
  // `\b` matches at the boundary between the `-` and the first digit.
  { name: "a tool-call-id-shaped literal, which is not a card number",
    mutate: (c) => { c.plan.steps[0]!.value = "call_-7267060200698277786"; } },

  // The working data of a servicing screen, in the fields the widened walk now
  // reaches. Redacting or rejecting these is the failure mode §3.4 warns about:
  // safety that breaks the thing it protects.
  { name: "a member id and a card suffix in a robustness note",
    mutate: (c) => { c.plan.targets[0]!.robustness = "Row keyed by member 400200101, card ending 4021, branch 012."; } },
  { name: "an app message code in an outcome message",
    mutate: (c) => { c.contract.outcomes[0]!.message = "NO RECORDS MATCH SELECTION — MSG 0071"; } },

  // The measured exemption refinement 8 documents: `rowCount.grid` is ignored by
  // the evaluator, and four FROZEN committed artifacts cite a RESULTS_GRID that
  // no plan.targets declares. Enforcing it would reject graded evidence.
  { name: "a rowCount grid symbol that plan.targets does not declare",
    mutate: (c) => { loose(c.contract.outcomes[0]!.when.all[1]!)["grid"] = "NEVER_DECLARED_GRID"; } },

  // Refinement 9 must read predicates too, not only step values — and must be
  // satisfied by a parameter that IS declared, wherever it appears.
  { name: "a declared parameter referenced from a predicate rather than a step value",
    mutate: (c) => { pushLoose(c.plan.checkpoint.all, { atom: "text", contains: "{{action}}" }); } },

  // Refinement 10 binds ACTING verbs only. An assert acts on nothing.
  { name: "an assert step that names no target",
    mutate: (c) => {
      pushLoose(c.plan.steps, {
        ref: "s06", title: "Confirm the confirmation screen is showing", action: "assert",
        pre: { all: [{ atom: "screen", is: "CONFIRMATION" }], any: [] },
        post: { all: [{ atom: "text", contains: "CONFIRMATION" }], any: [] },
        risk: "read_only", approval: "none",
      });
    } },

  // Refinement 11 forbids two outputs sharing ONE producer, not two outputs.
  { name: "a second output produced by its own second read step",
    mutate: (c) => {
      pushLoose(c.plan.steps, {
        ref: "s06", title: "Read the resulting card status", action: "read", target: "CONFIRMATION_NUMBER",
        pre: { all: [{ atom: "screen", is: "CONFIRMATION" }], any: [] },
        post: { all: [{ atom: "element", target: "CONFIRMATION_NUMBER", present: true }], any: [] },
        risk: "read_only", approval: "none",
      });
      pushLoose(c.contract.outputs, {
        name: "card_status", type: "string", sensitivity: "confidential", producedBy: "s06",
        description: "The status the card ended in.",
      });
    } },

  // Refinement 12 binds only a SUCCESS claim. An honest "not yet verified"
  // artifact — which is what every committed fixture is — carries no count.
  { name: "an unverified artifact with no model-call count",
    mutate: (c) => {
      loose(c.verification)["replayResult"] = "not_yet_verified";
      delete loose(c.verification)["modelCalls"];
      delete loose(c.verification)["replayedAt"];
    } },
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
