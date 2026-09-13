/**
 * THE BINDING LAYER — where one artifact meets many tenants.
 *
 * The artifact is deliberately tenant-free: its plan names `MEMBER_SEARCH` and
 * `MEMBER_ID`, never `MBR0300` and `MBRNO`. That is what makes §3.7-c possible —
 * hundreds of institutions run the same vendor product with different screen
 * ids, field names and labels, and re-recording the flow per tenant would be the
 * thing this system exists to avoid.
 *
 * A binding is the small, reviewable file that supplies the literals. It
 * translates in BOTH directions, and both are needed:
 *
 *   resolve()          symbol -> literal, so a recorded plan can be executed
 *                      against a particular tenant's markup.
 *   canonicalScreen()  literal -> symbol, because the surface reports the screen
 *                      id it can actually see ("MBR0300"), while every predicate
 *                      in the artifact asserts a symbol. Without this direction
 *                      the artifact and the surface simply cannot meet.
 *
 * The failure mode is the interesting part. A symbol the binding does not define
 * raises `UnboundSymbol` — loudly, naming the key. That is the mechanism behind
 * §3.7-d: variation a binding CAN express is configuration, and anything it
 * cannot is drift, surfaced rather than silently absorbed.
 */
import { z } from "zod";
import type { Capability, Predicate, TargetDescriptor } from "./schema.js";

export const Binding = z.object({
  tenant: z.string().min(1),
  /** The app version this binding was written against, for drift attribution. */
  appVersion: z.string().min(1),
  /**
   * The two frames this product renders, by the ROLE each plays. A recorded
   * target's frame hop names the role — `content` or `nav` — and `resolveTarget`
   * turns it into this tenant's own frame name.
   */
  frames: z.object({ content: z.string().min(1), nav: z.string().min(1) }),
  /** SYMBOL -> the screen id this tenant renders. */
  screens: z.record(z.string(), z.string()),
  /** SYMBOL -> the form field name in this tenant's markup. */
  fields: z.record(z.string(), z.string()),
  /** SYMBOL -> the visible label text the structural anchor keys on. */
  labels: z.record(z.string(), z.string()),
});

export type Binding = z.infer<typeof Binding>;

/**
 * The two frame roles an artifact may name.
 *
 * A closed pair rather than an open table, and the limit is worth stating: this
 * product renders exactly two frames, so a recorded path is one hop deep and a
 * role is enough to identify it. A surface with NESTED framesets would need a
 * path of roles, and neither this function nor `PlaywrightSurface.resolveFrame`'s
 * single-hop walk would be sufficient.
 */
export type FrameRole = "content" | "nav";

/**
 * A binding must be reversible, so duplicate literals are refused.
 *
 * Translation runs in BOTH directions: symbol to literal when resolving a plan,
 * and literal to symbol when minting a target from what a surface reported. The
 * second direction is only well-defined if no two symbols share a literal — if
 * `MEMBER_ID` and `ACCOUNT_ID` both mapped to `MBRNO`, minting would have to
 * guess, and a guess in a recorded artifact is a defect that only shows up on
 * some other tenant months later.
 *
 * Making the collision unrepresentable is cheaper than handling it.
 */
/**
 * ── THE COST OF FLAT TABLES, STATED RATHER THAN DESIGNED AROUND ─────────────
 *
 * `fields` and `labels` are global to a tenant, so a symbol means one literal
 * everywhere in the product. A tenant whose search screen and card screen each
 * carry a control named `SUBMIT` cannot be RECORDED: the second one collides with
 * the first under the reversibility rule below, and there is no per-screen
 * namespace to separate them. The `fcu` fixture designs around this by giving the
 * card screen's submit its own name (`APPLY`), which is a property of the mock
 * rather than a solution.
 *
 * The fix is a per-screen override layer — `screens[MEMBER_SEARCH].fields.SUBMIT`
 * shadowing the global — and it is NOT built. It would also be where per-tenant
 * drift patches live, so it is the same piece of work in both directions.
 */
export const BindingChecked = Binding.superRefine((binding, ctx) => {
  for (const table of ["screens", "fields", "labels"] as const) {
    const seen = new Map<string, string>();
    for (const [symbol, literal] of Object.entries(binding[table])) {
      const first = seen.get(literal);
      if (first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [table, symbol],
          message: `"${literal}" is already used by ${first}; a binding must be reversible, so two symbols cannot share one literal`,
        });
      }
      seen.set(literal, symbol);
    }
  }
});

export const parseBinding = (raw: unknown): Binding => BindingChecked.parse(raw);

export class UnboundSymbol extends Error {
  constructor(
    readonly kind: "screen" | "field" | "label" | "frame",
    readonly symbol: string,
    readonly tenant: string,
  ) {
    super(
      `binding "${tenant}" does not define ${kind} symbol "${symbol}" — this is drift, not configuration: ` +
        `the recorded plan needs something this tenant's binding cannot express.`,
    );
    this.name = "UnboundSymbol";
  }
}

const need = (
  table: Readonly<Record<string, string>>,
  kind: "screen" | "field" | "label" | "frame",
  symbol: string,
  tenant: string,
): string => {
  const literal = table[symbol];
  if (literal === undefined) throw new UnboundSymbol(kind, symbol, tenant);
  return literal;
};

