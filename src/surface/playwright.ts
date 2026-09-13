/**
 * THE ONLY MODULE IN THIS REPO THAT IMPORTS PLAYWRIGHT.
 *
 * Everything above it consumes the Page-free `Surface` interface, which is what
 * makes "a desktop driver would implement this" a claim you can check by reading
 * the import graph rather than a promise in a write-up.
 *
 * Every non-obvious choice here is a measured finding, not a preference:
 *
 *   - `ariaSnapshotJSON({mode:'ai', boxes:true})` is used because it DESCENDS
 *     INTO A FRAMESET; the YAML `ariaSnapshot()` returns 17 characters on the
 *     same page and would have produced a silently empty perception layer.
 *   - Cell text lives in a node's `name`, not in string children.
 *   - Targets resolve by structural anchor FIRST, then the app's own field name,
 *     then role+name — because on this surface role+name matches zero elements,
 *     and the anchor survived both a frame rename and a field rename.
 *   - The dialog recorder QUEUES without accepting or dismissing. With no
 *     listener at all, Playwright auto-dismisses a native confirm(), which
 *     cancels the submit while the click still reports success.
 *
 * ── THE SECOND ENFORCEMENT POINT (§3.6-e) ───────────────────────────────────
 *
 * This class refuses automation actions while a human holds the session, ON ITS
 * OWN ACCOUNT, sharing no state whatsoever with `ControlLease`. Two independent
 * refusals matter because the failure being designed against is two actors
 * driving one session at once: a bug in the lease cannot then produce a
 * double-actor write, because the driver itself still says no.
 *
 * The refusal is UNCONDITIONAL while a turn is armed — it does not consult
 * `ctx.actor`. That is the whole point of a second point rather than a second
 * copy of the first. `ctx.actor` is filled from `lease.holder`
 * (where `runSteps` builds its `ActionContext`), so during a human turn an action the executor issued
 * would arrive self-attributed as `actor: "human"` and a check that trusted the
 * field would wave it straight through.
 *
 * SAID PLAINLY: there is no THIRD, app-side point. The four measurements that
 * used to justify that sentence have ALL expired, and they are corrected here
 * rather than quietly dropped, because every one of them offered read-only-ness
 * as the REASON no third point was possible — so the reason has to be restated
 * now that the application can change. Measured against mock/main.ts, it used to
 * say: every application route is a pure read; it never returns 403 or 409; its
 * only non-200 is the 404 fallthrough; `/__admin/reset` is the sole mutating
 * route. `POST /screen/card-action` now mutates, so the first and the fourth are
 * false. A GET on that same path answers 405 rather than acting — deliberately,
 * so a URL copied out of a log can never re-trigger a state change — which makes
 * the third false too.
 *
 * The conclusion survives on its own terms, which is the point of restating it:
 * the mock still has no notion of a holder, a human or a session, so it cannot
 * refuse a write on the grounds that a person is driving, and this class does not
 * pretend it can. An app that refused a mutating request carrying an automation
 * session token while a human turn was open would make the guarantee survive a
 * bug in BOTH of the points above — the only version of this claim worth anything
 * in a real deployment — and it is NOT built.
 *
 * `src/control/lease.ts` records the same measurement from the other side, so the
 * two halves of the control model agree about what does and does not exist.
 */
import { chromium, type Browser, type BrowserContext, type Dialog, type Frame, type Locator, type Page } from "playwright";
import type { TargetDescriptor } from "../capability/schema.js";
import type { HandbackChannel, HandbackSignal, HumanHands, LiveSession, NoticeTarget } from "./session.js";
import {
  SurfaceRefused,
  type ActionContext,
  type Node,
  type Observation,
  type Resolution,
  type ScreenshotOptions,
  type Surface,
  type SurfaceAction,
  type TargetFacts,
} from "./types.js";

/** Shape of an AI-mode snapshot node, as measured. Playwright types it loosely. */
interface SnapNode {
  role?: string;
  name?: string;
  ref?: string;
  box?: { x: number; y: number; width: number; height: number };
  children?: unknown[];
}

const SCREEN_ID = /\b[A-Z]{2,3}\d{4}\b/;

const digestOf = (s: string): string => {
  // Small, dependency-free, and stable: used only to detect "nothing changed".
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
};

