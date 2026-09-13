/**
 * THE EVENT LOG — §3.5's "structured log of what the agent did and why".
 *
 * One envelope serves discovery, replay and handoff. That is deliberate: a
 * reviewer reading `/evidence/` should be able to follow a capability from the
 * run that discovered it, through the run that replayed it, into the human turn
 * that unblocked it, without learning three formats.
 *
 * THE INTERESTING PART IS `why`. The spec asks for what the agent did *and why*,
 * and "why" means something genuinely different in each phase — so it is a typed
 * union of six arms rather than a free-text string:
 *
 *   model_decision   a BELIEF. The model chose this; here is its stated reason.
 *                    Only ever emitted during discovery.
 *   artifact_step    a CITATION. Replay did this because step s04 of capability
 *                    X@1.0.0 says so. A reviewer can open the file and check.
 *   policy           a CITATION. The gate allowed or refused, naming the rule.
 *   handler          a CITATION. A declared recovery rule fired.
 *   outcome_signal   a CITATION. This observation matched a declared outcome —
 *                    which is how a business-outcome classification becomes
 *                    auditable rather than asserted.
 *   operator         an ATTRIBUTION. A person did this, or asked for it.
 *
 * The distinction is the whole point: in discovery `why` is a belief, in replay
 * it is a checkable citation, and in a handoff it is an attribution to a person.
 * A single string field would flatten all three into prose nobody can verify.
 */
import type { ControlOwner } from "../contract/result.js";

export type Phase = "discovery" | "replay" | "handoff";

export type Why =
  | { readonly as: "model_decision"; readonly stated: string; readonly model: string; readonly turn: number }
  | { readonly as: "artifact_step"; readonly capability: string; readonly version: string; readonly stepRef: string }
  | { readonly as: "policy"; readonly ruleId: string; readonly allowed: boolean; readonly dimension: string }
  | { readonly as: "handler"; readonly ruleId: string; readonly attempt: number }
  | { readonly as: "outcome_signal"; readonly code: string; readonly matched: string }
  | { readonly as: "operator"; readonly operator: string; readonly disposition: string };

/**
 * One line of the log. `seq` is gapless per run, so a missing line is detectable
 * rather than merely absent — a log you cannot prove is complete is weak evidence.
 */
export interface LogEvent {
  readonly seq: number;
  readonly at: string;
  readonly runId: string;
  readonly phase: Phase;
  /** On EVERY line. This is what makes "who was in control" reconstructible (§3.6-d). */
  readonly controlOwner: ControlOwner;
  /** What happened, in the system's own vocabulary. */
  readonly event: string;
  readonly stepRef: string | null;
  readonly why: Why;
  /** Expected/observed pair where one applies — the debuggable half of §3.3-g. */
  readonly expected?: string;
  readonly observed?: string;
  /**
   * True when redaction ACTUALLY CHANGED this line on its way to disk.
   *
   * STAMPED BY THE WRITER, NOT BY THIS SEQUENCER, and that is the only place it
   * can honestly be set: the sequencer holds the line in memory, where nothing
   * has been masked yet. `EvidenceWriter.event()` redacts, compares the
   * serialised forms, and sets this only if they differ — so the flag means "a
   * value on this line was masked", never "a redactor was in the code path".
   *
   * It had ZERO producers before that: a field on the graded evidence envelope
   * that could never be true, which a reviewer would read as a redaction
   * indicator.
   */
  readonly redacted?: boolean;
  readonly detail?: Readonly<Record<string, unknown>>;
}

export interface LogContext {
  readonly runId: string;
  readonly phase: Phase;
  readonly now: () => string;
  readonly controlOwner: () => ControlOwner;
  /**
   * Where each line goes THE MOMENT IT IS EMITTED, when a caller wants that.
   *
   * `evidence/log.ts` says JSONL was chosen "because a run that crashes half way
   * should still leave readable evidence up to the point it stopped", and
   * `event()` describes itself as "called as the run goes". Neither was true in
   * production: the only caller of `event()` was the bulk `events()` flush, and
   * both CLIs called that ONCE, after the run had already returned. A throw
   * anywhere inside `replay()` lost every line rather than merely the last.
   *
   * OPTIONAL, because the sequencer stays pure and I/O-free for the tests that
   * assert its SHAPE without touching a filesystem. Wiring it is the CLI's job.
   */
  readonly sink?: (event: LogEvent) => void;
}

