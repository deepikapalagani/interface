/**
 * THE RISK PROFILE — where a compiled step's risk class comes from.
 *
 * Risk is the single input to the whole safety model: `policy.evaluate` gates on
 * it, the schema's refinement 7 forces `contract.risk` to equal the maximum over
 * the steps, and `couldHaveCommitted` decides from it whether a failed run may
 * answer `retry_safe`. Before this file the compiler stamped `read_only` on every
 * step it emitted — the LEAST conservative label in the enum — under a comment
 * saying the policy would raise it per screen at runtime. Both shipped CLIs
 * declare `screenRules: []`, so `resolveRisk` had nothing to raise with: a
 * discovery run that clicked a committing submit compiled to `read_only`, and a
 * failed replay of that artifact told its caller the card was untouched.
 *
 * The mistake was not the label. It was that risk is a property of the
 * APPLICATION — of what a given screen's controls can do — and neither the trace
 * nor the model can establish it. A trace records that a button was clicked and
 * the screen changed; whether that committed a transaction is knowledge about the
 * product, supplied by whoever profiled it. So it arrives here, as data.
 *
 * TWO RULES, AND THE SECOND IS THE POINT:
 *
 *   1. A control entry may RAISE a screen's risk, never lower it — the same
 *      direction `policy.resolveRisk` enforces against an artifact's own claim.
 *   2. A risk this profile cannot establish REFUSES THE COMPILE. The tempting
 *      fallback is the safest-LOOKING label, which is exactly how `read_only`
 *      became the default in the first place: a silent assumption that reads as a
 *      measurement everywhere downstream.
 *
 * Keyed on canonical SCREEN SYMBOLS and canonical TARGET SYMBOLS, deliberately,
 * so one profile serves every tenant running the same vendor product — the same
 * argument the artifact itself makes, and the same shape `policy.screenRules[]`
 * already uses.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { RiskClass } from "../capability/schema.js";

const ControlRisk = z.object({
  /** Canonical target SYMBOL, as the compiler names it after binding translation. */
  target: z.string().min(1),
  risk: RiskClass,
  note: z.string().min(1),
});

const ScreenRisk = z.object({
  /** Canonical screen SYMBOL — `MEMBER_SEARCH`, never `MBR0300`. */
  screen: z.string().min(1),
  /** What acting on this screen carries, unless a control below raises it. */
  risk: RiskClass,
  note: z.string().min(1),
  controls: z.array(ControlRisk).default([]),
});

export const RiskProfile = z.object({
  app: z.string().min(1),
  /** Recorded into the artifact's provenance by the caller, so a reviewer can tell which profile rated a step. */
  profileVersion: z.string().min(1),
  screens: z.array(ScreenRisk).min(1),
});

export type RiskProfile = z.infer<typeof RiskProfile>;

const ORDER: readonly RiskClass[] = ["read_only", "reversible", "irreversible"];

const higher = (a: RiskClass, b: RiskClass): RiskClass => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a);

/**
 * Raised instead of returning a default, because a default here is a claim about
 * an application nobody profiled.
 */
export class RiskNotEstablished extends Error {
  constructor(
    readonly screen: string | null,
    readonly target: string | null,
    readonly profileVersion: string,
  ) {
    super(
      `risk profile "${profileVersion}" does not rate screen ${screen === null ? "(unrecognised)" : `"${screen}"`}` +
        `${target === null ? "" : ` (target "${target}")`} — refusing to compile an acting step whose risk nothing established. ` +
        `Add the screen to the profile and re-compile from trace.jsonl; the alternative is stamping the least conservative label on a step that may commit.`,
    );
    this.name = "RiskNotEstablished";
  }
}

/**
 * The risk of acting on `screen`, raised by a control entry when `target` names
 * one. `null` means the profile is silent — the caller decides how loudly to say
 * so, because discovery and compilation refuse at different moments.
 */
export const riskFor = (profile: RiskProfile, screen: string | null, target: string | null): RiskClass | null => {
  if (screen === null) return null;
  const rule = profile.screens.find((s) => s.screen === screen);
  if (!rule) return null;
  if (target === null) return rule.risk;
  const control = rule.controls.find((c) => c.target === target);
  return control ? higher(rule.risk, control.risk) : rule.risk;
};

/** The same lookup, for the two call sites where silence must stop the run. */
export const riskForOrThrow = (profile: RiskProfile, screen: string | null, target: string | null): RiskClass => {
  const risk = riskFor(profile, screen, target);
  if (risk === null) throw new RiskNotEstablished(screen, target, profile.profileVersion);
  return risk;
};

/** Highest first: what a capability's `contract.risk` must equal (schema refinement 7). */
export const maxRisk = (risks: readonly RiskClass[]): RiskClass => risks.reduce(higher, "read_only");

/**
 * The profile the shipped CLI loads when `--risk-profile` is not given.
 *
 * Resolved against this module's own location rather than the process CWD, for
 * the reason `safety/redact.ts` anchors its `.env` fallback the same way: a
 * bare relative path silently resolves to nothing when a caller is launched from
 * somewhere else, and a silently absent safety input is worse than a missing one.
 */
export const DEFAULT_RISK_PROFILE_PATH = fileURLToPath(
  new URL("../../profiles/meridian-msc@4.2.risk.json", import.meta.url),
);

export const loadRiskProfile = (path: string): RiskProfile =>
  RiskProfile.parse(JSON.parse(readFileSync(path, "utf8")));
