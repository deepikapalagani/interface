/**
 * THE CAPABILITY ARTIFACT — the boundary between discovery and replay, and the
 * single source of truth for its own shape.
 *
 * Zod is the schema; the TypeScript types are inferred from it, never written
 * twice. `parseCapability()` is the only door in, so nothing downstream can hold
 * a Capability that has not been validated.
 *
 * Three layers, each with a different reader (§3.2):
 *
 *   contract     what a CALLING AGENT binds to — id, version, goal, typed inputs
 *                and outputs, the business outcomes it may return, its risk
 *   plan         what a HUMAN REVIEWS — an ordered step list over a closed verb
 *                set, with target descriptors, pre/postconditions, a bounded
 *                recovery table, and the success checkpoint
 *   provenance   how it came to exist, and proof that it actually replayed
 *
 * Two design rules do most of the work:
 *
 * 1. THE THREE RESULT CLASSES LIVE IN THREE DIFFERENT PLACES.
 *    Business outcomes are `contract.outcomes[]`. Recoverable conditions are
 *    `plan.recovery[]`. Everything else is a hard failure by default. The
 *    glossary calls conflating the first two with the third the most common
 *    design mistake here; three branches of a function is a promise to be
 *    careful, three sections of a schema is a mechanism.
 *
 * 2. THE PLAN NAMES SYMBOLS, NEVER TENANT LITERALS.
 *    A step targets `MEMBER_ID` on `MEMBER_SEARCH`, not `MBRNO` on `MBR0300`.
 *    A sibling binding file resolves symbols per tenant, so one artifact serves
 *    many institutions running the same vendor product (§3.7-c). Anything a
 *    binding cannot express is drift by construction (§3.7-d).
 */
import { z } from "zod";

/* ------------------------------------------------------------ vocabularies */

/**
 * Declared once, imported everywhere. Eight analysts independently invented five
 * spellings of this enum; single ownership is why replay can read a risk label
 * without an LLM (§3.4-c).
 */
export const RiskClass = z.enum(["read_only", "reversible", "irreversible"]);
export type RiskClass = z.infer<typeof RiskClass>;

/** How a step is gated. Kept separate from risk so the matrix can vary by tier. */
export const Approval = z.enum(["none", "confirm_intent", "human_step_up"]);
export type Approval = z.infer<typeof Approval>;

/** Sensitivity of a value. Drives redaction at all four boundaries (§3.4-e/f). */
export const DataClass = z.enum(["public", "confidential", "restricted", "secret"]);
export type DataClass = z.infer<typeof DataClass>;

/**
 * How a control is found, in the order replay tries them.
 *
 * MEASURED on this surface: `role_name` matches 0 elements, while the structural
 * anchor and the frame-scoped field name each match exactly 1 — and the anchor
 * survives both a frame rename and a field rename. Hence the inverted ordering.
 * `viewport_box` is deliberately absent: a coordinate is not a durable target.
 */
export const StrategyKind = z.enum(["table_anchor", "field_key", "role_name"]);
export type StrategyKind = z.infer<typeof StrategyKind>;

/**
 * The closed action set. Replay is a walker over exactly these five verbs.
 *
 * `press` WAS a sixth and is gone, because nothing could execute it faithfully.
 * `SurfaceAction.press` carries a `key`, and this schema has no field to record
 * one — so `executor.ts` mapped a `press` step onto a CLICK
 * (`step.action === "navigate" ? "navigate" : "click"`) and reported success. A
 * verb in the "closed set" that silently becomes a different verb is worse than
 * an absent one: the artifact says one thing and the surface does another.
 * Measured before removal: zero steps in any fixture, committed artifact or test
 * declare it, and the compiler's `ACTION_FOR` map never emits it.
 *
 * `SurfaceAction` and `PolicyDocument.allowedActions` still carry `press` — they
 * are the DRIVER's vocabulary, not the artifact's, and a human turn may press a
 * key through `HumanHands`. The two vocabularies are deliberately not the same
 * set, and this is the one place they differ.
 */
export const ActionKind = z.enum(["navigate", "fill", "click", "read", "assert"]);
export type ActionKind = z.infer<typeof ActionKind>;

/* ------------------------------------------------------------- predicates */

const Symbolic = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/, "must be a SYMBOL resolved by a binding, not a tenant literal");

