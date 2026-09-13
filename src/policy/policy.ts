/**
 * THE ALLOWLIST AND RISK POLICY — §3.4-a/b.
 *
 * "Enforce an explicit, configurable allowlist. The agent must not act outside
 * it." Two properties make that true rather than aspirational:
 *
 *   1. The policy is DATA, loaded and validated at startup, hashed into every
 *      run manifest. A reviewer can read what the agent was permitted to do
 *      without reading the agent.
 *
 *   2. `evaluate()` is PURE. It takes a request and returns a decision; it holds
 *      no driver and performs no I/O, so it is exhaustively testable without a
 *      browser. Enforcement happens at exactly one call site — the surface
 *      chokepoint — because that is the only place that can issue an action.
 *
 * The rule that matters most here is the least obvious: the admin plane is
 * denied. A capability that could reach `/__admin/**` could arm its own faults
 * or reset the target mid-run, which would make every other guarantee
 * negotiable.
 */
import { z } from "zod";
import type { RiskClass } from "../capability/schema.js";

export const PolicyDocument = z.object({
  version: z.string(),
  /** Exact origins the agent may reach. Anything else is denied, including redirects. */
  allowedOrigins: z.array(z.string().url()).min(1),
  /**
   * Path prefixes denied even on an allowed origin.
   *
   * CANNOT FIRE IN PRODUCTION AS WIRED, and that is worth stating here rather
   * than leaving a reviewer to infer enforcement. `evaluate()` tests this against
   * `req.url`, which is the page the session ALREADY OCCUPIES (see
   * `ActionContext.url`), and no action verb carries a destination — so nothing
   * the agent can issue ever asks for `/__admin/**`, and this rule never gets a
   * chance to refuse one.
   *
   * What actually protects the admin plane is therefore structural, not this
   * rule: there is no mechanism by which a capability can request a URL. The
   * plan names controls, and `/__admin` has no control on any rendered screen.
   * This entry is the belt to that structure's braces — it would refuse an agent
   * that had somehow come to be STANDING on an admin route — and it is what a
   * reviewer reads to see the intent declared. It is not the enforcement.
   */
  deniedRoutes: z.array(z.string()).default([]),
  /** The only action kinds permitted at all. */
  allowedActions: z.array(z.enum(["navigate", "click", "fill", "press", "accept_dialog", "dismiss_dialog"])).min(1),
  /** Per-screen overrides, keyed by canonical SYMBOL rather than a tenant's literal. */
  screenRules: z
    .array(
      z.object({
        screen: z.string(),
        /** Fields on this screen that may never be filled by automation. */
        deniedFields: z.array(z.string()).default([]),
        /** The risk this screen's mutating actions carry, regardless of artifact claim. */
        risk: z.enum(["read_only", "reversible", "irreversible"]).optional(),
      }),
    )
    .default([]),
  /** What each risk class requires before it may proceed. */
  riskHandling: z.object({
    read_only: z.enum(["allow", "confirm", "block"]),
    reversible: z.enum(["allow", "confirm", "block"]),
    irreversible: z.enum(["allow", "confirm", "block"]),
  }),
  /**
   * The run-level ceiling, DECLARED here and deliberately not read by `evaluate()`.
   *
   * A per-action decision cannot see a run-level count, so enforcing it here is
   * structurally impossible — the reader has to be whatever owns the loop, and
   * both loops now read it. `src/replay/main.ts` takes `maxRunSeconds` as the
   * executor's `budgets.runMs`; `src/discover/main.ts` takes both `maxSteps` and
   * `maxRunSeconds` as the discovery `StopController`'s limits. So changing this
   * file changes how long a run may take, which is what makes it a policy rather
   * than documentation.
   *
   * WHAT IS STILL NOT SOURCED FROM HERE: the replay CLI's per-STEP budget, which
   * remains its own constant. `maxSteps` likewise binds only discovery — replay
   * walks whatever the artifact declares and is bounded by the wall clock, not by
   * a step count. A reviewer reading this record should not infer that every
   * number in it constrains every run.
   */
  caps: z.object({ maxSteps: z.number().int().positive(), maxRunSeconds: z.number().int().positive() }),
});

export type PolicyDocument = z.infer<typeof PolicyDocument>;

