/**
 * The allowlist, exhaustively — no browser, no key, milliseconds.
 *
 * §3.4-a says the agent "must not act outside" the allowlist, and §7 grades
 * whether that is enforced or merely described. `evaluate()` being pure is what
 * makes the claim checkable: every denial dimension gets a case, and each asserts
 * WHICH dimension refused, so a rule that starts denying for the wrong reason
 * shows up as a failure rather than a still-green test.
 */
import { describe, expect, it } from "vitest";
import { PolicyDocument, evaluate, resolveRisk, validatePlanOrigins } from "../src/policy/policy.js";

/** Mirrors the real policy shipped against the mock. */
const policy = PolicyDocument.parse({
  version: "1.0.0",
  allowedOrigins: ["http://localhost:7101"],
  // The admin plane. A capability that could reach it could arm its own faults.
  deniedRoutes: ["/__admin"],
  allowedActions: ["navigate", "click", "fill", "press", "dismiss_dialog"],
  screenRules: [
    { screen: "CARD_SERVICES", deniedFields: ["OVERRIDE_CODE"], risk: "irreversible" },
    { screen: "MEMBER_SEARCH", deniedFields: [] },
  ],
  riskHandling: { read_only: "allow", reversible: "allow", irreversible: "confirm" },
  caps: { maxSteps: 40, maxRunSeconds: 300 },
});

const req = (over: Partial<Parameters<typeof evaluate>[1]> = {}) => ({
  action: "click",
  url: "http://localhost:7101/screen/search",
  screen: "MEMBER_SEARCH" as string | null,
  claimedRisk: "read_only" as const,
  ...over,
});

describe("policy evaluation", () => {
  it("permits an ordinary read-only action on an allowed origin", () => {
    const d = evaluate(policy, req());
    expect(d.allow).toBe(true);
    expect(d.dimension).toBe("none");
  });

  it("denies an origin that is not on the allowlist", () => {
    const d = evaluate(policy, req({ url: "http://evil.example/screen/search" }));
    expect(d.allow).toBe(false);
    expect(d.dimension).toBe("origin");
  });

  it("denies the admin plane even on an allowed origin", () => {
    const d = evaluate(policy, req({ url: "http://localhost:7101/__admin/reset" }));
    expect(d.allow).toBe(false);
    expect(d.dimension).toBe("route");
    expect(d.ruleId).toContain("/__admin");
  });

  it("denies an action kind that is not permitted at all", () => {
    const d = evaluate(policy, req({ action: "accept_dialog" }));
    expect(d.allow).toBe(false);
    expect(d.dimension).toBe("action");
  });

  it("denies a field the policy protects, on the screen that protects it", () => {
    const d = evaluate(policy, req({ action: "fill", screen: "CARD_SERVICES", field: "OVERRIDE_CODE" }));
    expect(d.allow).toBe(false);
    expect(d.dimension).toBe("field");
  });

  it("allows that same field name on a screen with no such rule", () => {
    const d = evaluate(policy, req({ action: "fill", screen: "MEMBER_SEARCH", field: "OVERRIDE_CODE" }));
    expect(d.allow).toBe(true);
  });

  it("an artifact cannot talk its own risk down", () => {
    // The artifact claims read_only; the policy says this screen is irreversible.
    const d = evaluate(policy, req({ screen: "CARD_SERVICES", claimedRisk: "read_only" }));
    expect(d.effectiveRisk).toBe("irreversible");
    expect(d.riskDrift).toBe(true);
    expect(d.allow).toBe(false);
    expect(d.requires).toBe("human");
  });

  it("resolveRisk takes the maximum, never the claim", () => {
    expect(resolveRisk("read_only", "irreversible")).toBe("irreversible");
    expect(resolveRisk("irreversible", "read_only")).toBe("irreversible");
    expect(resolveRisk("reversible", undefined)).toBe("reversible");
  });

  it("a malformed url is denied rather than parsed optimistically", () => {
    const d = evaluate(policy, req({ url: "not a url" }));
    expect(d.allow).toBe(false);
    expect(d.dimension).toBe("origin");
  });

  /**
   * RENAMED, loudly, because the old name claimed a system property this test
   * does not exercise. It was "plan origins are validated before a browser is
   * ever launched" — but nothing here launches anything, and nothing here calls
   * a CLI. All it exercises is the pure function: given a policy and a list of
   * urls, which ones are off the allowlist. The ORDERING claim (that this runs
   * before `PlaywrightSurface.launch`) is a property of the replay CLI and has
   * to be asserted there against the CLI, not here against the helper.
   */
  it("validatePlanOrigins returns every plan url whose origin is off the allowlist", () => {
    const bad = validatePlanOrigins(policy, [
      "http://localhost:7101/screen/search",
      "http://localhost:7102/screen/search",
      "garbage",
    ]);
    expect(bad).toEqual(["http://localhost:7102/screen/search", "garbage"]);
  });
});
