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
 * Everything here is derived from executed facts plus ONE declared input: the
 * risk profile, which says what acting on each screen can do to the application.
 * That is knowledge about the product, and neither the trace nor the model has
 * it — see `risk-profile.ts` for why the alternative (a safe-looking default)
 * was worse than an explicit refusal.
 *
 * WHAT IS DELIBERATELY NOT COMPILED: the model's own prose checkpoint. `finish`
 * collects a sentence — "the results grid is showing one row" — and it is kept in
 * the trace and the transcript as evidence of what the model believed it had
 * achieved. It is not turned into an assertion, because a sentence is not a
 * predicate: converting it would mean either an LLM in the compile path or this
 * module guessing which words are checkable. The checkpoint below is assembled
 * from what was OBSERVED instead.
 *
 * Compilation is RE-RUNNABLE from a saved trace, which matters more than it
 * looks: every refusal in this file costs a re-compile, not another discovery
 * run.
 */
import { createHash } from "node:crypto";
import { canonicalField, canonicalFrame, canonicalLabel, type Binding } from "../capability/bind.js";
import type { RiskClass, TargetDescriptor } from "../capability/schema.js";
import { isStepEntry, STEP_ACTION, stepRefOf, type TraceEntry } from "../discover/executor.js";
import { hasPiiShape, piiShapeIn } from "../safety/redact.js";
import { maxRisk, riskForOrThrow, type RiskProfile } from "./risk-profile.js";

export interface CompileInput {
  readonly trace: readonly TraceEntry[];
  readonly goal: string;
  readonly capabilityId: string;
  readonly version: string;
  readonly app: string;
  readonly model: string;
  readonly appProfileVersion: string;
  readonly discoveredAt: string;
  /** The tenant the run happened against — used to turn its literals into symbols. */
  readonly binding: Binding;
  /** What acting on each screen can do to the application. See `risk-profile.ts`. */
  readonly riskProfile: RiskProfile;
}

/**
 * A compile that cannot be done HONESTLY stops here.
 *
 * Every throw site below is a case where the alternative was an artifact that
 * parses cleanly and is wrong — a literal where a symbol belongs, two controls
 * sharing one id, a step whose risk nobody established. The trace is already on
 * disk when this runs, so the cost of refusing is a re-compile.
 */
export class CompileRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompileRefused";
  }
}

/**
 * Literals in, symbols out.
 *
 * Minting records what the DOM reported — field `MBRNO`, label `"MEMBER ID"`,
 * frame `"content"` — because that is what the surface can actually find. An
 * artifact keyed on those would be welded to one institution, so the translation
 * happens exactly here, at the point the artifact is written.
 *
 * A literal the binding cannot name REFUSES THE COMPILE. Passing it through
 * produced the failure this file exists to prevent: the id `CARD_LAST_4` for the
 * label `"CARD (LAST 4)"`, which satisfied the schema and threw `UnboundSymbol`
 * at load. The message names the literal and the table, so the fix is one line in
 * the binding followed by a re-compile.
 */
const canonicalise = (target: TargetDescriptor, binding: Binding): TargetDescriptor => {
  const strategies = target.strategies.map((s) => {
    const symbol =
      s.kind === "table_anchor"
        ? canonicalLabel(binding, s.key)
        : s.kind === "field_key"
          ? canonicalField(binding, s.key)
          : null;
    if (symbol === null) {
      throw new CompileRefused(
        s.kind === "role_name"
          ? `strategy kind "role_name" has no binding table and minting never records one (target ${target.id})`
          : `binding "${binding.tenant}" has no ${s.kind === "table_anchor" ? "label" : "field"} named ${JSON.stringify(s.key)}, ` +
            `so the target recorded on ${target.screen} cannot be written as a symbol. Add it to the binding and re-compile from trace.jsonl.`,
      );
    }
    return { ...s, key: symbol };
  });

  const framePath = target.framePath.map((hop) => {
    if (hop.name === undefined) return hop;
    const role = canonicalFrame(binding, hop.name);
    if (role === null) {
      throw new CompileRefused(
        `binding "${binding.tenant}" names no frame ${JSON.stringify(hop.name)} (it knows "${binding.frames.content}" and "${binding.frames.nav}"), ` +
          `so the frame this target was recorded in cannot be written as a symbol.`,
      );
    }
    return { ...hop, name: role };
  });

  const id = strategies[0]?.key ?? target.id;
  return { ...target, id, framePath, strategies };
};

export const traceDigest = (trace: readonly TraceEntry[]): string =>
  createHash("sha256").update(JSON.stringify(trace)).digest("hex");

/**
 * Which recorded control this is, for de-duplication.
 *
 * (screen, frame, id) rather than id alone. Keyed on the id, two controls sharing
 * a label on different screens collapsed into one descriptor pinned to whichever
 * screen was recorded first — an artifact that parses and resolves to the wrong
 * element.
 */
const controlKey = (t: TargetDescriptor): string =>
  `${t.screen}|${t.framePath.map((h) => h.name ?? `#${h.index ?? "?"}`).join("/")}|${t.id}`;

