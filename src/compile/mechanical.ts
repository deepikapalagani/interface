/**
 * THE COMPILER — a trace becomes a capability.
 *
 * ONE RULE GOVERNS THIS FILE: it reads the TRACE and never the transcript.
 *
 * §2 requires the artifact to be "decoupled from the raw model transcript", and
 * that is only meaningful if it is checkable. The trace is a list of typed steps
 * that were actually EXECUTED, each with a target already minted and verified at
 * record time. The transcript is what a model said. Compiling from the first and
 * not the second means the artifact describes what happened, not what was
 * claimed — and the difference is visible in this module's imports.
 *
 * Everything here is MECHANICAL: derived by code from executed facts. A separate,
 * narrow model pass may later fill the judgement fields — which literals are
 * really parameters, and a human-readable name — and the artifact records which
 * fields came from where, so a reviewer can tell measured from inferred.
 *
 * Compilation is also RE-RUNNABLE from a saved trace, which matters more than it
 * looks: a bug in this file costs a re-compile, not another discovery run.
 */
import { createHash } from "node:crypto";
import { canonicalField, canonicalLabel, type Binding } from "../capability/bind.js";
import type { TargetDescriptor } from "../capability/schema.js";
import type { TraceEntry } from "../discover/executor.js";

export interface CompileInput {
  readonly trace: readonly TraceEntry[];
  readonly goal: string;
  readonly capabilityId: string;
  readonly version: string;
  readonly app: string;
  readonly model: string;
  readonly appProfileVersion: string;
  readonly discoveredAt: string;
  /** What the model said proves the goal was reached. A claim, used as a hint. */
  readonly finishCheckpoint: string | null;
  /** The tenant the run happened against — used to turn its literals into symbols. */
  readonly binding: Binding;
}

/**
 * Literals in, symbols out.
 *
 * Minting records what the DOM reported — field `MBRNO`, label `"MEMBER ID"` —
 * because that is what the surface can actually find. An artifact keyed on those
 * would be welded to one institution, so the translation happens exactly here, at
 * the point the artifact is written. An unknown literal is left alone: it simply
 * will not resolve, and `resolve()` reports it as drift naming the missing key.
 */
const canonicalise = (target: TargetDescriptor, binding: Binding): TargetDescriptor => {
  const strategies = target.strategies.map((s) => ({
    ...s,
    key:
      (s.kind === "table_anchor"
        ? canonicalLabel(binding, s.key)
        : s.kind === "field_key"
          ? canonicalField(binding, s.key)
          : null) ?? s.key,
  }));
  return { ...target, id: strategies[0]?.key ?? target.id, strategies };
};

const ACTION_FOR: Record<string, "fill" | "click" | "read"> = {
  type_text: "fill",
  click: "click",
  read: "read",
};

const stepRef = (i: number): string => `s${String(i + 1).padStart(2, "0")}`;

export const traceDigest = (trace: readonly TraceEntry[]): string =>
  createHash("sha256").update(JSON.stringify(trace)).digest("hex");

/**
 * Build a draft capability from executed steps.
 *
 * Returns a plain object rather than a `Capability`: the caller passes it through
 * `parseCapability`, so a compile that produces something invalid fails loudly at
 * the schema rather than producing a subtly broken artifact. The schema's
 * refinements are doing real work here — a recorded literal that looks like a
 * card number or an SSN will be REJECTED, which forces it to become a parameter
 * instead of being quietly baked into a committed file.
 */
