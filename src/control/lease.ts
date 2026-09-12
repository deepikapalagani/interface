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
 * An app-side enforcement point — the target application itself refusing a write
 * while a human holds the session — is impossible against this mock, and that is
 * recorded here rather than papered over. MEASURED: the mock has no notion of a
 * holder, a human or a session; every application route is a pure read
 * (mock/main.ts:82-103), nothing anywhere appends to `state.audit`, and its only
 * non-200 is the 404 fallthrough. There is no mutating route for such a point to
 * protect, so claiming one would be describing a system that does not exist.
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