/** Output names must satisfy the schema's `^[a-z][a-z0-9_]*$`; the model supplies free text. */
const outputName = (raw: string): string => {
  const cleaned = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^([0-9])/, "v$1");
  return cleaned === "" ? "value" : cleaned;
};

interface PlannedStep {
  readonly entry: TraceEntry;
  readonly ref: string;
  readonly symbol: string;
  readonly action: "fill" | "click" | "read";
  readonly risk: RiskClass;
}

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
  const { binding, riskProfile } = input;
  const acting = input.trace.filter(isStepEntry);

  // Targets, de-duplicated on (screen, frame, id) and canonicalised. A symbol
  // reached by two DIFFERENT controls is a collision the artifact cannot express:
  // `plan.targets` would carry two entries with one id, and replay's own
  // `new Map(...)` keeps the last silently.
  const canonicalByControl = new Map<string, TargetDescriptor>();
  const controlBySymbol = new Map<string, string>();
  for (const entry of acting) {
    const target = entry.target;
    if (!target) continue;
    const key = controlKey(target);
    if (canonicalByControl.has(key)) continue;

    const canonical = canonicalise(target, binding);
    const clash = controlBySymbol.get(canonical.id);
    if (clash !== undefined && clash !== key) {
      throw new CompileRefused(
        `two different controls both canonicalise to the symbol ${canonical.id}: ${clash} and ${key}. ` +
          `An artifact cannot name both, and replay would silently resolve every step to whichever came last.`,
      );
    }
    canonicalByControl.set(key, canonical);
    controlBySymbol.set(canonical.id, key);
  }

  const steps: PlannedStep[] = acting.map((entry, i) => {
    const target = entry.target;
    const canonical = target ? canonicalByControl.get(controlKey(target)) : undefined;
    if (!target || !canonical) {
      throw new CompileRefused(`trace entry ${entry.index} (${entry.tool}) was counted as a step but carries no recorded target`);
    }
    const action = STEP_ACTION[entry.tool] ?? "click";
    return {
      entry,
      ref: stepRefOf(i + 1),
      symbol: canonical.id,
      action,
      /**
       * A `read` issues no action: the replay executor reads through
       * `surface.read()` and never reaches the gate, so it cannot commit whatever
       * the screen is rated. Its risk is a property of the verb. Every other verb
       * asks the profile, which REFUSES rather than defaulting.
       */
      risk: action === "read" ? "read_only" : riskForOrThrow(riskProfile, entry.screenBefore, canonical.id),
    };
  });

  const planSteps = steps.map((s) => {
    const { entry, ref, symbol, action, risk } = s;

    // Preconditions come from where the step actually ran.
    const pre = entry.screenBefore
      ? { all: [{ atom: "screen", is: entry.screenBefore }], any: [] }
      : { all: [{ atom: "element", target: symbol, present: true }], any: [] };

    // Postconditions come from what the step actually achieved. A fill proves
    // itself by the value landing; a click that moved the screen proves itself by
    // the new screen; a click that did not proves itself by its target surviving.
    const post =
      action === "fill"
        ? { all: [{ atom: "valueEquals", target: symbol, value: entry.value ?? "" }], any: [] }
        : entry.screenAfter && entry.screenAfter !== entry.screenBefore
          ? { all: [{ atom: "screen", is: entry.screenAfter }], any: [] }
          : { all: [{ atom: "element", target: symbol, present: true }], any: [] };

    return {
      ref,
      title: `${action === "fill" ? "Enter" : action === "read" ? "Read" : "Activate"} ${symbol.toLowerCase().replace(/_/g, " ")}`,
      action,
      target: symbol,
      ...(action === "fill" ? { value: entry.value ?? "" } : {}),
      pre,
      post,
      risk,
      // Gating is the policy's job, not the artifact's: an approval stamped here
      // would be the recording asking for its own permission.
      approval: "none",
    };
  });

  /**
   * Executed dialogs become the recovery table.
   *
   * These entries used to be dropped on the floor: they carry no target, so the
   * step filter skipped them, and `plan.recovery` was the literal `[]` for every
   * compile. A run that met the shipped `broadcast` interstitial, dismissed it and
   * carried on therefore compiled an artifact whose replay hard-fails on the
   * interstitial the discovery run had demonstrably handled.
   *
   * The trigger is the message AS OBSERVED, whole. Narrowing it to a prefix would
   * be this compiler guessing which half of a vendor's wording is stable, and a
   * recovery rule that fires on the wrong dialog is worse than one that does not
   * fire at all.
   */
  const recovery: Record<string, unknown>[] = [];
  const seenDialogs = new Set<string>();
  for (const entry of input.trace) {
    const dialog = entry.dialog;
    if (!dialog) continue;
    const key = `${dialog.answer}|${dialog.message}`;
    if (seenDialogs.has(key)) continue;
    seenDialogs.add(key);

    // A dialog can render member data. A recorded trigger is a committed literal,
    // and the schema's PII refinement only inspects step values — so the check
    // lives here, at the one place that writes a dialog message into an artifact.
    const shape = piiShapeIn(dialog.message);
    if (shape !== null) {
      throw new CompileRefused(
        `the dialog observed during this run carries ${shape}, so it cannot be recorded as a recovery trigger. ` +
          `The rule would have to be authored by hand against a non-sensitive fragment of the message.`,
      );
    }

    recovery.push({
      id: `${dialog.answer}-dialog-${String(recovery.length + 1).padStart(2, "0")}`,
      when: { atom: "dialog", messageContains: dialog.message },
      do: dialog.answer === "accept" ? "accept_dialog" : "dismiss_dialog",
      // Two: enough for the same interstitial to reappear once on a re-render,
      // few enough that a dialog which never clears ends the run instead of
      // looping.
      maxAttempts: 2,
      note: `Observed on ${entry.screenBefore ?? "an unrecognised screen"} during discovery, which answered it with ${dialog.answer} and continued. Trigger recorded as the message appeared, not narrowed.`,
    });
  }

  const outputs = steps
    .filter((s) => s.entry.captured)
    .map((s) => ({
      name: outputName(s.entry.captured?.as ?? "value"),
      type: "string",
      // Anything read off a servicing screen is assumed sensitive until a human
      // says otherwise. The cheap default is the safe one.
      sensitivity: "confidential",
      producedBy: s.ref,
      description: `Captured from ${s.symbol} during discovery.`,
    }));

  // The checkpoint asserts the state the run actually ended in — plus each
  // declared output being present, since a capability that returns a value has
  // not succeeded if the value is not there.
  const last = steps.length > 0 ? steps[steps.length - 1] : undefined;
  const lastScreen = last?.entry.screenAfter ?? null;

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
      ...steps.filter((s) => s.entry.captured).map((s) => ({ atom: "element", target: s.symbol, present: true })),
    ],
    any: [],
  };

  /**
   * A checkpoint with nothing in it is REFUSED, not filled in.
   *
   * This used to fall back to the fabricated screen symbol `UNKNOWN`. MEASURED:
   * that artifact passes `safeParseCapability` and then throws
   * `UnboundSymbol: binding "fcu" does not define screen symbol "UNKNOWN"` at
   * `resolve()` — the same "parses cleanly, fails at load" failure minting was
   * fixed for, surviving one layer down in this file.
   *
   * Reachable as shipped: `BoundSurface` reports `screen: null` for a screen the
   * binding cannot name (SYS0500, the abend screen), so a final click that lands
   * there leaves `lastScreen` null, and a run that captured nothing then has no
   * observed fact left to assert.
   */
  if (checkpoint.all.length === 0) {
    throw new CompileRefused(
      `this run ended on a screen this binding cannot name and captured no value, so there is nothing OBSERVED to assert as a success condition. ` +
        `A capability whose checkpoint is a fabricated symbol parses cleanly and fails at load, so it is refused: add the screen to the binding and re-compile from trace.jsonl.`,
    );
  }

  const contractRisk = maxRisk(steps.map((s) => s.risk));

  return {
    schemaVersion: 1,
    contract: {
      id: input.capabilityId,
      version: input.version,
      goal: input.goal,
      purpose:
        `Compiled from a discovery run: ${input.trace.length} recorded tool call(s) became ` +
        `${planSteps.length} ordered step(s) and ${recovery.length} recovery rule(s).`,
      // Mechanically there are no parameters: every value is the literal the model
      // typed. Deciding which of them are really inputs is a judgement call, and
      // no pass makes it — `provenance.modelAuthoredFields` is empty below for the
      // same reason. A caller of a discovered artifact replays the recorded
      // literals; the committed fixtures are what demonstrate typed parameters.
      inputs: [],
      outputs,
      // Non-happy-path signatures are a property of the application, not of one
      // run — discovery only ever sees the happy path. They come from the app
      // profile, not from here.
      outcomes: [],
      // Equality, because schema refinement 7 requires it: the contract may not
      // understate the maximum over its own steps.
      risk: contractRisk,
      requiresSession: contractRisk !== "read_only",
    },
    plan: {
      app: input.app,
      targets: [...canonicalByControl.values()],
      steps: planSteps,
      recovery,
      checkpoint,
    },
    provenance: {
      discoveredAt: input.discoveredAt,
      model: input.model,
      traceDigest: traceDigest(input.trace),
      appProfileVersion: input.appProfileVersion,
      // Nothing here was written by a model: every field above was derived from
      // executed steps and the declared risk profile.
      modelAuthoredFields: [],
    },
    verification: {
      // Honest until proven: a compiled artifact has not replayed yet. Nothing in
      // this module ever writes "success" — stamping a verified result is the job
      // of whatever actually runs a replay, and this field's value here says only
      // that no replay has happened at compile time.
      replayResult: "not_yet_verified",
    },
  };
};

/** Re-exported so a caller can pre-screen text it is about to put in an artifact. */
export { hasPiiShape };
