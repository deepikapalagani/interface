/**
 * THE MODEL-FACING VIEW — what one turn of the discovery loop actually costs.
 *
 * This is the only place an observation becomes text a model reads, which makes
 * it the single lever over both cost and coherence. Measured on this surface:
 * a dense results grid serialises to roughly 1,300 tokens, and a 30-turn run
 * that resends every snapshot reaches ~686K input tokens against ~136K when only
 * the latest is kept. The rendering below is therefore deliberately lean.
 *
 * Three rules:
 *
 *   REFS ARE THE ONLY HANDLE. Every actionable line carries its ref, because the
 *   model's whole job is to point at one. It is never shown a selector, so it
 *   cannot propose one — the locator is minted mechanically from what it points
 *   at.
 *
 *   TRUNCATION ANNOUNCES ITSELF. A silent cap is worse than a small context: the
 *   model would confidently act on a screen it was shown only part of, and
 *   nothing downstream could tell. Every omission is counted in the output.
 *
 *   REDACTION IS ON BY DEFAULT. These screens render an unmasked card number and
 *   SSN, and the model context is one of the four boundaries §3.4 covers. This
 *   was a hook with an IDENTITY default and no call site that passed it, which
 *   made the whole layer decorative; the policy in `safety/redact.ts` now
 *   applies unless a caller deliberately overrides it. What it masks and what it
 *   deliberately leaves alone — the member id the model has to type — is argued
 *   there.
 */
import { redactText } from "../safety/redact.js";
import type { Node, Observation } from "./types.js";

export interface SerializeOptions {
  /** Hard ceiling on actionable lines. Anything beyond is reported, not dropped silently. */
  readonly maxControls?: number;
  /** Hard ceiling on lines of page text. */
  readonly maxTextLines?: number;
  /**
   * Applied to every string that leaves for the model. Defaults to the real
   * policy; an override exists for diagnostics — a test proving the screen
   * genuinely carries the value that the default then masks.
   */
  readonly redact?: (text: string) => string;
}

const DEFAULTS = { maxControls: 40, maxTextLines: 40 } as const;

/** Roles a model can actually do something with. Static text is context, not a target. */
const ACTIONABLE = new Set(["textbox", "button", "link", "combobox", "checkbox", "radio", "menuitem", "tab"]);

/**
 * One actionable control, as the model sees it.
 *
 * The label and field name are not decoration. Accessible names on this surface
 * are empty, so without them every text input renders as an indistinguishable
 * `textbox` and the model has nothing to choose on — measured, when it reached
 * for the nav frame's quick-lookup box instead of the member-id field.
 */
const describeNode = (n: Node): string => {
  const name = n.name.trim();
  const parts = [`  [ref=${n.ref}] ${n.role}`];
  if (name) parts.push(` "${name}"`);
  if (n.anchorText) parts.push(` labelled "${n.anchorText}"`);
  if (n.fieldName) parts.push(` field=${n.fieldName}`);
  if (n.framePath.length > 0) parts.push(` frame=${n.framePath[n.framePath.length - 1]}`);
  return parts.join("");
};

/**
 * Render one observation for the model.
 *
 * The shape is stable turn to turn — screen, then controls, then text — because
 * a model that has to re-learn the layout of its own input each turn spends
 * attention on parsing rather than on the task.
 */
export const observationToText = (obs: Observation, options: SerializeOptions = {}): string => {
  const maxControls = options.maxControls ?? DEFAULTS.maxControls;
  const maxTextLines = options.maxTextLines ?? DEFAULTS.maxTextLines;
  const redact = options.redact ?? redactText;

  const out: string[] = [];

  out.push(`SCREEN: ${obs.screen ?? "(unrecognised)"}`);

  if (obs.dialog) {
    // First, and unmissable: a blocking dialog means nothing else on the page can
    // be acted on until it is answered.
    out.push(`DIALOG BLOCKING THE PAGE: "${redact(obs.dialog.message)}"`);
    out.push(`  Answer it with the dialog tool before doing anything else.`);
  }

  const actionable = obs.nodes.filter((n) => ACTIONABLE.has(n.role));
  const shown = actionable.slice(0, maxControls);

  out.push("", `CONTROLS (${actionable.length}):`);
  if (shown.length === 0) {
    out.push("  (none — this screen has no controls the accessibility tree exposes)");
  } else {
    for (const n of shown) out.push(redact(describeNode(n)));
    if (actionable.length > shown.length) {
      out.push(`  ... ${actionable.length - shown.length} more control(s) not shown; narrow the screen before acting on them`);
    }
  }

  const lines = redact(obs.text)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const textShown = lines.slice(0, maxTextLines);

  out.push("", `PAGE TEXT (${lines.length} line(s)):`);
  for (const l of textShown) out.push(`  ${l}`);
  if (lines.length > textShown.length) {
    out.push(`  ... ${lines.length - textShown.length} more line(s) omitted`);
  }

  return out.join("\n");
};

/**
 * A one-line summary for the trace and the event log.
 *
 * Deliberately not the full rendering: the log records what the run saw, and a
 * full snapshot per line would make the evidence unreadable and enormous.
 */
export const observationSummary = (obs: Observation): string => {
  const controls = obs.nodes.filter((n) => ACTIONABLE.has(n.role)).length;
  return `${obs.screen ?? "(unrecognised)"} — ${controls} control(s)${obs.dialog ? ", DIALOG blocking" : ""}`;
};
