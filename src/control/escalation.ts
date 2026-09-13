/**
 * ESCALATION — raise, cede, human turn, hand back. The flow §3.6 asks for, as a
 * mechanism rather than a status field.
 *
 * `ControlLease` already answers "who may act": `assertAutomation` runs at the
 * surface chokepoint, so an action by the wrong actor FAILS. What it does not do
 * is get a person there, bound how long we wait, or leave a record of the turn.
 * That is this module: it is the only thing that ever ceded control in
 * production, and it is where `expire()` and `.transitions` acquire their first
 * callers anywhere in the repo.
 *
 * ── WHY THE TTL LIVES HERE AND NOT IN src/replay/** ─────────────────────────
 *
 * `settle.ts` is "the ONLY module in the replay path permitted to reference a
 * timer", and tests/source-invariants.test.ts now enforces that by reading the
 * source. This module is deliberately outside that directory, because a handoff
 * deadline is a categorically different thing from the sleeps that invariant
 * exists to ban:
 *
 *   a settle sleep waits for THE APPLICATION, which is why it must be bounded by
 *   a declared condition instead of a guess — the app's own state is observable,
 *   so waiting a fixed time for it is always either too long or too short;
 *
 *   a TTL waits for A PERSON, whose arrival is not observable from the surface at
 *   all. There is no declared condition that becomes true when somebody wakes up.
 *   A wall-clock bound is the only honest one available, and its absence is what
 *   lets an escalation hang a production worker forever.
 *
 * It is injectable for the same reason `settle`'s sleep is: no test may wait in
 * real time to prove a timeout fires.
 *
 * ── ONE ENFORCEMENT POINT HERE, NOT TWO ─────────────────────────────────────
 *
 * Said plainly, and scoped to the configuration it is true of: in a run WIRED
 * WITH A SESSION there are two refusals — `ControlLease` (via the gate) and the
 * driver's own human-turn lock (`LiveSession.beginHumanTurn`, armed below BEFORE
 * any banner is painted, so a banner that fails to render still leaves the
 * session locked). They share no state, which is the point.
 *
 * `session` is OPTIONAL (see `EscalationDeps`), so "two refusals" is a property
 * of the call site, not of this module. Which configurations have one, measured
 * rather than assumed: `src/replay/main.ts` passes `session: driver`, so the
 * production CLI gets both points. `tests/handoff.test.ts` and
 * `tests/side-effect.test.ts` pass none, so the two suites carrying the most
 * handoff assertions are exercising the SINGLE-point configuration — the lease
 * alone. The independence of the two is proven instead by
 * `tests/handoff.integration.test.ts`, which builds a naive lease that believes
 * automation is driving and shows the driver refusing anyway. The
 * TARGET APP is not a third — but the reason has narrowed, and the old one has
 * expired. It used to be that every application route was a pure read, so there
 * was no mutating route for a third point to protect. There is one now
 * (`POST /screen/card-action`), and an audit trail recording every attempt
 * against it. The app still has no notion of a holder or a session, so it cannot
 * refuse a write on the grounds that a person is driving, and nothing here
 * pretends otherwise: what it records is the authority a request carried, never
 * who was at the keyboard. `src/control/lease.ts` states that limit in full.
 */
import type { EscalationRecord } from "../contract/result.js";
import type { EventSequencer } from "../evidence/events.js";
import { redactText } from "../safety/redact.js";
import type { ControlLease } from "./lease.js";

/**
 * What an operator is shown, and it is exactly §3.6-b's list: "goal/capability,
 * current step, current state or screenshot, why it stopped". Nothing here is a
 * handle into the driver — a console renders this and nothing else, which is what
 * keeps the operator UI mockable while the transfer stays real.
 */
export interface InterventionRequest {
  readonly runId: string;
  /** §3.6-b "goal/capability" — the goal travels with the ids, not as a lookup. */
  readonly capability: { readonly id: string; readonly version: string; readonly goal: string };
  /** §3.6-b "current step". */
  readonly stepRef: string;
  readonly stepTitle: string;
  readonly action: string;
  /** The POLICY's rating, which may be higher than the artifact's claim. */
  readonly effectiveRisk: string;
  /** §3.6-b "why it stopped" — the gate's own reason, and the rule that produced it. */
  readonly reason: string;
  readonly ruleId: string;
  /** §3.6-b "current state": where the session actually is, perceived at raise time. */
  readonly screen: string | null;
  readonly location: string;
  /** Redacted by the CALLER, which is the only layer that knows what it perceived. */
  readonly observedText: string;
  readonly requestedAt: string;
  readonly deadlineAt: string;
  /** Masked at capture time; absent rather than unmasked if masking could not be honoured. */
  readonly screenshot?: { readonly bytes: Uint8Array; readonly maskedRegions: number };
}

