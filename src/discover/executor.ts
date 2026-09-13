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
 * A minted target is PROVEN BEFORE IT IS RECORDED: an acting target must resolve
 * to exactly one element right now, and a `read` target must yield a value right
 * now, or the mint is refused. An artifact whose targets were never once proven
 * usable is a promise, not a recording.
 *
 * ── LITERALS ARE RECORDED; SYMBOLS ARE DERIVED LATER ────────────────────────
 *
 * A strategy key here is the LITERAL the DOM reported — label `"CARD (LAST 4)"`,
 * field `MBRNO` — and the compiler translates it through the tenant binding.
 * This used to symbolise the anchor at mint time, and the two halves then
 * disagreed: `toSymbol("CARD (LAST 4)")` is `CARD_LAST_4`, the binding's label
 * table holds the literal `"CARD (LAST 4)"`, so the reverse lookup missed and the
 * compiled artifact carried a symbol no binding defines — it parsed cleanly and
 * threw `UnboundSymbol` at `resolve()`. The committed lookup artifact worked only
 * because `toSymbol("MEMBER ID")` happens to equal the binding's own symbol name.
 * DECISIONS.md already commits to this layering: the surface speaks literals, and
 * the binding translates at exactly two boundaries — `resolve()` and the compiler.
 *
 * The descriptor's `id` is still a SYMBOL here, because the schema requires one:
 * it is derived from the first strategy's literal and then re-derived by the
 * compiler from the canonicalised key, which is the value that survives.
 */
import type { TargetDescriptor } from "../capability/schema.js";
import { riskFor, type RiskProfile } from "../compile/risk-profile.js";
import { dataRowCount } from "../replay/predicate.js";
import { hasPiiShape } from "../safety/redact.js";
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
  /**
   * For `dialog`: what the dialog SAID and how the run answered it.
   *
   * The message is measured from the surface, not taken from the model's belief,
   * because the compiler turns this entry into a `plan.recovery[]` rule whose
   * trigger is that text. An entry recording only the model's stated reason left
   * the compiler nothing to compile, and an executed dismissal vanished.
   */
  readonly dialog?: { readonly message: string; readonly answer: "accept" | "dismiss" };
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
  /**
   * What acting on each screen carries. REQUIRED, and the same document the
   * compiler rates the recorded steps with.
   *
   * Discovery is the phase acting WITHOUT a recorded plan, so an unrated screen
   * is refused here rather than acted on at the least conservative label — which
   * is what `risk: "read_only"` hardcoded at this call site used to do.
   */
  readonly riskProfile: RiskProfile;
}