/** The surface reports what it sees; predicates assert symbols. This closes the gap. */
export const canonicalScreen = (binding: Binding, literal: string | null): string | null => {
  if (literal === null) return null;
  for (const [symbol, value] of Object.entries(binding.screens)) {
    if (value === literal) return symbol;
  }
  // An unrecognised screen is not an error here — classification decides what an
  // unexpected screen means, and it has far more context than this function does.
  return null;
};

/** Reverse lookup in one table. Unambiguous because `BindingChecked` forbids collisions. */
const canonical = (table: Readonly<Record<string, string>>, literal: string | null): string | null => {
  if (literal === null || literal === "") return null;
  for (const [symbol, value] of Object.entries(table)) {
    if (value === literal) return symbol;
  }
  return null;
};

/**
 * The app's own field name, as a symbol.
 *
 * Minting sees what the DOM reports — `MBRNO` — while every consumer of an
 * artifact speaks symbols. Without this, a compiled artifact is welded to one
 * tenant's field names and `resolve()` rejects it as drift on any other, which
 * is precisely what the first round-trip run produced.
 */
export const canonicalField = (binding: Binding, literal: string | null): string | null =>
  canonical(binding.fields, literal);

/** The visible label beside a control, as a symbol. */
export const canonicalLabel = (binding: Binding, literal: string | null): string | null =>
  canonical(binding.labels, literal);

/**
 * The frame a control was found in, as the ROLE it plays for this tenant.
 *
 * Minting records the frame's own name — `content` on tenant A, `main` on tenant
 * B — and an artifact must not carry either. `null` for anything this binding
 * does not name, which the compiler treats as drift rather than passing through.
 */
export const canonicalFrame = (binding: Binding, literal: string | null): FrameRole | null => {
  if (literal === null) return null;
  if (literal === binding.frames.content) return "content";
  if (literal === binding.frames.nav) return "nav";
  return null;
};

/**
 * A recorded frame role, as this tenant's own frame name.
 *
 * Every named hop used to be rewritten to `frames.content` unconditionally, so
 * `frames.nav` — a REQUIRED field of the schema above — had no reader anywhere in
 * `src`, and a target recorded in the navigation frame resolved against the
 * content frame with no error at all. On this surface that is not hypothetical:
 * the nav frame carries a quick-lookup box using the SAME field name as the
 * member-id field, which is the collision the frame hop exists to break.
 */
const frameLiteral = (binding: Binding, role: string): string => {
  if (role === "content") return binding.frames.content;
  if (role === "nav") return binding.frames.nav;
  throw new UnboundSymbol("frame", role, binding.tenant);
};

/**
 * Rewrite a recorded target for one tenant: its frame path, its screen
 * assertion, and each strategy's key.
 *
 * Which table a strategy's key comes from depends on the strategy, and that
 * mapping is the whole point of the ordering: a structural anchor keys on the
 * VISIBLE LABEL, while a field key keys on the app's own form-field NAME. The
 * same target therefore needs two different literals from two different tables.
 */
export const resolveTarget = (target: TargetDescriptor, binding: Binding): TargetDescriptor => ({
  ...target,
  screen: need(binding.screens, "screen", target.screen, binding.tenant),
  framePath: target.framePath.map((hop) => (hop.name === undefined ? hop : { ...hop, name: frameLiteral(binding, hop.name) })),
  strategies: target.strategies.map((s) => ({
    ...s,
    key:
      s.kind === "table_anchor"
        ? need(binding.labels, "label", s.key, binding.tenant)
        : s.kind === "field_key"
          ? need(binding.fields, "field", s.key, binding.tenant)
          : s.key,
  })),
});

export interface ResolvedPlan {
  readonly targets: readonly TargetDescriptor[];
  readonly screens: ReadonlyMap<string, string>;
}

/** Every screen symbol a predicate asserts, so binding gaps surface at load time. */
const screensAssertedBy = (predicate: Predicate, into: Set<string>): void => {
  for (const atom of [...predicate.all, ...predicate.any]) {
    // Narrowed by the discriminant — no cast needed, which is the payoff for
    // keeping the atom vocabulary a closed union.
    if (atom.atom === "screen") into.add(atom.is);
  }
};

/**
 * Resolve a whole capability against a binding, failing fast on the first symbol
 * the tenant cannot supply.
 *
 * Note what is NOT rewritten: the steps, the predicates and the contract. Those
 * speak symbols and keep speaking symbols — only the targets need literals,
 * because only the targets touch markup. Keeping the rewrite that narrow is what
 * makes a binding a ~30-line file rather than a second copy of the artifact.
 */
export const resolve = (capability: Capability, binding: Binding): ResolvedPlan => {
  const targets = capability.plan.targets.map((t) => resolveTarget(t, binding));
  const screens = new Map<string, string>();
  for (const [symbol, literal] of Object.entries(binding.screens)) screens.set(symbol, literal);

  // Every screen a predicate asserts must be bound, or the run would fail
  // mid-flight on a screen check rather than at load time.
  const asserted = new Set<string>();
  for (const step of capability.plan.steps) {
    screensAssertedBy(step.pre, asserted);
    screensAssertedBy(step.post, asserted);
  }
  screensAssertedBy(capability.plan.checkpoint, asserted);
  for (const outcome of capability.contract.outcomes) screensAssertedBy(outcome.when, asserted);

  for (const symbol of asserted) need(binding.screens, "screen", symbol, binding.tenant);

  return { targets, screens };
};