/**
 * What the caller can supply. `requestedAt` and `deadlineAt` are NOT the caller's
 * to invent: the first is the control journal's own record of the cede, and the
 * second is derived from it, so neither can disagree with the audit of control.
 */
export type InterventionDraft = Omit<InterventionRequest, "requestedAt" | "deadlineAt">;

/**
 * How a human turn ended. Three kinds because three different things happen, and
 * they map one-to-one onto `EscalationRecord.disposition` and onto three distinct
 * `FailureKind`s: collapsing "nobody came" into "the person gave up" would tell a
 * caller to stop retrying when the correct move is to attach an operator.
 */
export type HandoffOutcome =
  | { readonly kind: "resolved"; readonly operator: string; readonly note?: string }
  | { readonly kind: "abort"; readonly operator: string; readonly note?: string }
  | { readonly kind: "timeout" };

/**
 * The seam between the run and whatever reaches a person.
 *
 * ONE method, deliberately. The live-session component implements it over HTTP to
 * a console; tests implement it in three lines. Everything that makes the
 * transfer real — the lease, the epoch fence, the driver lock, the gate, the
 * journal — sits on this side of the seam, so a transport cannot fake a control
 * transfer by returning a canned outcome: it can only report what a person chose.
 */
export interface EscalationTransport {
  raise(request: InterventionRequest): Promise<HandoffOutcome>;
}

/**
 * The driver's own lock, typed STRUCTURALLY so this module does not import
 * `src/surface/session.ts`. Escalation is a control-flow concern and has no
 * business depending on a driver seam; `LiveSession` satisfies this shape
 * incidentally, which is the correct direction of the dependency.
 */
export interface HumanTurnLock {
  beginHumanTurn(): Promise<void>;
  endHumanTurn(): Promise<void>;
}

export interface EscalationDeps {
  readonly lease: ControlLease;
  readonly log: EventSequencer;
  /** Absent is a NORMAL case, not an error — see `runEscalation`. */
  readonly transport?: EscalationTransport;
  readonly ttlMs: number;
  /** The run's own monotonic clock, used only to measure the pause. */
  readonly now: () => number;
  readonly session?: HumanTurnLock;
  /** Injectable so no test waits in real time for a TTL. */
  readonly deadline?: (ms: number) => Promise<void>;
}

export interface EscalationResult {
  readonly record: EscalationRecord;
  readonly outcome: HandoffOutcome;
  /** Wall time the person held the session. The run must not be charged for it. */
  readonly pausedMs: number;
}

/** What the executor is handed: raise this, and tell me how the turn ended. */
export type Escalate = (draft: InterventionDraft) => Promise<EscalationResult>;

/**
 * Node keeps the process alive for a pending timer, so a handoff resolved in two
 * seconds would otherwise hold a CLI open for the rest of a ten-minute TTL.
 */
const wallClockDeadline = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    if (typeof handle.unref === "function") handle.unref();
  });

/** No operator is known at raise time, and the log says so rather than guessing. */
const UNASSIGNED = "(unassigned)";
/** Nobody ever took it. Distinct from an operator who took it and aborted. */
const NOBODY = "(none)";

const HANDOFF: { readonly phase: "handoff" } = { phase: "handoff" };

/**
 * Raise an intervention, hand the live session over, and take it back.
 *
 * The ordering is the mechanism, and every step of it is observable afterwards:
 *
 *   1. `lease.cede()` — the epoch advances, so any action built before this
 *      moment is now stale and the gate's epoch fence will refuse it.
 *   2. the driver lock is ARMED, before anything is painted anywhere. A banner
 *      that fails to render still leaves the session locked; the reverse order
 *      would leave a window in which the session looks handed over and is not.
 *   3. the request is completed from the journal's own cede entry and raised,
 *      racing the TTL.
 *   4. the lock is cleared and control returns — `reclaim()` when a person
 *      answered, `expire()` when nobody did.
 *
 * NO TRANSPORT ATTACHED IS A NORMAL CASE. A run configured without an operator
 * channel still cedes and immediately expires, and reports `timeout`. "A person
 * was required and nobody was reachable" is honestly an escalation timeout; the
 * alternative — declining to cede at all — would record an intention nobody can
 * audit and would leave the epoch un-advanced, so a stale action would still be
 * issuable.
 */