/** What the injected banner script reaches for. Declared so the cast below is narrow. */
interface BannerWindow {
  __meridianNotice?: () => Promise<string | null>;
  __meridianHandback?: (payload: { kind: string; operator: string; note?: string }) => Promise<unknown>;
}

/**
 * THE BANNER, as it runs INSIDE the page.
 *
 * Deliberately self-contained — no reference to any module-scope identifier —
 * because Playwright serialises this function's SOURCE to inject it. A closure
 * over `BANNER_ID` would serialise to a ReferenceError at the far end.
 *
 * It asks Node which text to show rather than deciding for itself, and that is
 * the E5 correction made mechanical: `__meridianNotice` is an `exposeBinding`,
 * so Node receives the CALLING FRAME and answers per-frame. The page never has to
 * work out which frame it is, which is what the width guard got wrong.
 *
 * The one judgement left in the page is a DOM fact rather than a layout one: a
 * `<frameset>` document has no paintable body (`document.body` returns the
 * frameset element itself), so appending there renders nothing. `tagName` is
 * known the instant the element exists, unlike column sizing.
 *
 * Used for BOTH the init-script registration and the immediate repaint of an
 * already-loaded frame, so the two can never drift into two different banners.
 */
const paintBanner = async (): Promise<void> => {
  const ID = "__meridian_operator_banner";
  const render = async (): Promise<void> => {
    try {
      document.getElementById(ID)?.remove();
      const api = (window as unknown as BannerWindow).__meridianNotice;
      if (typeof api !== "function") return;
      const text = await api();
      if (text === null || text === undefined || text === "") return;

      const body = document.body;
      if (!body || body.tagName === "FRAMESET") return;

      const bar = document.createElement("div");
      bar.id = ID;
      bar.setAttribute(
        "style",
        "position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#7E1416;color:#fff;" +
          "font:12px/1.5 Arial,Helvetica,sans-serif;padding:8px 10px;border-bottom:2px solid #000;" +
          "box-shadow:0 2px 6px rgba(0,0,0,.4)",
      );

      const label = document.createElement("span");
      label.textContent = text;
      bar.appendChild(label);

      const button = document.createElement("button");
      button.textContent = "HAND BACK";
      button.setAttribute("style", "margin-left:12px;font:bold 11px Arial,sans-serif;padding:2px 10px;cursor:pointer");
      button.addEventListener("click", () => {
        const handback = (window as unknown as BannerWindow).__meridianHandback;
        if (typeof handback === "function") void handback({ kind: "handed_back", operator: "banner" });
      });
      bar.appendChild(button);

      body.appendChild(bar);
    } catch {
      /* A frame torn down mid-paint is not a failure of the turn. */
    }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => void render());
    return;
  }
  await render();
};

export class PlaywrightSurface implements Surface, LiveSession, HandbackChannel, HumanHands {
  private dialogHandlers: ((message: string) => void)[] = [];
  private pendingDialog: Dialog | null = null;

  /**
   * THE SECOND ENFORCEMENT POINT'S ENTIRE STATE. One boolean, owned here, read
   * only by `act()` and `humanAction()`, and deliberately not derived from
   * anything the lease knows.
   */
  private humanTurn = false;

  private noticeText: string | null = null;
  private noticeTarget: NoticeTarget | null = null;

  /** Set only while a turn is being awaited; nulled by whichever end arrives first. */
  private handback: ((signal: HandbackSignal) => void) | null = null;

  /** `exposeBinding` throws on a second registration of the same name, so this latches. */
  private plumbed = false;

  /**
   * The BrowserContext is deliberately not stored. M4's handoff needs it — E5
   * measured that `addInitScript`, `exposeBinding` and `cookies()` are all
   * context-level — but it is reachable then via `page.context()`, so keeping a
   * field here would be a reference held for a future that has not arrived.
   */
  private constructor(
    private readonly browser: Browser,
    private readonly page: Page,
  ) {}