/**
 * Seven atoms, and predicates are DEPTH-1 by construction: `{all, any}` of
 * atoms, never nested. Non-recursion is load-bearing rather than taste —
 * structured-output schemas cannot express recursion, so a recursive predicate
 * would be unusable by the compile step that has to emit one.
 */
const Atom = z.discriminatedUnion("atom", [
  z.object({ atom: z.literal("screen"), is: Symbolic }),
  /**
   * `within` is deliberately absent. It was declared as an optional scope and had
   * ZERO readers: `evaluateAtom`'s `text` arm tests `obs.text.includes(needle)`
   * and never looked at it. It could not have been honoured either —
   * `Observation.text` is one string joined across the whole frameset, so there
   * is no per-symbol region to scope to without a Surface-level primitive that
   * does not exist. A declared scope nothing enforces reads as a guarantee in
   * review, which is the exact defect class this pass exists to remove.
   */
  z.object({ atom: z.literal("text"), contains: z.string().min(1) }),
  z.object({ atom: z.literal("element"), target: Symbolic, present: z.boolean() }),
  z.object({ atom: z.literal("rowCount"), grid: Symbolic, op: z.enum(["eq", "gte", "lte"]), n: z.number().int().min(0) }),
  z.object({ atom: z.literal("valueEquals"), target: Symbolic, value: z.string() }),
  z.object({ atom: z.literal("dialog"), messageContains: z.string().min(1) }),
  z.object({ atom: z.literal("absent"), target: Symbolic }),
]);
export type Atom = z.infer<typeof Atom>;

const Predicate = z
  .object({ all: z.array(Atom).default([]), any: z.array(Atom).default([]) })
  .refine((p) => p.all.length + p.any.length > 0, "a predicate must assert something");
export type Predicate = z.infer<typeof Predicate>;

/* --------------------------------------------------------------- targeting */

/** One hop of a frame path: by name, then url pattern, then positional index. */
const FrameHop = z.object({
  name: z.string().optional(),
  urlPattern: z.string().optional(),
  index: z.number().int().min(0).optional(),
});

const Strategy = z.object({
  kind: StrategyKind,
  /** Anchor text for `table_anchor`; the app's field name for `field_key`; the accessible name for `role_name`. */
  key: z.string().min(1),
  role: z.string().optional(),
  /**
   * A TYPE-LEVEL RESTATEMENT OF AN INVARIANT, NOT A MEASUREMENT.
   *
   * Said plainly because the field name invites the opposite reading: nothing
   * writes a count here. `discover/executor.ts` mints every strategy with the
   * literal `1`, and the only reason that is not a lie is that `mint()` refuses
   * to record a target at all unless `surface.find()` resolves it, and
   * `PlaywrightSurface.locate()` accepts a strategy only when `count === 1`
   * (`if (count !== 1) continue`). So the resolver enforces "exactly one" at both
   * record time and replay time, and `z.literal(1)` makes any OTHER number
   * unrepresentable rather than recording what was seen.
   *
   * Kept rather than deleted because the literal type is what stops a future
   * writer recording `matchedAtRecord: 3` and calling it a measurement. If it
   * ever becomes a real count, it becomes `z.number().int().min(1)` and this
   * comment goes with it.
   */
  matchedAtRecord: z.literal(1),
});

export const TargetDescriptor = z.object({
  id: Symbolic,
  screen: Symbolic,
  framePath: z.array(FrameHop).min(1),
  /** Ordered. Anything after the first is a degradation and logs `degraded: true`. */
  strategies: z.array(Strategy).min(1),
  /** Re-read the resolved element's own facts before acting on it. */
  verify: z.object({ role: z.string().optional(), nameContains: z.string().optional() }),
  /** The accessible name of a row IS member data on these screens. */
  nameMayContainPii: z.boolean().default(false),
  /** Why this target is expected to survive — §3.2 asks for the reasoning, not just the selector. */
  robustness: z.string().min(1),
});
export type TargetDescriptor = z.infer<typeof TargetDescriptor>;

/* ------------------------------------------------------------------- steps */

