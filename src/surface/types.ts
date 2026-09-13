/**
 * THE SURFACE SEAM — how we perceive and act, kept separate from the recorded flow.
 *
 * This is §3.7-b's answer written as code rather than claimed in prose: nothing
 * here mentions a browser. A desktop driver over the OS accessibility tree, or a
 * terminal driver over a 5250 screen buffer, implements this same interface and
 * every layer above it — the executor, the artifact, the policy gate — is
 * unchanged.
 *
 * Two rules keep the seam real:
 *
 *  1. NO DRIVER TYPE ESCAPES. There is no `page`, no `Locator`, no callback of
 *     the form `(page) => ...`. The moment a caller can reach a Playwright
 *     object, the abstraction is decorative and a desktop adapter becomes
 *     impossible. `PlaywrightSurface` is the only module in the repo allowed to
 *     import playwright.
 *
 *  2. ONE CHOKEPOINT. Every action goes through `act()`. That is what lets a
 *     single decorator enforce both the allowlist (§3.4-b) and the control lease
 *     (§3.6-e) — nothing can act outside the policy because nothing else holds a
 *     driver.
 */
import type { RiskClass, TargetDescriptor } from "../capability/schema.js";

/** A perceived control or piece of content. Mirrors what an accessibility tree offers. */
export interface Node {
  readonly role: string;
  /** The accessible name. On a servicing grid this IS member data — treat as sensitive. */
  readonly name: string;
  /**
   * A within-snapshot handle, valid only until the surface changes. NEVER
   * persisted into an artifact: a ref that replays today breaks tomorrow.
   */
  readonly ref: string;
  readonly box?: { x: number; y: number; width: number; height: number };
  /**
   * Frame path as resolved at observation time, outermost first.
   *
   * MIXED CONTENT, deliberately stated rather than glossed: `observe()` builds
   * this from the snapshot walk, which can only push a frame's REF, and then
   * overwrites it with a real frame NAME for the actionable nodes it enriches.
   * So an enriched node carries a name and an unenriched one carries a ref.
   * Nothing consumes it as a durable target — `describe()` is what mints those,
   * and it reads the owning frame's name directly — so the mixture is a display
   * concern, not a targeting one.
   */
  readonly framePath: readonly string[];
  /**
   * The app's own field name, and the label beside the control.
   *
   * Optional because a surface may not be able to supply them, but on a legacy
   * screen they are the ONLY way to tell two controls apart: accessible names
   * here are empty, so a model shown just `textbox` cannot distinguish the nav
   * frame's quick-lookup box from the member-id field it actually wants. That is
   * not a hypothetical — it picked the wrong one.
   */
  readonly fieldName?: string;
  readonly anchorText?: string;
}

/** One perception of the surface: what a human operator would see right now. */
export interface Observation {
  /**
   * Where the surface currently IS, in whatever terms the adapter speaks: a URL
   * for a browser, a window or application path for a desktop driver.
   *
   * This is deliberately not called `url`. It exists because the policy gate
   * checks origins and routes per action, and that check has to run against the
   * LIVE location rather than the configured target — otherwise a redirect to an
   * off-allowlist origin would sail straight through the allowlist (§3.4-b).
   */
  readonly location: string;
  /** The app's own screen identifier, canonicalised to a symbol via the binding. */
  readonly screen: string | null;
  readonly nodes: readonly Node[];
  /** Full visible text, used by `text` atoms and by outcome detection. */
  readonly text: string;
  /** A queued native dialog, if one is blocking. Absent from the DOM and from screenshots. */
  readonly dialog: { readonly message: string } | null;
  /** Stable digest of the observation, for no-progress detection during discovery. */
  readonly digest: string;
}

/** What an action asks the surface to do. A closed set mirroring the artifact's verbs. */
export type SurfaceAction =
  | { readonly kind: "navigate"; readonly target: TargetDescriptor }
  | { readonly kind: "click"; readonly target: TargetDescriptor }
  | { readonly kind: "fill"; readonly target: TargetDescriptor; readonly value: string }
  | { readonly kind: "press"; readonly key: string }
  | { readonly kind: "accept_dialog" }
  | { readonly kind: "dismiss_dialog" };

/**
 * Why an action is being taken, and where — carried for the gate and the event log.
 *
 * `url` and `screen` are supplied by the caller rather than re-perceived by the
 * gate. The executor has just evaluated this step's preconditions, so it already
 * knows where it is; making the gate observe again would cost a full perception
 * round-trip on every single action to learn something already in hand.
 */
export interface ActionContext {
  readonly stepRef: string | null;
  readonly risk: RiskClass;
  /**
   * Who the CALLER believes is driving. Not the gate's source of truth — the
   * lease is — which is exactly why it is carried: the gate refuses when the two
   * disagree, so a caller working from a stale view of control cannot act on it.
   */
  readonly actor: "automation" | "human";
  /**
   * The lease epoch as it stood when this action was BUILT. The gate refuses the
   * action if control has transitioned since.
   *
   * REQUIRED, deliberately. An optional fence is one a caller can forget, and a
   * fence that is silently absent on the one path that needed it is worse than
   * none: it reads as enforcement in every review and enforces nothing.
   */
  readonly epoch: number;
  /**
   * Where the action is issued FROM — the location the surface already occupies,
   * filled from `observation.location`.
   *
   * NOT where the action lands, and the difference is the whole honesty of the
   * allowlist claim. No verb in `SurfaceAction` carries a destination: `click`
   * and `navigate` both name a control, and where that control takes the session
   * is the application's business, not the plan's. So the gate can only ask "is
   * the agent permitted to be acting here", never "is it permitted to go there".
   *
   * CONSEQUENCE, stated plainly: a click that navigates to an off-allowlist
   * origin is NOT refused at the moment it is issued. It is caught on the NEXT
   * action, because that one is gated on the new location — which is exactly why
   * this is re-read per action from the live surface rather than taken once from
   * the configured target. One action's worth of exposure is the real bound, and
   * `types.ts` above says why perception is not re-run inside the gate to narrow it.
   */
  readonly url: string;
  /** Canonical screen SYMBOL, for per-screen rules. Null when it cannot be read. */
  readonly screen: string | null;
  /** The field being filled, for per-field rules. */
  readonly field?: string;
}

