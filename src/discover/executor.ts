/**
 * MINTING — the conversion at the heart of the whole system.
 *
 * The model points at a `ref` from the observation it was just shown. A ref is
 * valid only until the surface changes, so recording one would produce an
 * artifact that replays today and breaks tomorrow. This module is the seam where
 * an ephemeral handle becomes a durable target, and the rule it enforces is:
 *
 *     THE MODEL CONTRIBUTES INTENT. MECHANICAL CODE CONTRIBUTES THE LOCATOR.
 *
 * `surface.describe(ref)` resolves the ref back to the live element and harvests
 * the two facts that survive: the label cell beside it (a structural anchor) and
 * the app's own field name (a frame-scoped fallback). Both are measured from the
 * DOM, not proposed by the model. The model's `why_stable` sentence is recorded
 * as a stated BELIEF in the robustness note — never as a fact the system checked.
 *
 * And a minted target is VERIFIED BEFORE IT IS RECORDED: it must resolve to
 * exactly one element right now, or the mint fails. An artifact whose targets
 * were never once proven resolvable is a promise, not a recording.
 */
import type { TargetDescriptor } from "../capability/schema.js";
import { dataRowCount } from "../replay/predicate.js";
import type {
  ActionContext,
  Observation,
  Surface,
  SurfaceAction,
  TargetFacts,
} from "../surface/types.js";
import { SurfaceRefused } from "../surface/types.js";
import { parseToolArgs, type ToolName } from "./tools.js";

/** One executed tool call, as it will be written to the trace. */
export interface TraceEntry {
  readonly index: number;
  readonly tool: ToolName;
  readonly screenBefore: string | null;
  readonly screenAfter: string | null;
  /**
   * Data rows visible after the step, counted by the replay evaluator's own
   * `dataRowCount`.
   *
   * Recorded so the compiler can assert a row count it OBSERVED. Without it the
   * compiled checkpoint is screen-only, and a zero-row results screen satisfies
   * it — reporting "not found" as success, which §3.3 calls the most common
   * design mistake.
   */
  readonly rowsAfter?: number;
  /** Minted for acting tools; absent for perception and terminal tools. */
  readonly target?: TargetDescriptor;
  /** The literal typed, before any parameterisation. */
  readonly value?: string;
  /** For `read`: the captured value and the name the model gave it. */
  readonly captured?: { readonly as: string; readonly value: string };
  /** The model's stated reason. A belief, recorded as one. */
  readonly modelBelief?: string;
}

export type ToolOutcome =
  | { readonly kind: "observed"; readonly observation: Observation }
  | { readonly kind: "acted"; readonly entry: TraceEntry; readonly observation: Observation }
  | { readonly kind: "terminal"; readonly tool: "finish" | "stuck"; readonly detail: string }
  /** Handed straight back to the model as a tool result so it can correct itself. */
  | { readonly kind: "error"; readonly message: string };

export interface DiscoverDeps {
  readonly surface: Surface;
  readonly actor: () => "automation" | "human";
  /**
   * The lease epoch, read at the moment each action is BUILT — see
   * `ActionContext.epoch`. A function rather than a number for the same reason
   * `actor` is: discovery holds no lease, so both are windows onto one the caller
   * owns, and a snapshot taken at construction would be stale by the first
   * handoff.
   */
  readonly epoch: () => number;
}

/** "MEMBER ID" -> MEMBER_ID. Symbols must satisfy the schema's Symbolic pattern. */
const toSymbol = (raw: string): string | null => {
  const s = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return /^[A-Z][A-Z0-9_]*$/.test(s) ? s : null;
};

