/**
 * THE BINDING DECORATOR — where a tenant's literals become the artifact's symbols.
 *
 * A surface reports what it can actually see: the screen id rendered on the page,
 * `MBR0300`. Every predicate in an artifact asserts a symbol, `MEMBER_SEARCH`.
 * Without something in between, the artifact and the surface simply cannot meet —
 * a precondition would compare "MEMBER_SEARCH" against "MBR0300" and fail on a
 * screen the run is standing on.
 *
 * This is that translation, and it is one line of real work wrapped in a
 * decorator so it applies uniformly: every observation that reaches the engine
 * already speaks symbols, so nothing above this layer ever sees a tenant literal.
 *
 * LAYER ORDER MATTERS:
 *
 *     PlaywrightSurface   (sees MBR0300)
 *       -> BoundSurface   (translates to MEMBER_SEARCH)
 *         -> GatedSurface (enforces policy keyed on SYMBOLS)
 *
 * The gate sits outermost because its per-screen rules are written in symbols —
 * a policy that had to name `MBR0300` would need rewriting per tenant, which is
 * exactly the duplication the binding layer exists to remove.
 *
 * The direction the other way — symbol to literal, for targets — happens once at
 * load time in `resolve()`, not per call. Targets are rewritten before the run
 * starts; only the screen has to be translated live, because only the screen is
 * something the surface discovers rather than something the plan dictates.
 */
import type { Binding } from "../capability/bind.js";
import { canonicalScreen } from "../capability/bind.js";
import type { TargetDescriptor } from "../capability/schema.js";
import type {
  ActionContext,
  Observation,
  Resolution,
  ScreenshotOptions,
  Surface,
  SurfaceAction,
  TargetFacts,
} from "./types.js";

export class BoundSurface implements Surface {
  constructor(
    private readonly inner: Surface,
    private readonly binding: Binding,
  ) {}

  async observe(): Promise<Observation> {
    const raw = await this.inner.observe();
    return {
      ...raw,
      // An unrecognised screen stays null rather than guessing. Classification
      // decides what an unexpected screen means; it has far more context.
      screen: canonicalScreen(this.binding, raw.screen),
    };
  }

  /* ---- everything else is pass-through: targets are already resolved ---- */

  find(target: TargetDescriptor): Promise<Resolution | null> {
    return this.inner.find(target);
  }

  /**
   * Pass-through, deliberately.
   *
   * An earlier version canonicalised these facts into symbols here, and that was
   * a layering mistake: `find()` sits below this decorator and searches real
   * markup, so it was handed a symbol and looked for a `MEMBER_ID` label the page
   * does not have. The surface deals in literals because the DOM does. Symbols
   * are an artifact concern, and the binding translates at the two boundaries
   * where artifacts are read (`resolve`) or written (the compiler) — not in
   * between.
   */
  describe(ref: string): Promise<TargetFacts | null> {
    return this.inner.describe(ref);
  }

  read(target: TargetDescriptor): Promise<string | null> {
    return this.inner.read(target);
  }

  act(action: SurfaceAction, ctx: ActionContext): Promise<Resolution | null> {
    return this.inner.act(action, ctx);
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