/** How a target resolved — the drift signal, surfaced on every action. */
export interface Resolution {
  readonly strategyUsed: string;
  readonly strategyExpected: string;
  readonly matched: number;
  /** True when any strategy after the first won. Logged as `degraded: true` (§3.7-d). */
  readonly degraded: boolean;
}

export interface ScreenshotOptions {
  /**
   * Regions to black out AT CAPTURE TIME. Masking after the fact is not an
   * option — a captured PNG of a servicing screen already contains the PAN.
   */
  readonly mask: readonly TargetDescriptor[];
  /** Fail rather than emit an unmasked image if the mask count does not match. */
  readonly failClosed: boolean;
}

/**
 * Durable facts about one control, derived at RECORD time from a within-turn ref.
 *
 * This is the raw material for minting a `TargetDescriptor`. A snapshot ref is
 * valid only until the surface changes, so it is never persisted — instead the
 * executor resolves it once, harvests the facts below, and records those.
 *
 * MEASURED: on a legacy servicing screen the accessible name is empty, so the
 * two useful facts are the nearest label cell in the same row (which becomes the
 * structural anchor) and the app's own form-field name (the frame-scoped
 * fallback). A desktop adapter would derive the same pair from UIA or AX.
 */
export interface TargetFacts {
  readonly tag: string;
  readonly role: string;
  /** The app's own form-field name, where it has one. */
  readonly fieldName: string | null;
  /**
   * The structural anchor: whichever cell carries the TENANT-BOUND LABEL.
   *
   * Not simply "the nearest preceding label cell", which is what this said until
   * both readings were measured and each was found wrong on one screen. In a
   * two-cell label/value row it IS the preceding cell; in a wider data grid the
   * preceding cell holds row DATA and the label rides on the control's own text.
   * `PlaywrightSurface.factsOf` documents the measurement behind the split.
   */
  readonly anchorText: string | null;
  /** Which frame it lives in, outermost first. */
  readonly framePath: readonly string[];
}

/**
 * Raised when an action is refused, carrying WHICH refusal it was.
 *
 * `dialog_blocking` is the driver noticing a queued native dialog before it
 * touches the page. It exists because the alternative is measurably worse: with
 * a dialog queued, `locator.click` does not fail, it BLOCKS — measured against
 * the mock, 30s to a Playwright `TimeoutError` that escapes the engine untyped.
 *
 * WHAT CONSUMERS DO WITH IT, so the name does not promise more than it buys:
 * `src/replay/executor.ts` maps every reason except `target_unresolvable` onto
 * the `policy_denied` failure kind, so a refusal raised here does NOT surface as
 * `undeclared_dialog`. That kind is produced from the OBSERVATION instead —
 * `observe()` reports the pending dialog, and `classify()` names it — which is
 * the path the engine actually takes, because `observe()` is what runs at a
 * step's pre- and postcondition. This refusal is the second line: it stops a
 * caller that reaches for the page anyway (discovery, a scripted operator, a
 * library caller) from hanging on it.
 */
export class SurfaceRefused extends Error {
  constructor(
    readonly reason: "policy_denied" | "control_violation" | "target_unresolvable" | "dialog_blocking",
    message: string,
    readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "SurfaceRefused";
  }
}

/**
 * The whole contract between the system and whatever it is driving.
 *
 * Deliberately small: eight methods is the entire vocabulary an adapter must
 * supply, which is what makes "a desktop driver would implement this" a credible
 * claim rather than an aspiration.
 */
export interface Surface {
  /** Perceive the current state. The only way anything learns what is on screen. */
  observe(): Promise<Observation>;

  /** Resolve a recorded descriptor, without acting. Used by predicates and the verify gate. */
  find(target: TargetDescriptor): Promise<Resolution | null>;

  /**
   * Harvest durable facts about whatever a within-turn ref points at.
   *
   * This is the record-time half of targeting: discovery hands over a ref, and
   * the executor turns it into a descriptor that will still resolve next month.
   * It lives on the interface because minting must work for any surface — a
   * desktop driver implements it over the OS accessibility tree.
   */
  describe(ref: string): Promise<TargetFacts | null>;

  /** Read a value from a resolved target — the source of declared outputs. */
  read(target: TargetDescriptor): Promise<string | null>;

  /**
   * THE CHOKEPOINT. Every state change in the target system passes through here,
   * which is why the gate can be enforced in exactly one place.
   */
  act(action: SurfaceAction, ctx: ActionContext): Promise<Resolution | null>;

  /** Install the dialog recorder. Must be called before the first action: with no
   *  listener a native confirm() is auto-dismissed and the action reports success
   *  while the app did nothing. */
  onDialog(handler: (message: string) => void): void;

  /** Capture evidence, redacted at capture time. */
  screenshot(options: ScreenshotOptions): Promise<Uint8Array>;

  /** Release the underlying driver. */
  close(): Promise<void>;
}
