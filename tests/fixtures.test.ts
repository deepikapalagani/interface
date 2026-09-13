/**
 * The hand-authored fixtures must be REAL artifacts, not approximations.
 *
 * `tests/fixtures/lookup@1.0.0.json` is what the first end-to-end replay run
 * drives, and it was written by hand because the discovery loop does not exist
 * yet. That makes it exactly the kind of thing that drifts out of validity
 * silently: it is data, nothing imports it, and a typo in a predicate would only
 * surface as a confusing runtime failure much later.
 *
 * So it is pinned here. The fixture has to survive all eight schema refinements,
 * and its symbols have to resolve to the tenant literals the mock actually
 * renders — which is the same round trip a discovered artifact will make.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { safeParseCapability } from "../src/capability/schema.js";
import { Binding, resolve } from "../src/capability/bind.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (name: string): unknown => JSON.parse(readFileSync(path.join(here, "fixtures", name), "utf8"));

describe("hand-authored fixtures", () => {
  it("the lookup capability survives every schema refinement", () => {
    const parsed = safeParseCapability(load("lookup@1.0.0.json"));
    if (!parsed.success) {
      // Print the actual issues — a bare `false` here would be a miserable failure.
      console.error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
    }
    expect(parsed.success).toBe(true);
  });

  it("the fcu binding is a valid binding", () => {
    const parsed = Binding.safeParse(load("fcu@4.2.json"));
    if (!parsed.success) {
      console.error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
    }
    expect(parsed.success).toBe(true);
  });

  it("resolves symbols to the literals the mock actually renders", () => {
    const cap = safeParseCapability(load("lookup@1.0.0.json"));
    const bind = Binding.safeParse(load("fcu@4.2.json"));
    expect(cap.success && bind.success).toBe(true);
    if (!cap.success || !bind.success) return;

    const resolved = resolve(cap.data, bind.data);
    const memberId = resolved.targets.find((t) => t.id === "MEMBER_ID");
    const submit = resolved.targets.find((t) => t.id === "SUBMIT");

    // Screen symbol -> the id the mock prints on the page.
    expect(memberId?.screen).toBe("MBR0300");
    // Frame symbol -> the frame the mock names in its frameset.
    expect(memberId?.framePath[0]?.name).toBe("content");
    // An anchor keys on the VISIBLE LABEL; a field keys on the form field NAME.
    expect(memberId?.strategies[0]?.key).toBe("MEMBER ID");
    expect(memberId?.strategies[1]?.key).toBe("MBRNO");
    expect(submit?.strategies[0]?.key).toBe("SUBMIT");
  });

  it("resolution does not mutate the artifact — one capability, many tenants", () => {
    const cap = safeParseCapability(load("lookup@1.0.0.json"));
    expect(cap.success).toBe(true);
    if (!cap.success) return;

    const bind = Binding.parse(load("fcu@4.2.json"));
    resolve(cap.data, bind);

    // Still speaking symbols afterwards, so the same object can be resolved
    // again against a different tenant.
    expect(cap.data.plan.targets[0]?.screen).toBe("MEMBER_SEARCH");
    expect(cap.data.plan.targets[0]?.strategies[0]?.key).toBe("MEMBER_ID");
  });

  it("is honestly labelled: not yet verified, and not model-authored", () => {
    const cap = safeParseCapability(load("lookup@1.0.0.json"));
    expect(cap.success).toBe(true);
    if (!cap.success) return;

    // A hand-written fixture must not claim a provenance it does not have. Once
    // a replay stamps it, this expectation is the thing that has to change.
    expect(cap.data.verification.replayResult).toBe("not_yet_verified");
    expect(cap.data.provenance.modelAuthoredFields).toEqual([]);
  });
});

/**
 * THE TWO CARD FIXTURES, pinned for a sharper reason than lookup@1.0.0 was.
 *
 * `set_status` is at least parsed by tests/card.integration.test.ts, which drives
 * it through a real browser. NOTHING IN THE REPO PARSES `report_lost` — it is data
 * no code path loads, because the only run that would load it needs a person at a
 * headed browser. That is exactly the silent-drift case this file exists for: a
 * typo in its predicates would otherwise surface for the first time in front of
 * whoever was demonstrating the §3.6 handoff.
 */
const CARD_FIXTURES = ["set_status@1.0.0.json", "report_lost@1.0.0.json"] as const;