const roleForTag = (tag: string): string | undefined => {
  if (tag === "input" || tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  return undefined;
};

export class MintFailure extends Error {
  constructor(
    readonly ref: string,
    readonly why: string,
  ) {
    super(`cannot record a durable target for ref ${ref}: ${why}`);
    this.name = "MintFailure";
  }
}

/**
 * Turn measured facts into a recorded target.
 *
 * Strategy ORDER is the inverted one the measurements justified: the structural
 * anchor first, the app's own field name second, role+name last — because on a
 * legacy servicing screen accessible names are frequently empty, and the anchor
 * survived both a frame rename and a field rename where the field name survived
 * neither.
 */
export const mint = (facts: TargetFacts, screen: string, belief: string): TargetDescriptor => {
  const strategies: TargetDescriptor["strategies"] = [];

  if (facts.anchorText) {
    const symbol = toSymbol(facts.anchorText);
    if (symbol) strategies.push({ kind: "table_anchor", key: symbol, matchedAtRecord: 1 });
  }
  if (facts.fieldName) {
    const symbol = toSymbol(facts.fieldName);
    if (symbol) strategies.push({ kind: "field_key", key: symbol, matchedAtRecord: 1 });
  }

  if (strategies.length === 0) {
    // Deliberately no fallback to the ref or to coordinates. If nothing durable
    // was found, the honest outcome is refusing to record — a target that cannot
    // be described is a target that cannot be replayed.
    throw new MintFailure("", "no anchor text and no field name; nothing durable to record");
  }

  const id = strategies[0]?.key ?? "TARGET";
  const role = roleForTag(facts.tag);

  return {
    id,
    screen,
    framePath: facts.framePath.length > 0 ? facts.framePath.map((name) => ({ name })) : [{ index: 0 }],
    strategies,
    verify: role ? { role } : {},
    nameMayContainPii: false,
    // Attributed, so a reviewer can see which parts of an artifact are a model's
    // claim and which are measured.
    robustness: `Model's stated reason: "${belief}". Anchors recorded from the live element: ${facts.anchorText ? `label "${facts.anchorText}"` : "no label"}, ${facts.fieldName ? `field "${facts.fieldName}"` : "no field name"}.`,
  };
};

/**
 * Execute one validated tool call.
 *
 * Every acting path mints first, verifies the mint resolves, and only then acts —
 * so the trace can never contain a step whose target was not proven findable at
 * the moment it was recorded.
 */
export const execute = async (
  index: number,
  toolName: string,
  rawArgs: Readonly<Record<string, unknown>>,
  deps: DiscoverDeps,
): Promise<ToolOutcome> => {
  const parsed = parseToolArgs(toolName, rawArgs);
  if (!parsed.ok) return { kind: "error", message: parsed.error };

  const { surface, actor, epoch } = deps;
  const { name, args } = parsed;

  if (name === "finish" || name === "stuck") {
    const detail = name === "finish" ? `${String(args["summary"])} (checkpoint: ${String(args["checkpoint"])})` : String(args["reason"]);
    return { kind: "terminal", tool: name, detail };
  }

  const before = await surface.observe();

  if (name === "observe" || name === "screenshot") {
    return { kind: "observed", observation: before };
  }

  if (name === "dialog") {
    if (!before.dialog) return { kind: "error", message: "no dialog is currently blocking the page" };
    const action: SurfaceAction = args["action"] === "accept" ? { kind: "accept_dialog" } : { kind: "dismiss_dialog" };
    await surface.act(action, { stepRef: `d${index}`, risk: "read_only", actor: actor(), epoch: epoch(), url: before.location, screen: before.screen });
    const after = await surface.observe();
    return {
      kind: "acted",
      entry: {
        index,
        tool: name,
        screenBefore: before.screen,
        screenAfter: after.screen,
        rowsAfter: dataRowCount(after),
        modelBelief: String(args["reason"]),
      },
      observation: after,
    };
  }

  // ---- the acting tools: mint, verify, then act ------------------------------
  const ref = String(args["ref"]);
  const claimedScreen = String(args["screen_id"]);
  const belief = String(args["why_stable"]);

  // A cheap drift check: if the model's mental model has diverged from the
  // surface, acting on it would corrupt the recording.
  if (before.screen && claimedScreen !== before.screen) {
    return {
      kind: "error",
      message: `you said you are on ${claimedScreen} but the surface is showing ${before.screen}; observe again before acting`,
    };
  }

  const facts = await surface.describe(ref);
  if (!facts) return { kind: "error", message: `ref ${ref} no longer resolves; observe again to get current refs` };

  let target: TargetDescriptor;
  try {
    target = mint(facts, before.screen ?? "UNKNOWN_SCREEN", belief);
  } catch (e) {
    return { kind: "error", message: e instanceof MintFailure ? e.message : String(e) };
  }

  // Prove it before recording it.
  const resolution = await surface.find(target).catch(() => null);
  if (!resolution) {
    return { kind: "error", message: `the durable target minted for ref ${ref} did not resolve; pick a control with a label or a field name` };
  }

  const ctx: ActionContext = {
    stepRef: `s${String(index).padStart(2, "0")}`,
    risk: "read_only",
    actor: actor(),
    epoch: epoch(),
    url: before.location,
    screen: before.screen,
    ...(name === "type_text" ? { field: target.id } : {}),
  };

  try {
    if (name === "read") {
      const value = await surface.read(target);
      if (value === null) return { kind: "error", message: `nothing readable at ref ${ref}` };
      const after = await surface.observe();
      return {
        kind: "acted",
        entry: {
          index,
          tool: name,
          screenBefore: before.screen,
          screenAfter: after.screen,
          rowsAfter: dataRowCount(after),
          target,
          captured: { as: String(args["as"]), value },
          modelBelief: belief,
        },
        observation: after,
      };
    }

    const action: SurfaceAction =
      name === "type_text" ? { kind: "fill", target, value: String(args["text"]) } : { kind: "click", target };

    await surface.act(action, ctx);
    const after = await surface.observe();

    return {
      kind: "acted",
      entry: {
        index,
        tool: name,
        screenBefore: before.screen,
        screenAfter: after.screen,
        rowsAfter: dataRowCount(after),
        target,
        ...(name === "type_text" ? { value: String(args["text"]) } : {}),
        modelBelief: belief,
      },
      observation: after,
    };
  } catch (e) {
    // A refusal is information for the model, not a crash: the allowlist and the
    // lease both surface here, and the model can choose a different approach.
    if (e instanceof SurfaceRefused) return { kind: "error", message: `refused: ${e.message}` };
    throw e;
  }
};