/** Where in the run this call sits, and which artifact step it will become. */
export interface StepPosition {
  /** Position in the trace, counting every recorded tool call. */
  readonly index: number;
  /**
   * The `plan.steps[].ref` this call will carry IF it becomes a step.
   *
   * Supplied by the caller rather than derived from `index`, because the two
   * sequences differ: a `dialog` entry is recorded in the trace and compiled into
   * a recovery rule, not a step. Numbering the evidence from the trace while the
   * compiler numbered the filtered step list is what made every `stepRef` after a
   * dialog cite the wrong artifact step — on the event arm `events.ts` sells as a
   * citation a reviewer can open and check.
   */
  readonly stepRef: string;
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

export class MintFailure extends Error {
  constructor(
    readonly ref: string,
    readonly why: string,
  ) {
    super(`cannot record a durable target for ref ${ref}: ${why}`);
    this.name = "MintFailure";
  }
}

/** What minting needs beyond the element's own facts. */
export interface MintContext {
  /** Canonical screen SYMBOL. Never null: an unrecognised screen is refused before this. */
  readonly screen: string;
  /** The ref this was minted from — named in a failure so the model knows which control to drop. */
  readonly ref: string;
  /** The model's `why_stable`, recorded as an attributed belief. */
  readonly belief: string;
  /** The whole visible text of the screen, for the PII flag below. */
  readonly screenText: string;
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
export const mint = (facts: TargetFacts, ctx: MintContext): TargetDescriptor => {
  const strategies: TargetDescriptor["strategies"] = [];

  // The LITERALS, as the DOM reported them. The compiler canonicalises these
  // against the tenant binding; symbolising here would be translating without
  // the table that defines the translation.
  if (facts.anchorText) strategies.push({ kind: "table_anchor", key: facts.anchorText, matchedAtRecord: 1 });
  if (facts.fieldName) strategies.push({ kind: "field_key", key: facts.fieldName, matchedAtRecord: 1 });

  if (strategies.length === 0) {
    // Deliberately no fallback to the ref or to coordinates. If nothing durable
    // was found, the honest outcome is refusing to record — a target that cannot
    // be described is a target that cannot be replayed.
    throw new MintFailure(ctx.ref, "no anchor text and no field name; nothing durable to record");
  }

  // `id` must satisfy the schema's Symbolic pattern even before the compiler
  // rewrites it, so it is derived from whichever literal can produce one.
  const id = toSymbol(strategies[0]?.key ?? "") ?? toSymbol(facts.fieldName ?? "") ?? null;
  if (id === null) {
    throw new MintFailure(ctx.ref, `neither "${facts.anchorText ?? ""}" nor "${facts.fieldName ?? ""}" yields a usable symbol`);
  }

  return {
    id,
    screen: ctx.screen,
    framePath: facts.framePath.length > 0 ? facts.framePath.map((name) => ({ name })) : [{ index: 0 }],
    strategies,
    /**
     * The role the SURFACE reported, never one re-derived here from the tag.
     *
     * The tag map this replaced answered `textbox` for every `<input>`, so the
     * mock's `<input type="image">` submit was recorded as a textbox and the
     * verify gate — which re-derived from that same tag — could not reject any
     * input at all.
     *
     * MEASURED against the live mock, 30 of 30 described controls: this surface
     * reports a role for every one of them, because `PlaywrightSurface.factsOf`
     * COMPUTES one from tag and type when the markup declares none. So compiled
     * targets do carry a role — `textbox` for the member-id input, `button` for
     * the image submit, `generic` for a label-cell anchor — and replay checks it
     * against a role computed by that same function. `generic` is the weak end of
     * that: it separates a cell from a control and nothing finer.
     *
     * The `{}` branch is for a Surface that reports no role at all. It is not
     * what this one does.
     */
    verify: facts.role ? { role: facts.role } : {},
    /**
     * A SCREEN-LEVEL observation, and the comment has to say so because that is
     * all the evidence supports: the screen this control was recorded on renders
     * text carrying a PII shape (a full PAN or SSN). It does NOT say this
     * element's own accessible name contains PII — nothing here reads the
     * element's name. Replay uses the flag to pick which regions to black out of
     * an escalation screenshot, where over-masking costs a reviewer some context
     * and under-masking leaks a card number.
     */
    nameMayContainPii: hasPiiShape(ctx.screenText),
    // Attributed, so a reviewer can see which parts of an artifact are a model's
    // claim and which are measured.
    robustness: `Model's stated reason: "${ctx.belief}". Anchors recorded from the live element: ${facts.anchorText ? `label "${facts.anchorText}"` : "no label"}, ${facts.fieldName ? `field "${facts.fieldName}"` : "no field name"}.`,
  };
};

/**
 * Which recorded tool call becomes an ordered step, and what verb it becomes.
 *
 * ONE rule with two readers — the loop, which cites a step ref in the evidence,
 * and the compiler, which emits the step. They used to filter and number
 * separately, so every citation after a `dialog` entry pointed at the wrong step.
 */
export const STEP_ACTION: Readonly<Record<string, "fill" | "click" | "read">> = {
  type_text: "fill",
  click: "click",
  read: "read",
};

export const isStepEntry = (entry: TraceEntry): boolean =>
  entry.target !== undefined && STEP_ACTION[entry.tool] !== undefined;

export const stepRefOf = (nth: number): string => `s${String(nth).padStart(2, "0")}`;

/**
 * Execute one validated tool call.
 *
 * EVERY surface call sits inside the guarded region. A `SurfaceRefused` — from
 * the allowlist or from the control lease — is information for the model, not a
 * crash: it is handed back as a tool result so the run can try another route.
 * The dialog branch used to act OUTSIDE that region, so a policy refusal on
 * `accept_dialog` (which no shipped policy permits) killed the one run the brief
 * requires to be genuine, while the identical refusal on `click` was recoverable.
 */
export const execute = async (
  position: StepPosition,
  toolName: string,
  rawArgs: Readonly<Record<string, unknown>>,
  deps: DiscoverDeps,
): Promise<ToolOutcome> => {
  const parsed = parseToolArgs(toolName, rawArgs);
  if (!parsed.ok) return { kind: "error", message: parsed.error };

  const { name, args } = parsed;

  if (name === "finish" || name === "stuck") {
    const detail = name === "finish" ? `${String(args["summary"])} (checkpoint: ${String(args["checkpoint"])})` : String(args["reason"]);
    return { kind: "terminal", tool: name, detail };
  }

  try {
    return await perform(position, name, args, deps);
  } catch (e) {
    if (e instanceof SurfaceRefused) return { kind: "error", message: `refused: ${e.message}` };
    if (e instanceof MintFailure) return { kind: "error", message: e.message };
    throw e;
  }
};

const perform = async (
  position: StepPosition,
  name: Exclude<ToolName, "finish" | "stuck">,
  args: Readonly<Record<string, unknown>>,
  deps: DiscoverDeps,
): Promise<ToolOutcome> => {
  const { surface, actor, epoch, riskProfile } = deps;
  const before = await surface.observe();

  if (name === "observe") {
    return { kind: "observed", observation: before };
  }

  if (name === "dialog") {
    if (!before.dialog) return { kind: "error", message: "no dialog is currently blocking the page" };
    const answer = args["action"] === "accept" ? "accept" : "dismiss";

    /**
     * Dismissing cancels, so it can commit nothing; accepting can commit whatever
     * the dialog was confirming, and therefore carries the screen's own risk. An
     * unrated screen refuses rather than defaulting — the same rule the acting
     * tools follow below.
     */
    const risk = answer === "accept" ? riskFor(riskProfile, before.screen, null) : "read_only";
    if (risk === null) {
      return {
        kind: "error",
        message: `cannot establish the risk of ACCEPTING a dialog on screen ${before.screen ?? "(unrecognised)"}; dismiss it instead, or the screen needs rating in the risk profile`,
      };
    }

    const action: SurfaceAction = answer === "accept" ? { kind: "accept_dialog" } : { kind: "dismiss_dialog" };
    // stepRef null: this call is recorded in the trace and compiled into a
    // recovery rule, not into an ordered step, so it has no step to cite.
    await surface.act(action, { stepRef: null, risk, actor: actor(), epoch: epoch(), url: before.location, screen: before.screen });
    const after = await surface.observe();
    return {
      kind: "acted",
      entry: {
        index: position.index,
        tool: name,
        screenBefore: before.screen,
        screenAfter: after.screen,
        rowsAfter: dataRowCount(after),
        dialog: { message: before.dialog.message, answer },
        modelBelief: String(args["reason"]),
      },
      observation: after,
    };
  }

  // ---- the acting tools: mint, prove, then act -------------------------------
  const ref = String(args["ref"]);
  const claimedScreen = String(args["screen_id"]);
  const belief = String(args["why_stable"]);

  /**
   * An unrecognised screen cannot carry a recording. `BoundSurface` returns null
   * for a screen this tenant's binding does not name, and minting on it used to
   * fabricate the symbol `UNKNOWN_SCREEN`: the artifact parsed cleanly and threw
   * `UnboundSymbol` the moment anyone tried to load it. Reachable on the shipped
   * app through SYS0500, the abend screen. Refusing hands the model something it
   * can act on instead.
   */
  if (before.screen === null) {
    return {
      kind: "error",
      message:
        "the surface is showing a screen this tenant's binding does not name, so no durable target can be recorded here; " +
        "navigate back to a known screen before acting",
    };
  }

  // A cheap drift check: if the model's mental model has diverged from the
  // surface, acting on it would corrupt the recording.
  if (claimedScreen !== before.screen) {
    return {
      kind: "error",
      message: `you said you are on ${claimedScreen} but the surface is showing ${before.screen}; observe again before acting`,
    };
  }

  const facts = await surface.describe(ref);
  if (!facts) return { kind: "error", message: `ref ${ref} no longer resolves; observe again to get current refs` };

  const target = mint(facts, { screen: before.screen, ref, belief, screenText: before.text });

  if (name === "read") {
    /**
     * A read is PROVEN BY READING IT, not by `find()`.
     *
     * `locate()` matches only `input, select, textarea, a, button`, so verifying a
     * read target with `find()` refused every value that is not a control — and a
     * confirmation number is static text. That made §3.2's typed outputs
     * hand-authorable but not discoverable: the one value the flagship capability
     * returns was exactly the one discovery could not capture. `surface.read()`
     * covers both paths, and a value coming back IS the proof the target resolves.
     */
    const value = await surface.read(target);
    if (value === null) {
      return { kind: "error", message: `nothing readable at ref ${ref}; the durable target minted for it yielded no value` };
    }
    const after = await surface.observe();
    return {
      kind: "acted",
      entry: {
        index: position.index,
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

  // Prove it before recording it.
  const resolution = await surface.find(target).catch(() => null);
  if (!resolution) {
    return { kind: "error", message: `the durable target minted for ref ${ref} did not resolve; pick a control with a label or a field name` };
  }

  /**
   * The risk this action carries, ESTABLISHED rather than assumed.
   *
   * Keyed on the canonical screen and on the MINTED id. The minted id equals the
   * canonical symbol only when the tenant's own label canonicalises to it — true
   * for tenant A's `OVERRIDE CODE`, false for tenant B's `SUPERVISOR CODE` —
   * because discovery holds no binding, by the same layering rule that keeps
   * symbols out of the surface. The screen's rating is the floor in every case,
   * and the compiler, which does hold the binding, applies control overrides
   * authoritatively when the step is recorded.
   */
  const risk = riskFor(riskProfile, before.screen, target.id);
  if (risk === null) {
    return {
      kind: "error",
      message: `screen ${before.screen} is not rated in the risk profile, so I cannot establish what acting on it may commit; this screen has to be profiled before it can be recorded`,
    };
  }

  const ctx: ActionContext = {
    stepRef: position.stepRef,
    risk,
    actor: actor(),
    epoch: epoch(),
    url: before.location,
    screen: before.screen,
    ...(name === "type_text" ? { field: target.id } : {}),
  };

  const action: SurfaceAction =
    name === "type_text" ? { kind: "fill", target, value: String(args["text"]) } : { kind: "click", target };

  await surface.act(action, ctx);
  const after = await surface.observe();

  return {
    kind: "acted",
    entry: {
      index: position.index,
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
};