  static async launch(url: string, opts: { headed: boolean }): Promise<PlaywrightSurface> {
    const browser = await chromium.launch({ headless: !opts.headed });
    const ctx: BrowserContext = await browser.newContext({
      viewport: opts.headed ? null : { width: 1280, height: 900 },
    });
    const page = await ctx.newPage();
    const surface = new PlaywrightSurface(browser, page);

    // Registered BEFORE the first navigation. A queued-but-unhandled dialog
    // blocks the action that raised it, which is what turns an undeclared dialog
    // into a typed hard failure instead of a silent no-op.
    page.on("dialog", (dialog) => {
      surface.pendingDialog = dialog;
      for (const h of surface.dialogHandlers) h(dialog.message());
    });

    // `load`, not `domcontentloaded`, because the target is a FRAMESET.
    //
    // MEASURED 2026-09-12: immediately after `domcontentloaded` the page already
    // has three frames, but none has committed — every one reports an empty
    // `name()` and a blank url. A target hop naming `content`, even with a url
    // pattern as its fallback, therefore matches nothing and `resolveFrame`
    // refuses with "no frame matched". Every other suite hid this by calling
    // `observe()` first, whose aria snapshot awaits long enough for the children
    // to arrive; `tests/handoff.integration.test.ts` acts straight after launch
    // and does not, which is the normal shape for a caller that already holds a
    // resolved target.
    //
    // This is a CONDITION rather than a wait: `load` on a frameset resolves when
    // its children have loaded, so nothing here is an arbitrary sleep of the kind
    // `settle.ts` exists to ban.
    await page.goto(url, { waitUntil: "load" });
    return surface;
  }

  onDialog(handler: (message: string) => void): void {
    this.dialogHandlers.push(handler);
  }

  async observe(): Promise<Observation> {
    const snap = (await this.page.ariaSnapshotJSON({ mode: "ai", boxes: true })) as unknown;
    const nodes: Node[] = [];

    const walk = (n: unknown, framePath: readonly string[]): void => {
      if (Array.isArray(n)) {
        for (const c of n) walk(c, framePath);
        return;
      }
      if (!n || typeof n !== "object") return;
      const node = n as SnapNode;
      const path = node.role === "iframe" ? [...framePath, node.ref ?? "?"] : framePath;
      if (node.role && node.ref) {
        nodes.push({
          role: node.role,
          name: node.name ?? "",
          ref: node.ref,
          ...(node.box ? { box: node.box } : {}),
          framePath: path,
        });
      }
      for (const c of node.children ?? []) walk(c, path);
    };
    walk(snap, []);

    // Enrich the controls a model can actually act on with the two facts that
    // distinguish them on this surface: the app's own field name and the label
    // beside them. Without this the model is choosing between identical-looking
    // `textbox` lines. Only actionable nodes are enriched, and the list is capped,
    // because each one costs a round trip.
    const ACTIONABLE = new Set(["textbox", "button", "link", "combobox", "checkbox", "radio"]);
    const enriched: Node[] = [];
    for (const n of nodes) {
      if (!ACTIONABLE.has(n.role) || enriched.length >= 40) {
        enriched.push(n);
        continue;
      }
      const facts = await this.describe(n.ref).catch(() => null);
      enriched.push(
        facts
          ? {
              ...n,
              framePath: facts.framePath,
              ...(facts.fieldName ? { fieldName: facts.fieldName } : {}),
              ...(facts.anchorText ? { anchorText: facts.anchorText } : {}),
            }
          : n,
      );
    }
    nodes.length = 0;
    nodes.push(...enriched);

    // Visible text, gathered per frame: outcome detection and `text` atoms read this.
    const texts: string[] = [];
    for (const f of this.page.frames()) {
      try {
        texts.push((await f.locator("body").innerText({ timeout: 1000 })).trim());
      } catch {
        /* a frameset document has no body — expected, not an error */
      }
    }
    const text = texts.join("\n");

    return {
      // The live location, so the gate checks where we ACTUALLY are rather than
      // where the run was configured to go.
      location: this.page.url(),
      screen: SCREEN_ID.exec(text)?.[0] ?? null,
      nodes,
      text,
      dialog: this.pendingDialog ? { message: this.pendingDialog.message() } : null,
      digest: digestOf(`${SCREEN_ID.exec(text)?.[0] ?? ""}|${nodes.length}|${text}`),
    };
  }

