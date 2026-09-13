/**
 * THE DISCOVERY TOOL SURFACE — seven tools, and one rule that shapes all of them.
 *
 * THE MODEL NEVER NAMES A SELECTOR. It points at a `ref` from the observation it
 * was just shown, restates the `screen_id` it believes it is on, and says in one
 * sentence why that target should still be findable later. The EXECUTOR — never
 * the model — turns that ref into a durable descriptor.
 *
 * That division is the core mechanism of the whole system. If the model were
 * allowed to invent a selector, the recorded artifact would inherit the model's
 * guess about robustness, and replay would be only as stable as one turn of
 * inference. Instead the model contributes intent, and mechanical code
 * contributes the locator. `why_stable` is captured as the model's stated BELIEF
 * and recorded as such in the artifact's robustness notes — it is never treated
 * as a fact the system verified.
 *
 * The restated `screen_id` is a cheap, effective cross-check: if the model thinks
 * it is on MBR0300 while the surface says MBR0310, its mental model has drifted
 * from reality and acting on that would corrupt the recording.
 *
 * Tools are frozen and sorted by name so the prompt prefix is byte-stable across
 * turns, which is what makes prompt caching possible at all.
 *
 * THERE IS NO `screenshot` TOOL, and its absence is deliberate. One was declared
 * and described to the model as "request an image of the screen"; the executor
 * answered it with the same text observation `observe` returns, because the wire
 * format between the loop and the provider carries strings only and no image ever
 * reached the model. An affordance that silently does something other than what
 * its description promises is worse than a missing one — it burns a turn, and the
 * model has no way to learn that looking harder is not available. Vision-based
 * perception is a real gap and is recorded as a cut, not papered over with a tool
 * that pretends.
 */
import { z } from "zod";
import type { ToolSpec } from "../model/provider.js";

/** A within-turn handle from the latest observation. Never persisted. */
const ref = z.string().min(1).describe("The ref of the target from the latest observation, e.g. f2e13.");
const screenId = z.string().min(1).describe("The screen id you believe you are currently on, restated from the observation.");
const whyStable = z
  .string()
  .min(1)
  .describe("One sentence: why should this control still be findable on this screen next month?");

export const ToolArgs = {
  observe: z.object({}),
  click: z.object({ ref, screen_id: screenId, why_stable: whyStable }),
  type_text: z.object({
    ref,
    screen_id: screenId,
    text: z.string().describe("The literal text to type. Use the real value; parameterisation happens later."),
    why_stable: whyStable,
  }),
  read: z.object({
    ref,
    screen_id: screenId,
    why_stable: whyStable,
    as: z.string().min(1).describe("A short snake_case name for this value, if it should become an output."),
  }),
  dialog: z.object({
    action: z.enum(["accept", "dismiss"]).describe("How to answer the dialog that is currently blocking."),
    reason: z.string().min(1).describe("Why this is the safe answer."),
  }),
  finish: z.object({
    summary: z.string().min(1).describe("What was accomplished, in one sentence."),
    checkpoint: z.string().min(1).describe("What is visible on screen that proves the goal was reached."),
  }),
  stuck: z.object({
    reason: z.string().min(1).describe("What you tried and why you cannot proceed."),
  }),
} as const;

export type ToolName = keyof typeof ToolArgs;

export const TERMINAL_TOOLS: readonly ToolName[] = ["finish", "stuck"];

/**
 * JSON Schema for the wire, written alongside the Zod schema rather than
 * generated, to avoid a dependency for seven tiny objects. `tools.test.ts` pins
 * the two together so they cannot drift apart silently.
 */
const str = (description: string) => ({ type: "string", description });

const SPECS: Record<ToolName, ToolSpec> = {
  click: {
    name: "click",
    description: "Click a control. Use for buttons, links and image submits.",
    parameters: {
      type: "object",
      properties: {
        ref: str("The ref of the target from the latest observation, e.g. f2e13."),
        screen_id: str("The screen id you believe you are currently on."),
        why_stable: str("One sentence: why will this control still be findable later?"),
      },
      required: ["ref", "screen_id", "why_stable"],
      additionalProperties: false,
    },
  },
  dialog: {
    name: "dialog",
    description: "Answer a native dialog that is blocking the page. Only valid when one is present.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["accept", "dismiss"], description: "How to answer it." },
        reason: str("Why this is the safe answer."),
      },
      required: ["action", "reason"],
      additionalProperties: false,
    },
  },
  finish: {
    name: "finish",
    description: "Declare the goal reached. Only call this when the screen proves it.",
    parameters: {
      type: "object",
      properties: {
        summary: str("What was accomplished, in one sentence."),
        checkpoint: str("What is visible on screen that proves the goal was reached."),
      },
      required: ["summary", "checkpoint"],
      additionalProperties: false,
    },
  },
  observe: {
    name: "observe",
    description: "Look at the current screen again. Use after something may have changed.",
    parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  read: {
    name: "read",
    description: "Read a value from the screen, capturing it as a candidate output of this capability.",
    parameters: {
      type: "object",
      properties: {
        ref: str("The ref of the value from the latest observation."),
        screen_id: str("The screen id you believe you are currently on."),
        why_stable: str("One sentence: why will this value still be findable later?"),
        as: str("A short snake_case name for this value."),
      },
      required: ["ref", "screen_id", "why_stable", "as"],
      additionalProperties: false,
    },
  },
  stuck: {
    name: "stuck",
    description: "Declare that you cannot proceed. Preferable to guessing.",
    parameters: {
      type: "object",
      properties: { reason: str("What you tried and why you cannot proceed.") },
      required: ["reason"],
      additionalProperties: false,
    },
  },
  type_text: {
    name: "type_text",
    description: "Type into a field. Use the real value; parameterisation happens after the run.",
    parameters: {
      type: "object",
      properties: {
        ref: str("The ref of the field from the latest observation."),
        screen_id: str("The screen id you believe you are currently on."),
        text: str("The literal text to type."),
        why_stable: str("One sentence: why will this field still be findable later?"),
      },
      required: ["ref", "screen_id", "text", "why_stable"],
      additionalProperties: false,
    },
  },
};

/** Sorted and frozen: a byte-stable tool list is a precondition for prompt caching. */
export const TOOL_SPECS: readonly ToolSpec[] = Object.freeze(
  (Object.keys(SPECS) as ToolName[]).sort().map((n) => SPECS[n]),
);

export const isToolName = (name: string): name is ToolName => name in ToolArgs;

export type ParsedArgs =
  | { readonly ok: true; readonly name: ToolName; readonly args: Record<string, unknown> }
  | { readonly ok: false; readonly error: string };

/**
 * Validate what the model sent.
 *
 * MEASURED: no provider we target enforces a tool's schema, so arguments arrive
 * unvalidated and occasionally malformed. A failure here is not fatal — the
 * message is handed straight back to the model as a tool result so it can
 * correct itself, which is far cheaper than derailing a run.
 */
export const parseToolArgs = (name: string, raw: Readonly<Record<string, unknown>>): ParsedArgs => {
  if (!isToolName(name)) {
    return { ok: false, error: `unknown tool "${name}"; available: ${Object.keys(ToolArgs).sort().join(", ")}` };
  }
  const parsed = ToolArgs[name].safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: `invalid arguments for ${name}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`,
    };
  }
  return { ok: true, name, args: parsed.data as Record<string, unknown> };
};
