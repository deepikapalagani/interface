/**
 * REDACTION — the policy, and the fact that it is switched ON.
 *
 * Two different things are tested here, and the second is the one that would
 * have caught the defect this file was written for. `redact` existed as a hook
 * with an identity default that no call site overrode, so every unit test of a
 * redaction FUNCTION would have passed while the system redacted nothing. The
 * wiring tests below call the production entry points with no options at all and
 * fail if the default is ever reverted.
 *
 * The ground truth is imported from the mock's own seed rather than copied, for
 * the reason `verify-evidence` sources it that way: a copied literal goes stale
 * on a reseed and the test keeps passing against data that no longer exists.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { freshState } from "../mock/seed.js";
import { DiscoveryEvidenceWriter } from "../src/evidence/discovery-log.js";
import { EvidenceWriter } from "../src/evidence/log.js";
import { CREDENTIAL_MASK, redactDeep, redactText, redactTypedValue } from "../src/safety/redact.js";
import { observationToText } from "../src/surface/serialize.js";
import type { Observation } from "../src/surface/types.js";

const seed = freshState();
const rose = seed.members["400200101"];
if (!rose) throw new Error("the seed no longer holds member 400200101 — this test's ground truth is stale");

const [firstCard, secondCard] = rose.cards;
if (!firstCard || !secondCard) throw new Error("the seed no longer gives member 400200101 two cards — see the last-four argument below");

const ssnLast4 = rose.ssn.slice(-4);

/**
 * The detector's shapes, mirrored from `scripts/verify-evidence.ts`. Redacted
 * output has to survive the graded scan, so the masks are checked against the
 * same patterns that would fail the deliverable.
 */
const LEAK_SHAPES = [
  { what: "a card-number-shaped literal", re: /(?<![\w-])\d{13,19}(?![\w-])/ },
  { what: "an SSN-shaped literal", re: /\b\d{3}-\d{2}-\d{4}\b/ },
];

/** MBR0400 as the surface actually renders it — the only screen carrying an SSN. */
const memberDetail = (): Observation => ({
  location: "http://localhost:7101/screen/detail?id=400200101",
  screen: "MEMBER_DETAIL",
  nodes: [
    { role: "link", name: `OPEN ${rose.id}`, ref: "f1e14", framePath: ["content"] },
    { role: "textbox", name: "", ref: "f1e21", framePath: ["content"], anchorText: "SSN", fieldName: "SSNFLD" },
  ],
  text: [
    "MBR0400  FIRST COMMUNITY CU  MERIDIAN MSC 4.2",
    "MEMBER DETAIL",
    `MEMBER ${rose.id}   ${rose.name}`,
    `SSN ${rose.ssn}`,
    `BRANCH ${rose.branch}`,
    `CARD ${firstCard.pan} ${firstCard.product}`,
    "S0 SHARE SAVINGS 1,204.55",
  ].join("\n"),
  dialog: null,
  digest: "sha-detail",
});

describe("redaction policy", () => {
  it("masks a full SSN and keeps the last four a servicing screen would show", () => {
    const out = redactText(`SSN ${rose.ssn}`);

    expect(out).not.toContain(rose.ssn);
    expect(out).toBe(`SSN ***-**-${ssnLast4}`);
  });

  it("masks a full PAN but keeps the last four, which is the only thing telling two cards apart", () => {
    const first = redactText(firstCard.pan);
    const second = redactText(secondCard.pan);

    expect(first).not.toContain(firstCard.pan);
    expect(second).not.toContain(secondCard.pan);
    expect(first).toContain(firstCard.last4);
    expect(second).toContain(secondCard.last4);

    // The load-bearing half: member 400200101 holds two cards differing only in
    // their last four, and `msc.card.set_status` has to know which one it froze.
    // Masking a PAN whole would make the capability unable to say.
    expect(first).not.toBe(second);
  });

  it("does NOT redact the member id, because the agent has to type it", () => {
    // The failure this policy exists to avoid: a 9-digit member id and a 9-digit
    // SSN are indistinguishable by shape, so a bare digit rule would break
    // discovery on the capability's own declared input parameter.
    const line = `MEMBER ${rose.id}   ${rose.name}   BRANCH ${rose.branch}`;

    expect(redactText(line)).toBe(line);
  });

  it("leaves the working data of a servicing screen alone", () => {
    for (const kept of ["1,204.55", "CNF4401", "MBR0400", "S0 SHARE SAVINGS", firstCard.last4]) {
      expect(redactText(kept)).toBe(kept);
    }
  });

  it("leaves a provider tool-call id intact, because mangling one corrupts the evidence", () => {
    // Measured in verify-evidence: the unguarded `\b\d{13,19}\b` form matches 24
    // of these in the committed evidence. A redactor using it would rewrite the
    // ids that pair each assistant turn with its result.
    const callId = "call_-7267060200698277786";

    expect(redactText(callId)).toBe(callId);
  });

  it("masks a credential by the field it belongs to, since a passcode has no shape", () => {
    expect(redactTypedValue("PASSCODE", "hunter2")).toBe(CREDENTIAL_MASK);
    expect(redactTypedValue("PASSWD", "hunter2")).toBe(CREDENTIAL_MASK);
    expect(redactTypedValue("MEMBER_ID", rose.id)).toBe(rose.id);
    expect(redactTypedValue(null, rose.id)).toBe(rose.id);
  });

  it("masks a credential-named key anywhere in a nested payload", () => {
    const out = redactDeep({
      request: { authorization: "Bearer abcdefghijklmnopqrstuvwxyz", model: "glm-4.7-flash" },
      api_key: "sk-0123456789abcdefghij",
    });

    expect(JSON.stringify(out)).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(JSON.stringify(out)).not.toContain("sk-0123456789abcdefghij");
    expect(JSON.stringify(out)).toContain("glm-4.7-flash");
  });

  it("returns a new structure rather than mutating, because the compiler reads the same array", () => {
    const entry = { value: rose.ssn, nested: { pan: firstCard.pan } };
    redactDeep(entry);

    expect(entry.value).toBe(rose.ssn);
    expect(entry.nested.pan).toBe(firstCard.pan);
  });

  it("produces output the graded leak detector accepts", () => {
    const masked = redactText(`SSN ${rose.ssn} CARD ${firstCard.pan}`);

    for (const shape of LEAK_SHAPES) expect(masked).not.toMatch(shape.re);
  });
});