  /** Walk the frame path: by name, then url pattern, then positional index. */
  private resolveFrame(target: TargetDescriptor): { frame: Frame; degraded: boolean } {
    const frames = this.page.frames();
    let degraded = false;

    for (const hop of target.framePath) {
      if (hop.name) {
        const byName = frames.find((f) => f.name() === hop.name);
        if (byName) return { frame: byName, degraded };
      }
      degraded = true; // the primary hop missed; anything below is a fallback
      if (hop.urlPattern) {
        const re = new RegExp(hop.urlPattern);
        const byUrl = frames.find((f) => re.test(f.url()));
        if (byUrl) return { frame: byUrl, degraded };
      }
      if (hop.index !== undefined) {
        const byIndex = frames[hop.index];
        if (byIndex) return { frame: byIndex, degraded };
      }
    }
    throw new SurfaceRefused("target_unresolvable", `no frame matched the path for ${target.id}`, {
      tried: target.framePath,
      available: frames.map((f) => f.name() || "(main)"),
    });
  }

  private candidate(frame: Frame, kind: string, key: string, role?: string): Locator {
    switch (kind) {
      case "table_anchor":
        // The row holding the label cell, then the control inside that row.
        return frame.locator("tr").filter({ hasText: key }).locator("input, select, textarea, a, button");
      case "field_key":
        return frame.locator(`[name="${key}"]`);
      case "role_name":
        return frame.getByRole((role ?? "button") as Parameters<Frame["getByRole"]>[0], { name: key });
      default:
        throw new SurfaceRefused("target_unresolvable", `unknown strategy kind "${kind}"`);
    }
  }

  async find(target: TargetDescriptor): Promise<Resolution | null> {
    const located = await this.locate(target);
    return located?.resolution ?? null;
  }

  /**
   * MEASURED: refs from `ariaSnapshotJSON` resolve back to the DOM through the
   * `aria-ref=` selector, at both page and frame level. That is what makes
   * minting mechanical — the model names a ref, and the executor (never the
   * model) derives the durable anchors from the live element.
   */
  async describe(ref: string): Promise<TargetFacts | null> {
    const loc = this.page.locator(`aria-ref=${ref}`);
    if ((await loc.count().catch(() => 0)) !== 1) return null;

    const facts = await loc.first().evaluate((el: Element) => {
      const row = el.closest("tr");
      const cells = row ? Array.from(row.querySelectorAll("td")) : [];
      const mine = cells.findIndex((c) => c.contains(el));
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") ?? "",
        fieldName: el.getAttribute("name"),
        // The label cell immediately to the left: on these screens it is the
        // only thing tying a control to what it means.
        anchorText: mine > 0 ? (cells[mine - 1]?.textContent ?? "").trim() : null,
      };
    });

    // Ask the ELEMENT which frame owns it.
    //
    // The previous approach probed each frame with a frame-scoped `aria-ref`
    // selector. Measured: that matches nothing, so every describe() returned an
    // empty frame path, mint() fell back to frame index 0 — the frameset document
    // — and every minted target was then hunted for in the one frame that
    // contains no controls at all. The failure surfaced as "no strategy
    // resolved", which pointed at the strategies rather than at the frame.
    let frameName = "";
    const handle = await loc
      .first()
      .elementHandle()
      .catch(() => null);
    if (handle) {
      const owner = await handle.ownerFrame();
      frameName = owner?.name() ?? "";
      await handle.dispose();
    }

