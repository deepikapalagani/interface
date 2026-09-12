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