/**
 * THE WIRING. Each of these calls a production entry point with NO options, so
 * reverting a default back to identity fails them.
 */
describe("redaction is on by default", () => {
  it("the model-facing rendering masks the screen's SSN and PAN with no options passed", () => {
    const obs = memberDetail();

    // Non-vacuous: the screen genuinely carries the literal, proven through the
    // same function with the override supplied.
    expect(observationToText(obs, { redact: (t) => t })).toContain(rose.ssn);

    const rendered = observationToText(obs);
    expect(rendered).not.toContain(rose.ssn);
    expect(rendered).not.toContain(firstCard.pan);
    expect(rendered).toContain(`***-**-${ssnLast4}`);

    // And the model can still do its job on the same screen.
    expect(rendered).toContain(rose.id);
    expect(rendered).toContain(rose.name);
    expect(rendered).toContain(firstCard.last4);
  });

  it("the discovery evidence files are redacted where they are written", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "redact-test-"));
    try {
      const writer = new DiscoveryEvidenceWriter(new EvidenceWriter(root, "run-01"));

      writer.transcript([
        { role: "tool", callId: "call_-7267060200698277786", content: `SSN ${rose.ssn}` },
        {
          role: "assistant",
          // The path the serialiser cannot cover: the model quoting the screen back.
          content: `The member's SSN is ${rose.ssn} and the card is ${firstCard.pan}.`,
          toolCalls: [],
          raw: { choices: [{ message: { content: `SSN ${rose.ssn}` } }] },
        },
      ]);
      writer.trace([
        { index: 1, tool: "type_text", value: rose.id, target: { id: "MEMBER_ID" } },
        { index: 2, tool: "type_text", value: "hunter2", target: { id: "PASSCODE" } },
      ]);

      const transcript = readFileSync(path.join(root, "run-01", "transcript.jsonl"), "utf8");
      const trace = readFileSync(path.join(root, "run-01", "trace.jsonl"), "utf8");

      expect(transcript).not.toContain(rose.ssn);
      expect(transcript).not.toContain(firstCard.pan);
      // Nested inside the provider payload, not merely at the top level.
      expect(transcript.match(/\*\*\*-\*\*-/g)).toHaveLength(3);
      // The pairing a reviewer reads the file for survives.
      expect(transcript).toContain("call_-7267060200698277786");

      expect(trace).toContain(rose.id);
      expect(trace).not.toContain("hunter2");
      expect(trace).toContain(CREDENTIAL_MASK);

      for (const shape of LEAK_SHAPES) {
        expect(transcript).not.toMatch(shape.re);
        expect(trace).not.toMatch(shape.re);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not mutate the trace it writes, or the artifact would record a mask as its literal", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "redact-test-"));
    try {
      const entry = { index: 1, tool: "type_text", value: "hunter2", target: { id: "PASSCODE" } };
      new DiscoveryEvidenceWriter(new EvidenceWriter(root, "run-01")).trace([entry]);

      // The CLI hands this same array to the compiler after writing it.
      expect(entry.value).toBe("hunter2");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