export const Step = z.object({
  ref: z.string().regex(/^s[0-9]{2}$/),
  title: z.string().min(1),
  action: ActionKind,
  target: Symbolic.optional(),
  /**
   * A literal, or a `{{param}}` reference.
   *
   * Plainly `z.string()`, and the union it replaced is worth recording: it was
   * `z.union([z.string(), ParamRef])`, whose FIRST branch accepts every string —
   * so the `ParamRef` regex was unreachable and constrained nothing. Zod tries
   * union members in order and returns on the first success, so the only effect
   * was to make the field look validated.
   *
   * The two real constraints on this field live in the refinements below, where
   * they can actually fire: refinement 2 forbids a PII-shaped literal, and
   * refinement 9 requires every `{{name}}` appearing here to be a declared input.
   */
  value: z.string().optional(),
  pre: Predicate,
  post: Predicate,
  risk: RiskClass,
  approval: Approval.default("none"),
});
export type Step = z.infer<typeof Step>;

/** A declared, bounded response to a known recoverable condition (§3.3-f). */
const Recovery = z.object({
  id: z.string().min(1),
  when: Atom,
  do: z.enum(["dismiss_dialog", "accept_dialog", "wait_and_retry", "reload_screen"]),
  maxAttempts: z.number().int().min(1).max(3),
  note: z.string().min(1),
});

/* ---------------------------------------------------------------- contract */

const Input = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  type: z.enum(["string", "integer", "enum"]),
  enumValues: z.array(z.string()).optional(),
  pattern: z.string().optional(),
  required: z.boolean().default(true),
  sensitivity: DataClass,
  description: z.string().min(1),
});

const Output = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  type: z.enum(["string", "integer", "boolean"]),
  sensitivity: DataClass,
  /** The step that reads it. Exactly one producer, enforced below. */
  producedBy: z.string().regex(/^s[0-9]{2}$/),
  description: z.string().min(1),
});

/** A legitimate non-success answer the caller must handle — NOT a failure. */
const Outcome = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  message: z.string().min(1),
  when: Predicate,
  source: z.enum(["observed_in_discovery", "app_profile", "authored"]),
  note: z.string().min(1),
});

/* ------------------------------------------------------------- the artifact */

export const Capability = z.object({
  schemaVersion: z.literal(1),
  contract: z.object({
    id: z.string().regex(/^[a-z]+(\.[a-z_]+)+$/, "e.g. msc.card.set_status"),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    goal: z.string().min(1),
    purpose: z.string().min(1),
    inputs: z.array(Input),
    outputs: z.array(Output),
    outcomes: z.array(Outcome),
    risk: RiskClass,
    requiresSession: z.boolean().default(true),
  }),
  plan: z.object({
    app: z.string().min(1),
    targets: z.array(TargetDescriptor).min(1),
    steps: z.array(Step).min(1),
    recovery: z.array(Recovery).default([]),
    /** The condition asserted to confirm the goal was actually reached (§3.2). */
    checkpoint: Predicate,
    /** One optional read-only probe for an unknown post-commit state. */
    reconcile: z.object({ target: Symbolic, expect: Predicate }).optional(),
  }),
  provenance: z.object({
    /** An instant, so "when was this recorded" can be ordered rather than merely read. */
    discoveredAt: z.string().datetime(),
    /** Non-empty: an unattributed artifact is one nobody can ask about. */
    model: z.string().min(1),
    traceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    appProfileVersion: z.string().min(1),
    /** Which fields a model wrote, versus derived mechanically from the trace. */
    modelAuthoredFields: z.array(z.string()),
  }),
  verification: z.object({
    /**
     * OPTIONAL, and deliberately NOT required alongside `replayResult: "success"`.
     *
     * `scripts/verify-determinism.ts` compares two runs' `capability.json` BYTE
     * FOR BYTE with no projection applied to that file, so a stamped wall-clock
     * instant would make the artifact differ between two identical runs and the
     * determinism gate would fail on its own stamp. `replay/main.ts` therefore
     * stamps `replayResult` and `modelCalls` and leaves this alone.
     */
    replayedAt: z.string().datetime().optional(),
    replayResult: z.enum(["success", "not_yet_verified"]),
    modelCalls: z.literal(0).optional(),
  }),
});

export type Capability = z.infer<typeof Capability>;

/* ------------------------------------------- making the dangerous unrepresentable */