export const runEscalation = async (
  draft: InterventionDraft,
  deps: EscalationDeps,
): Promise<EscalationResult> => {
  const { lease, log, transport, ttlMs, now, session } = deps;
  const deadline = deps.deadline ?? wallClockDeadline;

  const journalBefore = lease.transitions.length;
  const pausedFrom = now();
  let emitted = 0;

  lease.cede(`escalation: ${draft.stepRef} requires a human (${draft.ruleId})`);

  const ceded = lease.transitions[journalBefore];
  if (ceded === undefined) {
    throw new Error("escalation: cede() did not journal a transition, so there is no audit of control to build a record from");
  }

  const requestedAt = ceded.at;
  const parsed = Date.parse(requestedAt);
  if (!Number.isFinite(parsed)) {
    throw new Error(`escalation: the control journal stamped "${requestedAt}", which is not an instant a deadline can be derived from`);
  }

  const request: InterventionRequest = {
    ...draft,
    requestedAt,
    // Derived from the journal rather than read from a second clock: a deadline
    // that disagreed with the audit of control would be unfalsifiable.
    deadlineAt: new Date(parsed + ttlMs).toISOString(),
  };

  /**
   * Emitted AT the transition, never drained afterwards. `EventSequencer` stamps
   * `controlOwner` per line from the live lease, so a post-hoc drain would stamp
   * every line of the handoff with whoever held it at the END — the one fact
   * these lines exist to record.
   */
  const transitionLine = (
    event: string,
    operator: string,
    disposition: string,
    expected: string,
    observed: string,
    detail: Readonly<Record<string, unknown>>,
  ): void => {
    emitted += 1;
    log.emit(
      event,
      { as: "operator", operator, disposition },
      { ...HANDOFF, stepRef: request.stepRef, expected, observed, detail },
    );
  };

  transitionLine(
    "handoff.requested",
    UNASSIGNED,
    "requested",
    `a human to take the live session and complete ${request.stepRef} (${request.stepTitle})`,
    `${request.reason} — screen ${request.screen ?? "(unknown)"}`,
    {
      effectiveRisk: request.effectiveRisk,
      ruleId: request.ruleId,
      location: request.location,
      deadlineAt: request.deadlineAt,
      ttlMs,
      screenshot: request.screenshot === undefined ? "none" : `masked:${request.screenshot.maskedRegions}`,
      transport: transport === undefined ? "none attached" : "attached",
    },
  );

  /** Did the driver lock actually arm? Decides which failure the journal names. */
  let armed = false;

  let outcome: HandoffOutcome;
  try {
    /**
     * ARMING LIVES INSIDE THE GUARDED REGION, and that placement is the fix for
     * a real hole rather than tidiness.
     *
     * `lease.cede()` has already run, so control is with the human from here.
     * This line used to sit ABOVE the `try`, which meant a throw out of
     * `beginHumanTurn()` escaped `runEscalation` with the lease still on
     * "human", no `handoff.returned` line, and the emitted-versus-journalled
     * reconciliation below never reached — a one-sided audit of control.
     *
     * Not hypothetical: `beginHumanTurn()` awaits `ensurePlumbing()`, whose
     * `exposeBinding`/`addInitScript` calls reject on a closed or already-torn-
     * down context. Reproduced against the real driver — closing the browser
     * context and then calling it throws
     * `browserContext.exposeBinding: Target page, context or browser has been
     * closed` — so this throws from production code, not only from a stub.
     */
    if (session) {
      await session.beginHumanTurn();
      armed = true;
    }

    outcome =
      transport === undefined
        ? { kind: "timeout" }
        : await Promise.race<HandoffOutcome>([
            transport.raise(request),
            deadline(ttlMs).then((): HandoffOutcome => ({ kind: "timeout" })),
          ]);
  } catch (e) {
    // A transport that THROWS is broken operator plumbing, not a disposition; so
    // is a driver lock that will not arm. The property that must survive either
    // is that the session never stays stuck on a human who is not there, so
    // control is restored and journalled before the error propagates.
    //
    // The clear-up is best-effort ON PURPOSE, and it is the one place that
    // deliberately departs from `endHumanTurn`'s fail-closed ordering. If
    // clearing the banner also fails, the DRIVER stays locked — which is the
    // safe direction, since it keeps refusing automation — but the LEASE must
    // still be restored and journalled, or the audit of control ends on a cede
    // with no matching return. Letting a second failure here mask the first
    // would trade a loud error for a silently stranded lease.
    if (armed && session) await session.endHumanTurn().catch(() => {});
    lease.expire();
    transitionLine(
      "handoff.returned",
      NOBODY,
      armed ? "transport_error" : "arming_error",
      armed ? "the operator channel to answer" : "the driver to lock the session for a human turn",
      e instanceof Error ? e.message : String(e),
      { pausedMs: now() - pausedFrom, epoch: lease.epoch },
    );
    throw e;
  }

  /**
   * THE RETURN LEG NEEDS THE SAME GUARD AS THE ARMING LEG — the same failure,
   * arriving by the other door.
   *
   * `endHumanTurn()` awaits the same `ensurePlumbing()` whose
   * `exposeBinding`/`addInitScript` calls were MEASURED rejecting on a closed or
   * torn-down context. Unguarded here, a throw skipped the `expire`/`reclaim`
   * below and the `handoff.returned` line after it, leaving the lease on "human"
   * with no matching return: precisely the one-sided audit of control that moving
   * the ARMING call inside the `try` was written to remove. The catch above
   * states the property as surviving "either" failure — until this guard existed
   * it survived one, and the operator pressing HAND BACK on a dead context was
   * the uncovered half.
   *
   * The ordering deliberately matches that catch: the DRIVER may stay locked,
   * which is the safe direction since it keeps refusing automation, but the LEASE
   * is restored and journalled before the error propagates.
   */
  if (session) {
    try {
      await session.endHumanTurn();
    } catch (e) {
      lease.expire();
      transitionLine(
        "handoff.returned",
        outcome.kind === "timeout" ? NOBODY : outcome.operator,
        "handback_error",
        "the driver to release the session back to automation",
        e instanceof Error ? e.message : String(e),
        { pausedMs: now() - pausedFrom, epoch: lease.epoch },
      );
      throw e;
    }
  }

  // `reclaim` and `expire` are different events, not two spellings of one: an
  // expiry means nobody resolved anything, and the run must fail with its own
  // kind rather than resuming as though a person had been there.
  if (outcome.kind === "timeout") lease.expire();
  else lease.reclaim(`human handed back: ${outcome.kind}`);

  const pausedMs = now() - pausedFrom;
  const operator = outcome.kind === "timeout" ? NOBODY : outcome.operator;

  transitionLine(
    "handoff.returned",
    operator,
    outcome.kind,
    "control to return to automation",
    outcome.kind === "timeout"
      ? `no operator answered within ${ttlMs}ms`
      : `operator ${operator} ${outcome.kind === "resolved" ? "handed the session back" : "aborted the run"}`,
    { pausedMs, epoch: lease.epoch },
  );

  const added = lease.transitions.length - journalBefore;
  if (emitted !== added) {
    // The journal is a READER here, not decoration: if the handoff log and the
    // audit of control disagree about how many times control moved, one of them
    // is lying and neither can be used as evidence.
    throw new Error(
      `escalation: emitted ${emitted} handoff event(s) but the control journal recorded ${added} transition(s) — the log and the lease disagree about control`,
    );
  }

  const resolvedEntry = lease.transitions[lease.transitions.length - 1];
  if (resolvedEntry === undefined) {
    throw new Error("escalation: the control journal has no closing transition, so the turn cannot be dated");
  }

  const reconstructed: string[] = [];
  if (outcome.kind !== "timeout" && outcome.note !== undefined && outcome.note !== "") {
    // Labelled as REPORTED, not observed. Automation cannot watch a human's
    // hands; conflating what a person says they did with what was measured is
    // exactly what `reconstructedActions` is named to keep visible.
    reconstructed.push(`operator-reported: ${redactText(outcome.note)}`);
  }

  const record: EscalationRecord = {
    stepRef: request.stepRef,
    reason: request.reason,
    requestedAt,
    resolvedAt: resolvedEntry.at,
    disposition: outcome.kind,
    ...(outcome.kind === "timeout" ? {} : { operator: outcome.operator }),
    reconstructedActions: reconstructed,
  };

  return { record, outcome, pausedMs };
};
