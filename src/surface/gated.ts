/**
 * THE CHOKEPOINT DECORATOR — where both safety claims become true at once.
 *
 * `GatedSurface` implements `Surface` and wraps another `Surface`. Its `act()`
 * runs four checks, in this order:
 *
 *     lease.assertAutomation()   who holds the session
 *          ctx.actor agrees      the caller's view of control matches the lease
 *          ctx.epoch is current  the action was built in the current era
 *       ->  policy.evaluate()  ->  inner.act()
 *
 * That ordering is deliberate. All three control questions are asked BEFORE the
 * permission question, because "who is driving" outranks "this action would be
 * permitted" — while a person holds the session, automation must not act even
 * when the action is entirely legal, and an action built before a handoff must
 * not be issued after it even though the policy would still allow it.
 *
 * The two control checks after `assertAutomation` throw before `onDecision`
 * fires, and that is the point: no policy decision was reached, so no gate
 * decision may be recorded. A gate log line asserting a permission verdict that
 * was never computed would be a fabricated audit entry.
 *
 * Because this is a decorator over the same interface, two claims hold
 * structurally rather than by discipline:
 *
 *   §3.4-b  nothing can act outside the allowlist, because nothing else in the
 *           system holds a driver — `PlaywrightSurface` is private to this chain.
 *   §3.6-e  automation cannot act while a human holds the session, because the
 *           same function refuses.
 *
 * Read paths (`observe`, `find`, `read`, `screenshot`) delegate ungated: they
 * change nothing in the target system, and blocking perception during a handoff
 * would prevent the very re-synchronisation §3.6 requires afterwards.
 */
import type { TargetDescriptor } from "../capability/schema.js";
import { ControlViolation, type ControlLease } from "../control/lease.js";
import { evaluate, type PolicyDecision, type PolicyDocument } from "../policy/policy.js";
import {
  SurfaceRefused,
  type ActionContext,
  type Observation,
  type Resolution,
  type ScreenshotOptions,
  type Surface,
  type SurfaceAction,
  type TargetFacts,
} from "./types.js";

/** Emitted for every gate decision, allowed or not — the audit of the guardrail itself. */
export interface GateEvent {
  readonly stepRef: string | null;
  readonly action: string;
  readonly decision: PolicyDecision;
  readonly holder: string;
}

export class GatedSurface implements Surface {
  constructor(
    private readonly inner: Surface,
    private readonly policy: PolicyDocument,
    private readonly lease: ControlLease,
    private readonly onDecision: (e: GateEvent) => void = () => {},
  ) {}

  /** THE one place an action can be issued. */
  async act(action: SurfaceAction, ctx: ActionContext): Promise<Resolution | null> {
    // 1. Does automation hold the session at all?
    this.lease.assertAutomation(ctx.stepRef);

    // 2. Does the caller agree with the lease about who is driving? A caller that
    //    believes a human is at the keyboard has no business issuing an action,
    //    whatever the lease says: the disagreement itself is the defect, and
    //    silently preferring the lease would hide it.
    if (ctx.actor !== this.lease.holder) {
      throw new ControlViolation(
        `the caller believes ${ctx.actor} is driving while the lease is held by ${this.lease.holder}`,
        { actor: ctx.actor, holder: this.lease.holder, epoch: this.lease.epoch, stepRef: ctx.stepRef },
      );
    }

    // 3. Was this action built in the current era? With one single-threaded
    //    executor this is not fixing an observed bug — it is what makes the
    //    property true BY CONSTRUCTION rather than by an argument about call
    //    ordering, and it is what a second caller would otherwise violate
    //    silently. An action minted before a handoff carries the pre-handoff
    //    epoch, so it cannot be issued into the session the human has since
    //    touched.
    if (!this.lease.isCurrent(ctx.epoch)) {
      throw new ControlViolation(
        `action${ctx.stepRef ? ` for step ${ctx.stepRef}` : ""} was built at epoch ${ctx.epoch} but control has since moved to epoch ${this.lease.epoch}`,
        { expectedEpoch: ctx.epoch, epoch: this.lease.epoch, stepRef: ctx.stepRef },
      );
    }

    // 4. Then policy, on the typed action — not on a coordinate. This is why the
    //    action vocabulary is a closed set: `click(target=MEMBER_ID)` can be
    //    reasoned about, whereas `click(640, 380)` cannot be gated meaningfully.
    const decision = evaluate(this.policy, {
      action: action.kind,
      url: ctx.url,
      screen: ctx.screen,
      ...(ctx.field === undefined ? {} : { field: ctx.field }),
      claimedRisk: ctx.risk,
    });

    this.onDecision({ stepRef: ctx.stepRef, action: action.kind, decision, holder: this.lease.holder });

    if (!decision.allow) {
      throw new SurfaceRefused("policy_denied", decision.reason, {
        dimension: decision.dimension,
        ruleId: decision.ruleId,
        effectiveRisk: decision.effectiveRisk,
        riskDrift: decision.riskDrift,
        // The executor routes `human` to escalation rather than to a hard failure:
        // "this needs a person" is a different outcome from "this is forbidden".
        requires: decision.requires,
        stepRef: ctx.stepRef,
      });
    }

    return this.inner.act(action, ctx);
  }

  /* ---- read paths delegate: they mutate nothing and must survive a handoff ---- */

  observe(): Promise<Observation> {
    return this.inner.observe();
  }

  find(target: TargetDescriptor): Promise<Resolution | null> {
    return this.inner.find(target);
  }

  describe(ref: string): Promise<TargetFacts | null> {
    return this.inner.describe(ref);
  }

  read(target: TargetDescriptor): Promise<string | null> {
    return this.inner.read(target);
  }

  onDialog(handler: (message: string) => void): void {
    this.inner.onDialog(handler);
  }

  screenshot(options: ScreenshotOptions): Promise<Uint8Array> {
    return this.inner.screenshot(options);
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}
