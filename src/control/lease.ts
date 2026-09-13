/**
 * THE CONTROL LEASE — who may act on the live session, enforced rather than labelled.
 *
 * §3.6 requires that a human can take over the SAME session and hand it back,
 * and that there is "a way to know who is (or should be) in control". A status
 * field satisfies the second half and none of the first: what makes control real
 * is that an action by the wrong actor FAILS.
 *
 * This object is ONE enforcement point, consulted at the single surface
 * chokepoint (`GatedSurface.act`), which asks it three independent questions
 * before any action is issued:
 *
 *   1. `assertAutomation` — does automation hold the lease at all?
 *   2. `holder`           — does the caller's own view of control agree with it?
 *   3. `isCurrent`        — was this action built in the current era, or before a
 *                           handoff that has happened since?
 *
 * Three rather than one because they catch different defects: (1) a run that kept
 * going after ceding, (2) a caller reasoning from a stale view of who is driving,
 * (3) an action that was legal when it was BUILT and is not legal now. The epoch
 * is what makes a stale holder harmless: an action captured before a handoff
 * cannot be issued into the session afterwards, because its epoch no longer
 * matches.
 *
 * ── THE THIRD POINT, WHICH IS NOT BUILT ─────────────────────────────────────
 *
 * An app-side enforcement point — the target application itself refusing a write
 * while a human holds the session — is NOT implemented. This paragraph exists so
 * that stays visible: an earlier version of it claimed a second point lived "in
 * the mock itself, which refuses mutating requests while a human holds the
 * session", which was measurably false and was removed. Nothing here re-asserts
 * it.
 *
 * What changed is the PREMISE, not the conclusion, and the difference matters
 * because the old premise was doing the arguing. It used to read: every
 * application route is a pure read, nothing appends to the audit trail, so there
 * is no mutating route for such a point to protect. All three clauses are now
 * false — `POST /screen/card-action` mutates, and `mock/actions.ts` appends an
 * audit row for every attempt against a real membership, refusals included. So
 * there is finally something for a third point to protect.
 *
 * It is still not built, now for the honest reason rather than the accidental
 * one: the mock has no notion of a holder, a human or a session, so it cannot
 * refuse anything on those grounds. What it records instead is the AUTHORITY a
 * request carried, never who was at the keyboard — a row is attributed `HUMAN`
 * iff the request carried a supervisor override code. That is an assumption
 * about the deployment (only a supervisor holds that code), not an enforcement,
 * and it is worth exactly what such an assumption is worth.
 *
 * A real third point would refuse a mutating request bearing an AUTOMATION
 * session token while a human turn is open. That is the only version of the
 * claim that survives a bug in BOTH points above, and it needs the application
 * to model a session — which this one does not.
 */
import { SurfaceRefused } from "../surface/types.js";

export type Actor = "automation" | "human";

export interface LeaseTransition {
  readonly at: string;
  readonly from: Actor;
  readonly to: Actor;
  readonly epoch: number;
  readonly reason: string;
}

export class ControlViolation extends SurfaceRefused {
  constructor(message: string, detail?: Readonly<Record<string, unknown>>) {
    super("control_violation", message, detail);
    this.name = "ControlViolation";
  }
}

export class ControlLease {
  private owner: Actor = "automation";
  private epochCounter = 0;
  private readonly journal: LeaseTransition[] = [];

  constructor(private readonly now: () => string) {}

  get holder(): Actor {
    return this.owner;
  }

  get epoch(): number {
    return this.epochCounter;
  }

  /** Every transition is recorded; the journal is the §3.6-d audit of control itself. */
  get transitions(): readonly LeaseTransition[] {
    return this.journal;
  }

  /**
   * Called at the single surface chokepoint before any action. This is the whole
   * enforcement mechanism: if automation does not hold the lease, it cannot act.
   */
  assertAutomation(stepRef: string | null): void {
    if (this.owner !== "automation") {
      throw new ControlViolation(
        `automation attempted to act while the human holds the session${stepRef ? ` (step ${stepRef})` : ""}`,
        { holder: this.owner, epoch: this.epochCounter, stepRef },
      );
    }
  }

  /** Hand the live session to a person. Automation must not act after this returns. */
  cede(reason: string): number {
    if (this.owner === "human") throw new ControlViolation("control has already been ceded", { epoch: this.epochCounter });
    this.transition("human", reason);
    return this.epochCounter;
  }

  /** Take the session back after the human signals they are done. */
  reclaim(reason: string): number {
    if (this.owner === "automation") throw new ControlViolation("automation already holds control", { epoch: this.epochCounter });
    this.transition("automation", reason);
    return this.epochCounter;
  }

  /**
   * The escalation TTL expired. Distinct from `reclaim` because the outcome is
   * different: nobody resolved anything, and the run must fail with its own
   * failure kind rather than silently continuing.
   */
  expire(): number {
    if (this.owner === "automation") return this.epochCounter;
    this.transition("automation", "escalation_timeout");
    return this.epochCounter;
  }

  /** True when an epoch captured earlier is still the current one. */
  isCurrent(epoch: number): boolean {
    return epoch === this.epochCounter;
  }

  private transition(to: Actor, reason: string): void {
    const from = this.owner;
    this.owner = to;
    this.epochCounter += 1;
    this.journal.push({ at: this.now(), from, to, epoch: this.epochCounter, reason });
  }
}
