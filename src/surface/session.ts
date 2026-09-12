/**
 * THE LIVE-SESSION SEAM — a person taking the wheel of a run already in flight.
 *
 * §3.6's hard requirement is that the human operates THE SAME LIVE SESSION, not a
 * fresh one. That is a property of the DRIVER, not of the recorded flow: it is the
 * browser context, its cookies, its open page and its scroll position that must
 * survive the turn. So it lives beside `Surface` rather than inside it.
 *
 * ── WHY THIS IS NOT PART OF `Surface` ───────────────────────────────────────
 *
 * MEASURED, not assumed (`grep -rn 'implements Surface' src tests`): `Surface`
 * has NINE implementers — three real (`PlaywrightSurface`, `BoundSurface`,
 * `GatedSurface`) and six test stubs (tests/gate.test.ts:21, predicate.test.ts:39,
 * classify.test.ts:26, discover-executor.test.ts:55, outcome-signal.test.ts:126,
 * discover-loop.test.ts:71). Widening `Surface` would force all six of those
 * unrelated files to grow dead methods they would never call, and would put a
 * human-turn API on the interface a desktop or 5250 adapter has to implement.
 *
 * Nothing that consumes `Surface` needs any of this. The executor drives steps;
 * the gate enforces policy; neither has a reason to paint a banner. Exactly one
 * caller — the CLI, which constructs the driver — needs a `LiveSession`, and it
 * already holds the concrete driver. A capability the whole system must carry to
 * serve one caller is a capability in the wrong place.
 *
 * ── RULE 1 OF THE SEAM STILL HOLDS ──────────────────────────────────────────
 *
 * No driver type escapes. There is no `Page`, no `Frame`, no `(page) => ...`
 * callback here. A frame is named the way `FrameHop` already names one
 * (capability/schema.ts:99-103) — by name, then by url pattern — so a desktop
 * adapter would address a window the same way it addresses one for targeting,
 * and the operator console never learns what is driving the session.
 *
 * ── THE THREE INTERFACES, AND WHY THEY ARE THREE ────────────────────────────
 *
 * `LiveSession` is the control-transfer contract proper. `HandbackChannel` and
 * `HumanHands` are deliberately SEPARATE rather than folded in, because they have
 * different callers and different lifetimes: the console presses one, CI scripts
 * the other, and a production run with a real person uses neither. Keeping them
 * apart means an implementer can support the control transfer without pretending
 * to supply a hand.
 */
import type { SurfaceAction } from "./types.js";

/**
 * How a human turn ended.
 *
 * Three kinds, because these are the three things that can actually happen and
 * they map onto three different run outcomes: the person finished the step, the
 * person gave up, or nobody came. Collapsing the last two would tell a caller
 * that an unattended escalation and a deliberate abort mean the same thing.
 */
export type HandbackSignal =
  | { readonly kind: "handed_back" | "aborted"; readonly operator: string; readonly note?: string }
  | { readonly kind: "timed_out" };

/**
 * Which frame a notice is painted into, chosen FROM NODE.
 *
 * This is the one correction the E5 spike produced (DECISIONS.md:66-79). The
 * obvious implementation puts a width guard inside the injected script and lets
 * the page decide which frame is "the big one". MEASURED: at `addInitScript` time
 * a frameset's column sizing is not yet applied, so every frame reports the same
 * width and the guard misfires. The choice therefore has to be made in Node,
 * where `frame.name()` and `frame.url()` are already known.
 *
 * Both fields are optional and tried in the order `resolveFrame` already uses —
 * name, then url pattern — because a hardcoded name breaks on tenant B, which
 * renames `content`/`nav` to `main`/`sidebar` (mock/tenant.ts:82-83).
 */
export interface NoticeTarget {
  readonly frameName?: string;
  readonly urlPattern?: string;
}

/**
 * A session a human can be handed and can hand back.
 *
 * Four methods, and the ordering between them is load-bearing:
 * `beginHumanTurn()` ARMS the refusal before `notice()` paints anything, so a
 * banner that fails to render still leaves the session locked. Fail-closed is the
 * only safe direction here — the failure mode being designed against is two
 * actors driving one session at once.
 */
export interface LiveSession {
  /**
   * Lock the session against automation. Independent of `ControlLease`: this is
   * the driver refusing on its own account, so a bug in the lease cannot produce
   * a double-actor write.
   */
  beginHumanTurn(): Promise<void>;

  /** Release the lock. Clears AFTER the banner is removed, for the same fail-closed reason. */
  endHumanTurn(): Promise<void>;

  /** Paint (or with `null`, remove) the operator banner. Survives navigation. */
  notice(text: string | null, opts?: NoticeTarget): Promise<void>;

  /**
   * Block until the person hands back, aborts, or the TTL elapses.
   *
   * The TTL is a parameter rather than a policy constant because the run owns the
   * budget: an escalation that never times out is an escalation that can hang a
   * production worker forever.
   */
  awaitHandback(opts: { readonly timeoutMs: number }): Promise<HandbackSignal>;
}

/**
 * The in-process door a MOCKED operator console presses to end the turn.
 *
 * §3.6 permits the operator UI to be mocked but requires the transfer itself to
 * be real, and this is the line between the two: the console is a crude HTML page
 * with two buttons, but pressing one resolves the very promise the run is blocked
 * on. There is exactly ONE resolution path — the banner's own button and the
 * console's button both arrive here — so the two channels cannot race to deliver
 * different answers.
 *
 * Separate from `LiveSession` because the run never calls it and the console
 * never calls anything else.
 */
export interface HandbackChannel {
  /**
   * Resolve a waiting turn. Returns whether one was actually waiting, so a
   * console can report "nothing to hand back" instead of silently doing nothing.
   */
  signalHandback(signal: HandbackSignal): boolean;
}

/**
 * A SCRIPTED stand-in for a hand on the mouse.
 *
 * SAID PLAINLY, because it is the one place this component could be mistaken for
 * more than it is: a real human does not call this. A real human clicks in the
 * headed browser, and the automation cannot observe that at all — which is
 * exactly why `EscalationRecord.reconstructedActions` is named the way it is
 * (contract/result.ts:118-123).
 *
 * It exists so the control transfer can be proven in CI with no person present.
 * The alternative — a "human" that returns a canned outcome without touching the
 * session — would prove nothing whatsoever about same-session transfer, which is
 * the single property §3.6 turns on. So the scripted operator drives the REAL
 * driver, and the only thing simulated is who supplies the input.
 *
 * It is the exact mirror of `Surface.act()`: `act()` is refused WHILE a human
 * turn is armed, and this is refused UNLESS one is. Neither actor can use the
 * other's door.
 */
export interface HumanHands {
  /**
   * Perform one action as the person holding the session.
   *
   * Reuses the closed `SurfaceAction` vocabulary rather than inventing a second
   * one: a human turn that could express actions the artifact cannot would be a
   * hole in the policy model, since the gate reasons over exactly these verbs.
   */
  humanAction(action: SurfaceAction): Promise<void>;
}