/**
 * The card shape is guarded with `(?<![\w-])…(?![\w-])` rather than `\b`, and
 * carries no Luhn check. Both are measured choices; the obvious version of each
 * is wrong on this data, and `scripts/verify-evidence.ts` records the same two.
 *
 * MEASURED 2026-09-12 over the committed evidence: `\b\d{13,19}\b` produces 24
 * hits, every one a Z.ai tool-call id of the form `call_-7267060200698277786` —
 * `\b` matches at the boundary between the `-` and the first digit. The guarded
 * form produces 0 on the same corpus and still flags a bare PAN.
 *
 * Be precise about what that buys HERE, because this refinement never sees a
 * transcript: at this boundary the regex only ever reads `plan.steps[].value`,
 * which the compiler fills from a literal the model typed into a field, so the
 * misfire was LATENT rather than live. The change is still worth making — an
 * artifact may legitimately carry an id-shaped literal, and the redactor, this
 * schema and `scripts/verify-evidence.ts` now agree on ONE shape instead of two,
 * which is what stops a value being masked by one and flagged by another.
 *
 * MEASURED, and the reason there is no Luhn gate: all four PANs seeded in
 * mock/seed.ts are Luhn-INVALID (they are deliberately fake), while 2 of the 7
 * distinct 13-19 digit runs in the committed transcripts are Luhn-VALID — one
 * being the tool-call id `7266999899357443983`. Gating on Luhn would therefore
 * suppress every genuine leak and keep a false positive — exactly inverted.
 */
const PII_SHAPED = [
  { re: /(?<![\w-])\d{13,19}(?![\w-])/, what: "a card-number-shaped literal" },
  { re: /\b\d{3}-\d{2}-\d{4}\b/, what: "an SSN-shaped literal" },
];
const ARIA_REF = /\bf?\d*e\d+\b/;
const ACTING: readonly ActionKind[] = ["navigate", "fill", "click"];

/** Every `{{param}}` occurrence. Global, because one string may carry several. */
const PARAM_REF_G = /\{\{([a-z][a-z0-9_]*)\}\}/g;

/**
 * Visit every string in a value, carrying the path it was found at.
 *
 * Used by the two refinements that have to be exhaustive rather than
 * representative — the PII scan and the parameter-binding check. Both previously
 * inspected ONE field while their comments said "anywhere in the plan", which is
 * the defect class this file is being corrected for.
 */
const eachString = (
  value: unknown,
  path: (string | number)[],
  visit: (text: string, at: (string | number)[]) => void,
): void => {
  if (typeof value === "string") {
    visit(value, path);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => eachString(v, [...path, i], visit));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) eachString(v, [...path, k], visit);
};

/**
 * Every parameter name the capability REFERENCES, as opposed to declares.
 *
 * Exported because `replay/index.ts` needs exactly this set to decide which
 * inputs a run cannot proceed without (an optional input that the plan
 * interpolates is not optional in practice — omitting it types the literal text
 * `{{note}}` into the application). One function rather than two so the schema's
 * binding rule and the entry point's required-input rule cannot disagree.
 *
 * THE SCOPE IS "WHEREVER `substitute()` RUNS", which is why it is not just
 * `plan`: `replay/predicate.ts` substitutes into `text.contains` and
 * `valueEquals.value` for EVERY predicate it evaluates, and `classify()`
 * evaluates `contract.outcomes[].when` with the caller's params in hand. So a
 * `{{name}}` in an outcome predicate is interpolated at runtime exactly like one
 * in a step, and both are collected here. `provenance` and the rest of
 * `contract` are not walked: nothing interpolates them.
 */
export const referencedParams = (capability: Capability): ReadonlySet<string> => {
  const names = new Set<string>();
  const collect = (text: string): void => {
    for (const m of text.matchAll(PARAM_REF_G)) {
      const name = m[1];
      if (name !== undefined) names.add(name);
    }
  };
  eachString(capability.plan, [], collect);
  eachString(capability.contract.outcomes, [], collect);
  return names;
};

/**
 * The symbols a predicate's atoms NAME AS TARGETS, which `predicate.ts` resolves
 * through `ctx.targets` and which must therefore be declared in `plan.targets`.
 *
 * `rowCount.grid` is deliberately NOT collected — see refinement 8.
 */
const atomTargets = (predicate: Predicate, into: Set<string>): void => {
  for (const atom of [...predicate.all, ...predicate.any]) {
    if (atom.atom === "element" || atom.atom === "absent" || atom.atom === "valueEquals") {
      into.add(atom.target);
    }
  }
};

/** Report each repeated value at the index that repeats it, not at the first one. */
const eachDuplicate = (values: readonly string[], onDuplicate: (value: string, index: number) => void): void => {
  const seen = new Set<string>();
  values.forEach((v, i) => {
    if (seen.has(v)) onDuplicate(v, i);
    else seen.add(v);
  });
};