/**
 * A pure, gapless sequencer. Kept free of I/O so the log's SHAPE can be tested
 * without touching a filesystem; the JSONL writer wraps this.
 */
export class EventSequencer {
  private seq = 0;
  private readonly events: LogEvent[] = [];

  constructor(private readonly ctx: LogContext) {}

  /**
   * `phase` is the ONE context field a single line may override, and the override
   * is what makes a handoff recordable at all.
   *
   * MEASURED: before this, `phase` came only from `LogContext` and was fixed for
   * the life of the sequencer, so `emit(..., { phase: "handoff" })` was error
   * TS2353 — the envelope declared a `handoff` phase that no writer could
   * produce. A SECOND sequencer is not the workaround: `seq` restarts at 1, and
   * scripts/verify-evidence.ts:271 requires `seq === file line index + 1`, so a
   * second sequencer's lines would read as a gap or a duplicate in the one
   * events.jsonl they both append to.
   *
   * Per-emit rather than making `LogContext.phase` a `() => Phase` (the shape
   * `controlOwner` uses) because the two facts differ in kind. Control genuinely
   * is run state — it is whatever the lease says at the instant the line is
   * stamped, which is why a handoff's lines must be emitted AT the transition
   * rather than drained afterwards. A phase is not run state: the run is a replay
   * run throughout, and only the individual line describing the control transfer
   * is a handoff. A thunk would let any later line silently inherit a phase
   * somebody forgot to put back.
   *
   * THE PROJECTION IS UNTOUCHED, and this is the part worth stating because the
   * next person will worry about it: scripts/verify-determinism.ts:136-159 drives
   * this real sequencer and fails with "PROJECTION UNSOUND" unless
   * `projectForDiff` drops EXACTLY [at, runId]. An override writes a different
   * VALUE into a field that already existed on every line; it adds no field, so
   * the key set the guard compares is identical and the diff still catches a
   * phase that changed between two runs.
   */
  emit(
    event: string,
    why: Why,
    extra: Omit<Partial<LogEvent>, "seq" | "at" | "runId" | "controlOwner" | "event" | "why"> = {},
  ): LogEvent {
    this.seq += 1;
    const line: LogEvent = {
      seq: this.seq,
      at: this.ctx.now(),
      runId: this.ctx.runId,
      phase: extra.phase ?? this.ctx.phase,
      controlOwner: this.ctx.controlOwner(),
      event,
      stepRef: extra.stepRef ?? null,
      why,
      ...(extra.expected === undefined ? {} : { expected: extra.expected }),
      ...(extra.observed === undefined ? {} : { observed: extra.observed }),
      ...(extra.redacted === undefined ? {} : { redacted: extra.redacted }),
      ...(extra.detail === undefined ? {} : { detail: extra.detail }),
    };
    this.events.push(line);
    // Appended as the run goes when a sink is wired, which is what makes the
    // crash-resilience claim in `evidence/log.ts` true rather than aspirational.
    this.ctx.sink?.(line);
    return line;
  }

  get all(): readonly LogEvent[] {
    return this.events;
  }

  /** Gapless by construction; asserted so a truncated log cannot pass unnoticed. */
  isComplete(): boolean {
    return this.events.every((e, i) => e.seq === i + 1);
  }

  /**
   * The determinism projection: drop everything that legitimately varies between
   * two identical runs, so two logs can be compared byte for byte. Timestamps and
   * run ids vary by definition; nothing else should.
   */
  projectForDiff(): readonly Omit<LogEvent, "at" | "runId">[] {
    return this.events.map(({ at: _at, runId: _runId, ...rest }) => rest);
  }
}