    return { ...facts, framePath: frameName ? [frameName] : [] };
  }

  private async locate(
    target: TargetDescriptor,
  ): Promise<{ locator: Locator; resolution: Resolution } | null> {
    const { frame, degraded: frameDegraded } = this.resolveFrame(target);
    const expected = target.strategies[0]?.kind ?? "table_anchor";
    const attempted: string[] = [];

    for (const [i, strategy] of target.strategies.entries()) {
      const loc = this.candidate(frame, strategy.kind, strategy.key, strategy.role);
      let count = 0;
      try {
        count = await loc.count();
      } catch {
        count = -1;
      }
      attempted.push(`${strategy.kind}(${strategy.key})=${count}`);
      // Exactly one, or we do not act. Ambiguity is a failure, never a guess.
      if (count !== 1) continue;

      const first = loc.first();
      if (target.verify.role || target.verify.nameContains) {
        const ok = await this.verifyElement(first, target);
        if (!ok) continue;
      }
      return {
        locator: first,
        resolution: {
          strategyUsed: strategy.kind,
          strategyExpected: expected,
          matched: 1,
          degraded: frameDegraded || i > 0,
        },
      };
    }
    throw new SurfaceRefused("target_unresolvable", `no strategy resolved ${target.id}`, { attempted });
  }

  /** Re-read the resolved element's own facts before acting on it. */
  private async verifyElement(loc: Locator, target: TargetDescriptor): Promise<boolean> {
    try {
      if (target.verify.role) {
        const tag = (await loc.evaluate((el) => el.tagName.toLowerCase())) as string;
        const looksRight =
          (target.verify.role === "textbox" && tag === "input") ||
          (target.verify.role === "link" && tag === "a") ||
          (target.verify.role === "button" && (tag === "button" || tag === "input"));
        if (!looksRight) return false;
      }
      if (target.verify.nameContains) {
        const text = ((await loc.textContent()) ?? "").trim();
        if (!text.includes(target.verify.nameContains)) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read a value, from a control or from static text.
   *
   * Two paths, because a servicing screen holds both kinds of value and they are
   * read differently:
   *
   *  1. A CONTROL. Resolved through the same `locate()` chain as every other
   *     operation, so a target's ordered strategies apply to reads too. Crucially
   *     a form control's value lives in its `value` PROPERTY — reading
   *     `textContent` off an `<input>` returns "", which is exactly what made the
   *     first end-to-end run fail a postcondition on a field it had just filled.
   *
   *  2. STATIC TEXT. A confirmation number is not an interactive element, so
   *     `locate()` finds nothing; fall back to anchoring the row by its label
   *     cell and reading the NEXT cell — never by column index, which an inserted
   *     column silently corrupts.
   */
  async read(target: TargetDescriptor): Promise<string | null> {
    const found = await this.locate(target).catch(() => null);
    if (found) {
      const tag = (await found.locator.evaluate((el) => el.tagName.toLowerCase())) as string;
      if (tag === "input" || tag === "textarea" || tag === "select") {
        return found.locator.inputValue();
      }
      return ((await found.locator.textContent()) ?? "").trim();
    }

    const { frame } = this.resolveFrame(target);
    const key = target.strategies[0]?.key ?? "";
    const row = frame.locator("tr").filter({ hasText: key });
    if ((await row.count()) !== 1) return null;
    const cells = row.first().locator("td");
    const n = await cells.count();
    for (let i = 0; i < n - 1; i++) {
      const label = ((await cells.nth(i).textContent()) ?? "").trim();
      if (label.includes(key)) {
        return ((await cells.nth(i + 1).textContent()) ?? "").trim();
      }
    }
    return null;
  }

  /** THE CHOKEPOINT. Every state change in the target system passes through here. */
  async act(action: SurfaceAction, _ctx: ActionContext): Promise<Resolution | null> {
    // THE SECOND ENFORCEMENT POINT. Checked before the target is even located, so
    // a refused action cannot have touched the page at all — the same bar
    // tests/gate.test.ts:97-103 holds the first point to.
    if (this.humanTurn) {
      throw new SurfaceRefused(
        "control_violation",
        `the driver is locked: a human holds this session, so automation may not ${action.kind}`,
        { point: "driver", action: action.kind },
      );
    }
    return this.perform(action);
  }

  /**
   * The single implementation of every verb, shared by `act()` and `humanAction()`.
   *
   * Shared deliberately. If the human's door carried its own copy, the scripted
   * operator would be exercising a second code path and would stop proving
   * anything about the one automation actually takes.
   */
  private async perform(action: SurfaceAction): Promise<Resolution | null> {
    switch (action.kind) {
      case "press":
        await this.page.keyboard.press(action.key);
        return null;
      case "accept_dialog": {
        const d = this.pendingDialog;
        if (!d) throw new SurfaceRefused("target_unresolvable", "no dialog is pending");
        this.pendingDialog = null;
        await d.accept();
        return null;
      }
      case "dismiss_dialog": {
        const d = this.pendingDialog;
        if (!d) throw new SurfaceRefused("target_unresolvable", "no dialog is pending");
        this.pendingDialog = null;
        await d.dismiss();
        return null;
      }
      case "fill": {
        const found = await this.locate(action.target);
        if (!found) return null;
        await found.locator.fill(action.value);
        return found.resolution;
      }
      case "click":
      case "navigate": {
        const found = await this.locate(action.target);
        if (!found) return null;
        await found.locator.click();
        return found.resolution;
      }
    }
  }

  async screenshot(options: ScreenshotOptions): Promise<Uint8Array> {
    const masks: Locator[] = [];
    for (const t of options.mask) {
      const found = await this.locate(t).catch(() => null);
      if (found) masks.push(found.locator);
    }
    // Fail closed: if a region we promised to hide did not resolve, emit nothing
    // rather than an image that leaks it.
    if (options.failClosed && masks.length !== options.mask.length) {
      throw new SurfaceRefused(
        "policy_denied",
        `refusing to capture: ${options.mask.length - masks.length} of ${options.mask.length} masked regions did not resolve`,
      );
    }
    return this.page.screenshot({ mask: masks, maskColor: "#000000" });
  }

  /* ------------------------------------------ §3.6: the same live session */

  /**
   * ARM FIRST, PAINT SECOND.
   *
   * The lock is set here; the banner is painted by a separate `notice()` call
   * afterwards. That ordering is the fail-closed one — a banner that fails to
   * render still leaves a locked session, whereas arming after painting would
   * open a window in which the operator can see "you have control" and
   * automation can still act.
   */
  async beginHumanTurn(): Promise<void> {
    this.humanTurn = true;
    // The banner is painted HERE rather than left to the caller, and that is a
    // measured correction rather than a convenience. `runEscalation` knows this
    // object only as a `HumanTurnLock` — begin and end, nothing else — so it
    // never calls `notice()`. With the paint left to the orchestrator, the
    // production path would arm the lock and show the person nothing at all:
    // a session that is silently frozen looks exactly like a session that has
    // hung. A caller with more to say still overwrites this with `notice()`.
    await this.notice(
      "AUTOMATION IS PAUSED — YOU HAVE CONTROL OF THIS SESSION. Complete the step here, then press HAND BACK.",
    );
  }

  /**
   * Clear the banner, THEN the lock — the reverse of `beginHumanTurn`, for the
   * same reason. If the banner cannot be cleared the lock stays set and the run
   * fails loudly, rather than both actors believing they hold the session.
   */
  async endHumanTurn(): Promise<void> {
    await this.notice(null);
    this.humanTurn = false;
  }

  async notice(text: string | null, opts?: NoticeTarget): Promise<void> {
    this.noticeText = text;
    this.noticeTarget = opts ?? null;
    await this.ensurePlumbing();

    // An init script runs on NAVIGATION, so it has not run on the document that
    // is already loaded — which is the one the operator is looking at right now.
    // The live frames are therefore repainted directly, with the same function,
    // so there is only ever one banner implementation.
    for (const frame of this.page.frames()) {
      await frame.evaluate(paintBanner).catch(() => {
        /* A frame that navigated mid-paint will be caught by the init script. */
      });
    }
  }

  /**
   * ARM SYNCHRONOUSLY, PLUMB AFTERWARDS.
   *
   * A `new Promise` executor runs synchronously, so installing the resolver
   * before the first `await` is what makes this method armed by the time it
   * returns. Awaiting `ensurePlumbing()` first yielded control back to the caller
   * with `this.handback` still null, so anything that signalled on the very next
   * line — the console's button, or a test — was told there was nothing waiting.
   *
   * MEASURED: that ordering failed `tests/handoff.integration.test.ts`'s abort
   * case, where the signal follows the await with no intervening tick. It passed
   * in the hand-back case only because a `humanAction` and a poll happened to sit
   * between the two, which is the worst kind of green: the same bug, hidden by
   * timing. A dropped hand-back is indistinguishable from a button that does not
   * work, which is the one failure §3.6 cannot afford.
   */
  async awaitHandback(opts: { readonly timeoutMs: number }): Promise<HandbackSignal> {
    const pending = new Promise<HandbackSignal>((resolve) => {
      const timer = setTimeout(() => {
        this.handback = null;
        resolve({ kind: "timed_out" });
      }, opts.timeoutMs);

      this.handback = (signal) => {
        clearTimeout(timer);
        resolve(signal);
      };
    });

    await this.ensurePlumbing();
    return pending;
  }

  /**
   * THE ONE RESOLUTION PATH. The banner's own button and the operator console's
   * button both arrive here, so the two channels cannot race to deliver
   * different answers: the first to arrive nulls the resolver, and the second is
   * told there was nothing waiting.
   */
  signalHandback(signal: HandbackSignal): boolean {
    const resolve = this.handback;
    if (resolve === null) return false;
    this.handback = null;
    resolve(signal);
    return true;
  }

  /** The mirror of `act()`: refused UNLESS a human turn is armed. */
  async humanAction(action: SurfaceAction): Promise<void> {
    if (!this.humanTurn) {
      throw new SurfaceRefused(
        "control_violation",
        `humanAction(${action.kind}) outside a human turn: this session has not been ceded to anyone`,
        { point: "driver", action: action.kind },
      );
    }
    await this.perform(action);
  }

  /**
   * Register the two bindings and the init script, ONCE per context.
   *
   * Lazy rather than done at launch, and that is a determinism decision as much
   * as a tidy one: a run that never escalates registers nothing at all, so the
   * default replay path — the one `scripts/verify-determinism.ts` diffs byte for
   * byte across two runs — is untouched by this entire mechanism.
   *
   * `exposeBinding` throws on a second registration of the same name, hence the
   * latch rather than an idempotent re-register.
   */
  private async ensurePlumbing(): Promise<void> {
    if (this.plumbed) return;
    this.plumbed = true;

    const context: BrowserContext = this.page.context();

    // Node answers PER FRAME, which is the E5 correction made mechanical: the
    // binding hands us the calling frame, so the choice is made here with
    // `frame.name()` and `frame.url()` in hand rather than guessed in the page.
    await context.exposeBinding("__meridianNotice", (source) => this.noticeFor(source.frame));

    await context.exposeBinding("__meridianHandback", (_source, payload: unknown) => {
      const p = (payload ?? {}) as { kind?: unknown; operator?: unknown; note?: unknown };
      const note = typeof p.note === "string" ? p.note : undefined;
      return this.signalHandback({
        kind: p.kind === "aborted" ? "aborted" : "handed_back",
        operator: typeof p.operator === "string" ? p.operator : "banner",
        ...(note === undefined ? {} : { note }),
      });
    });

    await context.addInitScript(paintBanner);
  }

  /**
   * WHICH FRAME GETS THE BANNER — decided in Node, for the reason
   * DECISIONS.md:74-79 records.
   *
   * Name then url pattern, mirroring `resolveFrame` below, because a hardcoded
   * name breaks on tenant B, whose `tenantB` config renames content/nav to
   * main/sidebar (mock/tenant.ts).
   *
   * The fallback is the case worth stating. If the caller named a frame and some
   * frame on the page matches it, every other frame answers null — one banner,
   * where it was asked for. If NOTHING matches, the name is stale, which is
   * precisely the drift this system expects to meet; a human staring at a session
   * with no banner at all is worse than a banner in two places, so every
   * paintable frame gets one.
   */
  private noticeFor(frame: Frame): string | null {
    if (this.noticeText === null) return null;

    const target = this.noticeTarget;
    if (target === null || (target.frameName === undefined && target.urlPattern === undefined)) {
      return this.noticeText;
    }

    const matches = (f: Frame): boolean =>
      (target.frameName !== undefined && f.name() === target.frameName) ||
      (target.urlPattern !== undefined && new RegExp(target.urlPattern).test(f.url()));

    if (matches(frame)) return this.noticeText;
    return this.page.frames().some(matches) ? null : this.noticeText;
  }

  /**
   * A cheap fingerprint of the LIVE SESSION, so "the human got the same session,
   * not a fresh one" can be asserted mechanically instead of argued.
   *
   * §3.6 fails automatically if a handoff quietly opens a second browser, and
   * that failure is invisible from the outside — a fresh context renders the same
   * screens. Counting what exists is how it becomes visible.
   *
   * Returns plain numbers and a string, so rule 1 of the seam holds: no Playwright
   * type escapes. Deliberately NOT on `LiveSession` — it is a diagnostic about the
   * session, not part of the control transfer, and an adapter that cannot count
   * windows should not be forced to pretend it can.
   */
  sessionFingerprint(): { readonly contexts: number; readonly pages: number; readonly url: string } {
    return {
      contexts: this.browser.contexts().length,
      pages: this.page.context().pages().length,
      url: this.page.url(),
    };
  }

  async close(): Promise<void> {
    // A run torn down mid-escalation would otherwise leave `awaitHandback`
    // pending forever and hang the process. Reported as a timeout, because from
    // the run's point of view that is exactly what happened: nobody resolved it.
    this.signalHandback({ kind: "timed_out" });
    await this.browser.close();
  }
}