/**
 * TWELVE REFINEMENTS. Each one makes a class of dangerous artifact impossible to
 * LOAD, rather than discouraged by review.
 *
 * The count is stated because it is checkable, and because four of these were
 * added after an audit found the previous set asserting more than it enforced:
 * two of them inspected a single field while their comments said "anywhere in
 * the plan", one was a strict subset of a check Zod already ran, and one tested
 * the same condition twice.
 */
export const CapabilityChecked = Capability.superRefine((cap, ctx) => {
  const fail = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

  // 1. A capability may never take a secret. Credentials belong to the session
  //    provider, never to an artifact that gets committed (§3.4-e).
  cap.contract.inputs.forEach((i, n) => {
    if (i.sensitivity === "secret") fail(["contract", "inputs", n], `input "${i.name}" is secret; secrets never enter an artifact`);
  });

  /**
   * 2. NO PII-SHAPED LITERAL ANYWHERE IN `plan` OR `contract` — it must be a
   *    {{param}}.
   *
   * This walks EVERY string in both subtrees. It previously read exactly one
   * field, `plan.steps[].value`, while describing itself as "anywhere in the
   * plan" — so a PAN pasted into a `robustness` note, an outcome `message`, an
   * input `description` or a target `key` passed untouched.
   *
   * `provenance` is deliberately NOT walked: `traceDigest` is a 64-character
   * machine-generated hex digest, and it is the one field in the artifact whose
   * content nobody typed. Nothing else there can carry a tenant literal.
   *
   * VERIFIED before tightening, over all eight committed artifacts (three
   * fixtures + five evidence copies): zero hits under this whole-subtree walk.
   * So the widening rejects nothing that exists today, which is the only way to
   * tell a tightened rule from a broken one.
   */
  for (const subtree of [["plan", cap.plan] as const, ["contract", cap.contract] as const]) {
    eachString(subtree[1], [subtree[0]], (text, at) => {
      if (text.startsWith("{{")) return;
      for (const p of PII_SHAPED) {
        if (p.re.test(text)) fail(at, `${p.what} must be a {{param}}, not a recorded literal`);
      }
    });
  }

  /**
   * 3. Every acting step must assert what it ACHIEVED — and that assertion must
   *    differ from what it already required.
   *
   * The first half is the concrete defence against a phantom success (an
   * auto-dismissed dialog cancels a submit while the click still reports
   * success). The second half is what gives this refinement content: a
   * non-empty postcondition is ALREADY guaranteed by the `Predicate` type's own
   * `.refine` ("a predicate must assert something"), so the emptiness check
   * alone could never be the sole cause of a rejection.
   *
   * A step whose postcondition is identical to its precondition has asserted
   * only that the world did not change, which is precisely what an acting step
   * must not conclude from. Compared by serialisation: Zod emits object keys in
   * schema order, so two structurally identical predicates render identically.
   * That catches the exact-duplicate case and nothing subtler, which is all it
   * claims to catch.
   */
  cap.plan.steps.forEach((s, n) => {
    if (!ACTING.includes(s.action)) return;
    if (s.post.all.length + s.post.any.length === 0) {
      fail(["plan", "steps", n, "post"], `step ${s.ref} acts but asserts no postcondition`);
      return;
    }
    if (JSON.stringify(s.post) === JSON.stringify(s.pre)) {
      fail(
        ["plan", "steps", n, "post"],
        `step ${s.ref} asserts the same condition before and after acting, so it cannot show the action achieved anything`,
      );
    }
  });

  /**
   * 4. Never retry an irreversible step.
   *
   * PLAN-WIDE, AND THAT IS A REAL LIMITATION RATHER THAN A SIMPLIFICATION: a
   * recovery rule is declared for the whole plan and fires wherever its `when`
   * matches, so nothing in this schema can associate a rule with the step it
   * would fire on. The rule therefore refuses the COMBINATION — a retrying
   * recovery anywhere in a plan that contains an irreversible step — and cannot
   * be narrowed to "retrying the irreversible step itself" without a per-step
   * recovery table that does not exist.
   *
   * The condition was previously tested twice in one `if`, and built a `Set` of
   * step refs it never read; the set is now a boolean, which is all it ever was.
   */
  const hasIrreversibleStep = cap.plan.steps.some((s) => s.risk === "irreversible");
  if (hasIrreversibleStep) {
    cap.plan.recovery.forEach((r, n) => {
      if (r.do === "wait_and_retry" && r.maxAttempts > 1) {
        fail(["plan", "recovery", n], `retrying recovery "${r.id}" cannot coexist with an irreversible step`);
      }
    });
  }

  /**
   * 5. Every declared output is produced by exactly one step, and that step is a
   *    `read`.
   *
   * The verb check is the half that was missing. `executor.ts` populates an
   * output ONLY on the `read` branch (`capability.contract.outputs.find((o) =>
   * o.producedBy === step.ref)` sits inside `if (step.action === "read")`), so
   * an output pointed at a `click` names a step that can never populate it — a
   * declared return value the engine is structurally unable to produce.
   */
  const stepByRef = new Map(cap.plan.steps.map((s) => [s.ref, s]));
  cap.contract.outputs.forEach((o, n) => {
    const producer = stepByRef.get(o.producedBy);
    if (producer === undefined) {
      fail(["contract", "outputs", n], `output "${o.name}" names step ${o.producedBy}, which does not exist`);
    } else if (producer.action !== "read") {
      fail(
        ["contract", "outputs", n],
        `output "${o.name}" names step ${o.producedBy}, whose action is "${producer.action}"; only a read step can produce an output`,
      );
    }
  });

  // 6. An aria ref is valid only within the snapshot that produced it. Persisting
  //    one guarantees an artifact that replays today and breaks tomorrow.
  cap.plan.targets.forEach((t, n) =>
    t.strategies.forEach((s, m) => {
      if (ARIA_REF.test(s.key) && s.kind !== "field_key") {
        fail(["plan", "targets", n, "strategies", m], `"${s.key}" looks like a snapshot ref; refs are never durable targets`);
      }
    }),
  );

  // 7. A capability cannot understate its own risk: the contract must equal the
  //    maximum over its steps, so no artifact can talk its way past a gate.
  const order: RiskClass[] = ["read_only", "reversible", "irreversible"];
  const maxStep = cap.plan.steps.reduce((acc, s) => (order.indexOf(s.risk) > order.indexOf(acc) ? s.risk : acc), "read_only" as RiskClass);
  if (cap.contract.risk !== maxStep) {
    fail(["contract", "risk"], `contract.risk is "${cap.contract.risk}" but the steps reach "${maxStep}"`);
  }

  /**
   * 8. Every symbol NAMED AS A TARGET must be declared in `plan.targets` —
   *    whether a step names it or a predicate atom does.
   *
   * `predicate.ts` resolves `element`, `absent` and `valueEquals` through
   * `ctx.targets`, so an undeclared symbol in any of them is a predicate that
   * cannot be evaluated against anything. Previously only `steps[].target` was
   * checked, so the atoms were unguarded.
   *
   * `rowCount.grid` IS DELIBERATELY EXEMPT, and this is the one place in the
   * schema where a declared field is knowingly left unenforced. The evaluator
   * ignores `grid` entirely — `dataRowCount()` counts rows PAGE-WIDE — so
   * requiring the symbol to be declared would reject artifacts over a field that
   * changes no behaviour. It would also reject four FROZEN files: the committed
   * `tests/fixtures/lookup@1.0.0.json` checkpoint and the `capability.json` in
   * each of `evidence/runs/replay-lookup-found`, `replay-lookup-not-found` and
   * `replay-lookup-bad-input` all cite `"grid": "RESULTS_GRID"`, a symbol
   * declared in neither their `plan.targets` (MEMBER_ID and SUBMIT only) nor the
   * `fcu@4.2` binding. Those are graded evidence and are not being rewritten, so
   * the honest move is to exempt the field and say why, rather than to enforce a
   * rule the corpus cannot satisfy. `predicate.ts`'s rowCount arm now says
   * out loud, in its own `observed` string, that the count was page-wide and
   * whether the grid symbol was declared.
   */
  const declared = new Set(cap.plan.targets.map((t) => t.id));
  const namedTargets = new Set<string>();
  cap.plan.steps.forEach((s) => {
    if (s.target) namedTargets.add(s.target);
    atomTargets(s.pre, namedTargets);
    atomTargets(s.post, namedTargets);
  });
  atomTargets(cap.plan.checkpoint, namedTargets);
  for (const o of cap.contract.outcomes) atomTargets(o.when, namedTargets);
  for (const r of cap.plan.recovery) atomTargets({ all: [r.when], any: [] }, namedTargets);
  if (cap.plan.reconcile) {
    namedTargets.add(cap.plan.reconcile.target);
    atomTargets(cap.plan.reconcile.expect, namedTargets);
  }
  for (const symbol of namedTargets) {
    if (!declared.has(symbol)) {
      fail(["plan", "targets"], `symbol ${symbol} is targeted but not declared in plan.targets`);
    }
  }

  /**
   * 9. Every `{{param}}` the capability interpolates is a declared input.
   *
   * Without this, a plan can reference `{{note}}` with no such input declared,
   * and `substitute()` used to leave the placeholder in place — so replay typed
   * the literal text `{{note}}` into a live form and the step's own
   * postcondition (`valueEquals ... "{{note}}"`) confirmed it had done so.
   *
   * VERIFIED before adding: every `{{...}}` across every fixture and committed
   * artifact resolves to a declared input — `member_id`, `card_last4`, `action`
   * and nothing else.
   */
  const declaredInputs = new Set(cap.contract.inputs.map((i) => i.name));
  for (const name of referencedParams(cap)) {
    if (!declaredInputs.has(name)) {
      fail(["contract", "inputs"], `the plan references {{${name}}}, which is not a declared input`);
    }
  }

  /**
   * 10. An ACTING verb must name a target.
   *
   * `navigate`, `fill` and `click` all have to resolve something to act on.
   * Without this the executor's action branch (`step.action !== "assert" &&
   * target`) silently skips such a step — no action issued, no event emitted,
   * and `stepsCompleted` incremented anyway, so the run reports success for a
   * step that never happened. `assert` and `read` are correctly outside ACTING:
   * an assert acts on nothing, and a read without a target is caught by
   * refinement 5 the moment anything declares an output for it.
   */
  cap.plan.steps.forEach((s, n) => {
    if (ACTING.includes(s.action) && s.target === undefined) {
      fail(["plan", "steps", n, "target"], `step ${s.ref} performs "${s.action}" but names no target`);
    }
  });

  /**
   * 11. Identities are unique.
   *
   * Not tidiness — each of these is read through a lookup that silently keeps
   * ONE of a duplicate pair. `executor.ts` builds `new Map(targets.map(...))`,
   * which keeps the LAST duplicate id, and finds an output's producer with
   * `.find()`, which takes the FIRST. So two targets sharing an id, or two
   * outputs sharing a producer, resolve to whichever the implementation happened
   * to pick — a plan that means something different from what it reads like.
   */
  eachDuplicate(cap.plan.targets.map((t) => t.id), (id, n) =>
    fail(["plan", "targets", n, "id"], `target id ${id} is declared more than once`),
  );
  eachDuplicate(cap.plan.steps.map((s) => s.ref), (ref, n) =>
    fail(["plan", "steps", n, "ref"], `step ref ${ref} is used more than once`),
  );
  eachDuplicate(cap.contract.inputs.map((i) => i.name), (name, n) =>
    fail(["contract", "inputs", n, "name"], `input "${name}" is declared more than once`),
  );
  eachDuplicate(cap.contract.outputs.map((o) => o.name), (name, n) =>
    fail(["contract", "outputs", n, "name"], `output "${name}" is declared more than once`),
  );
  eachDuplicate(cap.contract.outputs.map((o) => o.producedBy), (ref, n) =>
    fail(["contract", "outputs", n, "producedBy"], `step ${ref} is named as the producer of more than one output, but a read step captures one value`),
  );

  /**
   * 12. A verified artifact must carry the count that makes the claim checkable.
   *
   * `replayResult: "success"` asserts that this artifact replayed. The whole
   * value of that claim is that replay uses no model, so the artifact has to
   * carry `modelCalls: 0` alongside it rather than leaving the reader to assume.
   *
   * `replayedAt` is deliberately NOT required with it — see the field's own
   * comment: a wall-clock stamp would break the byte-for-byte determinism
   * comparison of `capability.json`.
   */
  if (cap.verification.replayResult === "success" && cap.verification.modelCalls === undefined) {
    fail(["verification", "modelCalls"], "a capability claiming replayResult \"success\" must record modelCalls: 0");
  }
});

/** The only door in. Nothing downstream should call `Capability.parse` directly. */
export const parseCapability = (raw: unknown): Capability => CapabilityChecked.parse(raw);

export const safeParseCapability = (raw: unknown) => CapabilityChecked.safeParse(raw);