export const compileMechanical = (input: CompileInput): Record<string, unknown> => {
  const acting = input.trace.filter((e) => e.target && ACTION_FOR[e.tool]);

  // Targets, deduplicated and canonicalised. Keyed by the id minting used, so
  // step references can be rewritten to the symbol consistently.
  const targets = new Map<string, TargetDescriptor>();
  for (const entry of acting) {
    if (entry.target && !targets.has(entry.target.id)) {
      targets.set(entry.target.id, canonicalise(entry.target, input.binding));
    }
  }
  const symbolFor = (entry: TraceEntry): string => targets.get(entry.target?.id ?? "")?.id ?? entry.target?.id ?? "TARGET";

  const steps = acting.map((entry, i) => {
    const action = ACTION_FOR[entry.tool] ?? "click";
    const target = { id: symbolFor(entry) };

    // Preconditions come from where the step actually ran.
    const pre = entry.screenBefore
      ? { all: [{ atom: "screen", is: entry.screenBefore }], any: [] }
      : { all: [{ atom: "element", target: target.id, present: true }], any: [] };

    // Postconditions come from what the step actually achieved. A fill proves
    // itself by the value landing; a click that moved the screen proves itself by
    // the new screen; a click that did not proves itself by its target surviving.
    const post =
      action === "fill"
        ? { all: [{ atom: "valueEquals", target: target.id, value: entry.value ?? "" }], any: [] }
        : entry.screenAfter && entry.screenAfter !== entry.screenBefore
          ? { all: [{ atom: "screen", is: entry.screenAfter }], any: [] }
          : { all: [{ atom: "element", target: target.id, present: true }], any: [] };

    return {
      ref: stepRef(i),
      title: `${action === "fill" ? "Enter" : action === "read" ? "Read" : "Activate"} ${target.id.toLowerCase().replace(/_/g, " ")}`,
      action,
      target: target.id,
      ...(action === "fill" ? { value: entry.value ?? "" } : {}),
      pre,
      post,
      // Conservative by default. The policy raises risk per screen at runtime, and
      // an artifact can never talk its own risk down.
      risk: "read_only",
      approval: "none",
    };
  });

  const outputs = acting
    .map((entry, i) => ({ entry, ref: stepRef(i) }))
    .filter((x) => x.entry.captured)
    .map((x) => ({
      name: x.entry.captured?.as ?? "value",
      type: "string",
      // Anything read off a servicing screen is assumed sensitive until a human
      // says otherwise. The cheap default is the safe one.
      sensitivity: "confidential",
      producedBy: x.ref,
      description: `Captured from ${symbolFor(x.entry)} during discovery.`,
    }));

  // The checkpoint asserts the state the run actually ended in — plus each
  // declared output being present, since a capability that returns a value has
  // not succeeded if the value is not there.
  const last = acting.length > 0 ? acting[acting.length - 1] : undefined;
  const lastScreen = last?.screenAfter ?? null;

  // DELIBERATELY NOT ASSERTED HERE: a row count.
  //
  // The trace records `rowsAfter`, so this compiler COULD emit `rowCount gte 1`
  // and stop a zero-row results screen from satisfying a screen-only checkpoint.
  // It must not do so alone, and the reason is the schema's own rule that the
  // three result classes live in three different places.
  //
  // "No records found" is a BUSINESS OUTCOME, not a failed checkpoint. With no
  // MEMBER_NOT_FOUND declared in `contract.outcomes`, a `rowCount gte 1`
  // checkpoint would convert that legitimate answer into a HARD FAILURE — the
  // same §3.3 conflation as a phantom success, only mirrored. `classify` tests
  // outcomes BEFORE the checkpoint, so the row assertion is safe only once the
  // outcome sits beside it. Both describe the application rather than this one
  // run, so both arrive together from the app profile.
  const checkpoint = {
    all: [
      ...(lastScreen ? [{ atom: "screen", is: lastScreen }] : []),
      ...outputs.map((o) => {
        const producer = acting.find((_, i) => stepRef(i) === o.producedBy);
        return { atom: "element", target: producer ? symbolFor(producer) : o.name, present: true };
      }),
    ],
    any: [],
  };

  return {
    schemaVersion: 1,
    contract: {
      id: input.capabilityId,
      version: input.version,
      goal: input.goal,
      purpose: `Compiled from a discovery run of ${acting.length} executed step(s).`,
      // Mechanically there are no parameters: every value was a literal the model
      // typed. Turning the right ones into {{params}} is a judgement call, made by
      // a separate narrow pass and recorded as model-authored.
      inputs: [],
      outputs,
      // Non-happy-path signatures are a property of the application, not of one
      // run — discovery only ever sees the happy path. They come from the app
      // profile, not from here.
      outcomes: [],
      risk: "read_only",
      requiresSession: false,
    },
    plan: {
      app: input.app,
      targets: [...targets.values()],
      steps,
      recovery: [],
      checkpoint: checkpoint.all.length > 0 ? checkpoint : { all: [{ atom: "screen", is: lastScreen ?? "UNKNOWN" }], any: [] },
    },
    provenance: {
      discoveredAt: input.discoveredAt,
      model: input.model,
      traceDigest: traceDigest(input.trace),
      appProfileVersion: input.appProfileVersion,
      // Nothing here was written by a model: every field above was derived from
      // executed steps. The narrow inference pass appends to this list.
      modelAuthoredFields: [],
    },
    verification: {
      // Honest until proven: a compiled artifact has not replayed yet, and the
      // compile pipeline stamps this only after one succeeds.
      replayResult: "not_yet_verified",
    },
  };
};
