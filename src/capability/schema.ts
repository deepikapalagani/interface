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

/** The closed action set. Replay is a walker over exactly these six verbs. */
export const ActionKind = z.enum(["navigate", "fill", "press", "click", "read", "assert"]);
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
  z.object({ atom: z.literal("text"), contains: z.string().min(1), within: Symbolic.optional() }),
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
  /** How many elements this matched AT RECORD TIME. Replay requires exactly 1 to act. */
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

const ParamRef = z.string().regex(/^\{\{[a-z][a-z0-9_]*\}\}$/, "must be a {{param}} reference");

export const Step = z.object({
  ref: z.string().regex(/^s[0-9]{2}$/),
  title: z.string().min(1),
  action: ActionKind,
  target: Symbolic.optional(),
  /** A literal, or a `{{param}}` reference. Literals are constrained below. */
  value: z.union([z.string(), ParamRef]).optional(),
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
    discoveredAt: z.string(),
    model: z.string(),
    traceDigest: z.string().regex(/^[a-f0-9]{64}$/),
    appProfileVersion: z.string(),
    /** Which fields a model wrote, versus derived mechanically from the trace. */
    modelAuthoredFields: z.array(z.string()),
  }),
  verification: z.object({
    replayedAt: z.string().optional(),
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
const ACTING: readonly ActionKind[] = ["navigate", "fill", "press", "click"];

/**
 * These refinements are the safety model. Each one makes a class of dangerous
 * artifact impossible to load, rather than discouraged by review.
 */
export const CapabilityChecked = Capability.superRefine((cap, ctx) => {
  const fail = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

  // 1. A capability may never take a secret. Credentials belong to the session
  //    provider, never to an artifact that gets committed (§3.4-e).
  cap.contract.inputs.forEach((i, n) => {
    if (i.sensitivity === "secret") fail(["contract", "inputs", n], `input "${i.name}" is secret; secrets never enter an artifact`);
  });

  // 2. No PII-shaped literal anywhere in the plan — it must be a {{param}}.
  cap.plan.steps.forEach((s, n) => {
    if (typeof s.value === "string" && !s.value.startsWith("{{")) {
      for (const p of PII_SHAPED) {
        if (p.re.test(s.value)) fail(["plan", "steps", n, "value"], `${p.what} must be a {{param}}, not a recorded literal`);
      }
    }
  });

  // 3. Every acting step must assert what it achieved. This is the concrete
  //    defence against a phantom success (an auto-dismissed dialog cancels a
  //    submit while the click still reports success).
  cap.plan.steps.forEach((s, n) => {
    if (ACTING.includes(s.action) && s.post.all.length + s.post.any.length === 0) {
      fail(["plan", "steps", n, "post"], `step ${s.ref} acts but asserts no postcondition`);
    }
  });

  // 4. Never retry an irreversible step. "Wait and retry" and "cannot be undone"
  //    are incompatible, so the schema refuses to hold both.
  const irreversible = new Set(cap.plan.steps.filter((s) => s.risk === "irreversible").map((s) => s.ref));
  if (irreversible.size > 0) {
    cap.plan.recovery.forEach((r, n) => {
      if (r.do === "wait_and_retry" && r.maxAttempts > 1 && irreversible.size > 0) {
        fail(["plan", "recovery", n], `retrying recovery "${r.id}" cannot coexist with an irreversible step`);
      }
    });
  }

  // 5. Every declared output has exactly one producing step.
  const stepRefs = new Set(cap.plan.steps.map((s) => s.ref));
  cap.contract.outputs.forEach((o, n) => {
    if (!stepRefs.has(o.producedBy)) fail(["contract", "outputs", n], `output "${o.name}" names step ${o.producedBy}, which does not exist`);
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

  // 8. Every symbol a step targets must be declared in plan.targets.
  const declared = new Set(cap.plan.targets.map((t) => t.id));
  cap.plan.steps.forEach((s, n) => {
    if (s.target && !declared.has(s.target)) fail(["plan", "steps", n, "target"], `step ${s.ref} targets undeclared symbol ${s.target}`);
  });
});

/** The only door in. Nothing downstream should call `Capability.parse` directly. */
export const parseCapability = (raw: unknown): Capability => CapabilityChecked.parse(raw);

export const safeParseCapability = (raw: unknown) => CapabilityChecked.safeParse(raw);