export interface PolicyRequest {
  readonly action: string;
  readonly url: string;
  readonly screen: string | null;
  readonly field?: string;
  /** What the ARTIFACT claims this step's risk is. Never trusted downward. */
  readonly claimedRisk: RiskClass;
}

export interface PolicyDecision {
  readonly allow: boolean;
  /** Which dimension refused, so a denial is debuggable rather than opaque. */
  readonly dimension: "origin" | "route" | "action" | "field" | "risk" | "none";
  readonly ruleId: string;
  readonly effectiveRisk: RiskClass;
  /** True when the policy rates the step riskier than the artifact claimed. */
  readonly riskDrift: boolean;
  readonly requires: "nothing" | "confirmation" | "human";
  readonly reason: string;
}

const ORDER: readonly RiskClass[] = ["read_only", "reversible", "irreversible"];

/**
 * An artifact may never talk its way DOWN. The effective risk is the max of what
 * the artifact claims and what the policy says the screen carries, so editing an
 * artifact cannot lower the gate it has to pass.
 */
export const resolveRisk = (claimed: RiskClass, fromPolicy: RiskClass | undefined): RiskClass =>
  fromPolicy && ORDER.indexOf(fromPolicy) > ORDER.indexOf(claimed) ? fromPolicy : claimed;

const deny = (
  dimension: PolicyDecision["dimension"],
  ruleId: string,
  reason: string,
  effectiveRisk: RiskClass,
  riskDrift: boolean,
): PolicyDecision => ({ allow: false, dimension, ruleId, effectiveRisk, riskDrift, requires: "nothing", reason });

/** Pure. No I/O, no driver, no clock — which is why it is exhaustively testable. */
export const evaluate = (policy: PolicyDocument, req: PolicyRequest): PolicyDecision => {
  let origin: string;
  try {
    origin = new URL(req.url).origin;
  } catch {
    return deny("origin", "origin.malformed", `"${req.url}" is not a URL`, req.claimedRisk, false);
  }

  if (!policy.allowedOrigins.some((o) => new URL(o).origin === origin)) {
    return deny("origin", "origin.allowlist", `origin ${origin} is not on the allowlist`, req.claimedRisk, false);
  }

  const path = new URL(req.url).pathname;
  const denied = policy.deniedRoutes.find((r) => path.startsWith(r));
  if (denied) {
    return deny("route", `route.denied:${denied}`, `route ${path} is denied (${denied})`, req.claimedRisk, false);
  }

  if (!policy.allowedActions.includes(req.action as PolicyDocument["allowedActions"][number])) {
    return deny("action", `action.denied:${req.action}`, `action "${req.action}" is not permitted`, req.claimedRisk, false);
  }

  const rule = req.screen ? policy.screenRules.find((s) => s.screen === req.screen) : undefined;
  if (rule && req.field && rule.deniedFields.includes(req.field)) {
    return deny("field", `field.denied:${req.screen}.${req.field}`, `field ${req.field} may not be filled by automation`, req.claimedRisk, false);
  }

  const effectiveRisk = resolveRisk(req.claimedRisk, rule?.risk);
  const riskDrift = effectiveRisk !== req.claimedRisk;
  const handling = policy.riskHandling[effectiveRisk];

  if (handling === "block") {
    return { allow: false, dimension: "risk", ruleId: `risk.block:${effectiveRisk}`, effectiveRisk, riskDrift, requires: "human", reason: `${effectiveRisk} actions are blocked by policy` };
  }
  if (handling === "confirm") {
    return { allow: false, dimension: "risk", ruleId: `risk.confirm:${effectiveRisk}`, effectiveRisk, riskDrift, requires: "human", reason: `${effectiveRisk} actions require a human decision` };
  }
  return { allow: true, dimension: "none", ruleId: "allow", effectiveRisk, riskDrift, requires: "nothing", reason: "permitted" };
};

/** Load-time refusal: check an artifact's whole plan before a browser is launched. */
export const validatePlanOrigins = (policy: PolicyDocument, urls: readonly string[]): string[] =>
  urls.filter((u) => {
    try {
      return !policy.allowedOrigins.some((o) => new URL(o).origin === new URL(u).origin);
    } catch {
      return true;
    }
  });