describe("the card capabilities", () => {
  it.each(CARD_FIXTURES)("%s survives every schema refinement", (name) => {
    const parsed = safeParseCapability(load(name));
    if (!parsed.success) {
      console.error(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n"));
    }
    expect(parsed.success).toBe(true);
  });

  it.each(CARD_FIXTURES)("%s is honestly labelled: hand-authored, not yet verified", (name) => {
    const cap = safeParseCapability(load(name));
    expect(cap.success).toBe(true);
    if (!cap.success) return;
    expect(cap.data.provenance.model).toContain("hand-authored");
    expect(cap.data.provenance.modelAuthoredFields).toEqual([]);
    expect(cap.data.verification.replayResult).toBe("not_yet_verified");
  });

  /**
   * Refinement 7 is EQUALITY, so this is not a spot check: `reversible` is the
   * exact maximum over the steps, and it is what keeps this capability OUT of the
   * handoff path under the shipped policy (`reversible: allow`). Rounding it up
   * "to be safe" would both fail the schema and put a human turn inside the
   * determinism corpus.
   */
  it("set_status is reversible, and cannot express the irreversible action at all", () => {
    const cap = safeParseCapability(load("set_status@1.0.0.json"));
    expect(cap.success).toBe(true);
    if (!cap.success) return;

    expect(cap.data.contract.risk).toBe("reversible");
    expect(cap.data.plan.steps.find((s) => s.ref === "s07")?.risk).toBe("reversible");
    // The enum is the guard: LOST_STOLEN is not a value this artifact can carry.
    expect(cap.data.contract.inputs.find((i) => i.name === "action")?.enumValues).toEqual(["FREEZE", "UNFREEZE"]);
  });

  /**
   * The structural claim in report_lost's own `_comment`, asserted rather than
   * described: it is incapable of supplying the supervisor authority the app
   * demands, so the ONLY way its committing step completes is a person in the
   * live session. If someone ever "fixes" it by adding an override input, this
   * test fails — which is the point, because that edit would silently delete the
   * escalation it exists to force.
   */
  it("report_lost is irreversible and declares NO way to supply the authority it needs", () => {
    const cap = safeParseCapability(load("report_lost@1.0.0.json"));
    expect(cap.success).toBe(true);
    if (!cap.success) return;

    expect(cap.data.contract.risk).toBe("irreversible");
    expect(cap.data.plan.steps.find((s) => s.ref === "s07")?.risk).toBe("irreversible");

    // Two inputs, neither of them a credential, and no override among them.
    expect(cap.data.contract.inputs.map((i) => i.name)).toEqual(["member_id", "card_last4"]);
    expect(cap.data.contract.inputs.some((i) => i.sensitivity === "secret")).toBe(false);
    // And nothing in the plan can type one: the symbol is never targeted.
    expect(JSON.stringify(cap.data.plan)).not.toContain("OVERRIDE_CODE");

    // The action code is a literal, not a parameter — the risk is a property of
    // the artifact rather than of an argument a caller chooses.
    expect(cap.data.plan.steps.find((s) => s.ref === "s06")?.value).toBe("LOST_STOLEN");
  });

  it.each(CARD_FIXTURES)("%s resolves to the literals the mock actually renders", (name) => {
    const cap = safeParseCapability(load(name));
    const bind = Binding.safeParse(load("fcu@4.2.json"));
    expect(cap.success && bind.success).toBe(true);
    if (!cap.success || !bind.success) return;

    const resolved = resolve(cap.data, bind.data);
    const target = (id: string) => resolved.targets.find((t) => t.id === id);

    // An anchor keys on the VISIBLE LABEL; a field keys on the form field NAME.
    expect(target("CARD_SELECT")?.strategies[0]?.key).toBe("CARD (LAST 4)");
    expect(target("CARD_SELECT")?.strategies[1]?.key).toBe("SEL");
    expect(target("CARD_APPLY")?.strategies[0]?.key).toBe("APPLY");
    expect(target("OPEN_MEMBER")?.strategies[0]?.key).toBe("SELECT");
    expect(target("CARD_SERVICES_LINK")?.strategies[0]?.key).toBe("CARD SERVICES");

    // Screen symbols resolve to the ids the mock prints on the page.
    expect(target("CARD_SELECT")?.screen).toBe("CRD0500");
    expect(target("CONFIRMATION_NUMBER")?.screen).toBe("CNF9000");
    // The static-text read anchors on the label beside the value, never an index.
    expect(target("CONFIRMATION_NUMBER")?.strategies[0]?.key).toBe("CONFIRMATION");
  });
});
