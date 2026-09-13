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
 * over a module-level `BANNER_ID` would serialise to a ReferenceError at the far
 * end.
 *
 * ── WHY THIS FUNCTION IS FLAT ───────────────────────────────────────────────
 *
 * IT IS FLAT BECAUSE A NESTED ONE DID NOT RENDER AT ALL, and that is measured,
 * not feared. This body used to declare `const render = async () => {...}` and
 * call it. Every npm script in this repo runs through `tsx`, whose esbuild
 * `keepNames` transform rewrites any function assigned to a binding as
 * `__name(async () => {...}, "render")` so the function keeps its `.name`.
 * `__name` is an esbuild module-scope helper. It does not exist in the page. So
 * the serialised source referenced an identifier the browser had never heard of
 * and BOTH injection paths died with `ReferenceError: __name is not defined` —
 * `frame.evaluate` here and `addInitScript` below — leaving the operator looking
 * at a frozen browser with no banner and no HAND BACK button.
 *
 * Confirmed two ways: `esbuild.transformSync(..., {keepNames: true})` on this
 * file emitted `const render = __name(async () => {...}, "render")`, and running
 * the real entry point reported the banner absent in all three frames.
 *
 * The rule this leaves behind, which the next person must keep: NOTHING IN HERE
 * MAY BE A NAMED FUNCTION. Inline callbacks are fine — an arrow in argument
 * position gets no inferred name, so esbuild leaves it alone — but the moment
 * any part of this body is hoisted into a `const fn = ...`, the banner silently
 * stops rendering again. The original comment defended against the author's own
 * identifiers; it was the transpiler that injected one.
 *
 * NO try/catch, ALSO ON PURPOSE. Failures now propagate to `notice()`, which
 * LOGS them per frame. The version that swallowed everything here is what let
 * the ReferenceError above go unnoticed for the life of the feature, while its
 * comment blamed a frame navigating mid-paint.
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

  if (document.readyState === "loading") {
    await new Promise<void>((resolve) => {
      document.addEventListener("DOMContentLoaded", () => resolve(), { once: true });
    });
  }

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
};

export class PlaywrightSurface implements Surface, LiveSession, HandbackChannel, HumanHands {
  private dialogHandlers: ((message: string) => void)[] = [];
  private pendingDialog: Dialog | null = null;

  /**
   * Woken the instant a native dialog is queued, so a page call already in
   * flight can stop waiting on something that can no longer complete.
   *
   * This is the in-flight half of the dialog problem. `pendingDialog` covers the
   * case where one is ALREADY queued when we are asked to act; this covers the
   * case where the action itself raises it — an `onsubmit` confirm() — where the
   * click never returns and Playwright's own 30s default is the only thing that
   * ends the wait.
   */
  private dialogWaiters: (() => void)[] = [];

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

  /**
   * One latch per registration, each set only AFTER that registration succeeds.
   *
   * Three rather than one boolean because a partial failure has to be resumable:
   * `exposeBinding` throws on a second registration of the same name, so a retry
   * must skip exactly the pieces that already landed and re-attempt only the rest.
   */
  private noticeBound = false;
  private handbackBound = false;
  private initScriptAdded = false;

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
      // Wake anything blocked on a page call this dialog has just made
      // uncompletable, BEFORE the message handlers run: a handler is free to
      // take its time, and the waiter is what stops a 30s hang.
      for (const wake of surface.dialogWaiters.splice(0)) wake();
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

  /**
   * What the surface reports while a native dialog holds the page.
   *
   * MEASURED, and the reason this exists at all: with a dialog queued,
   * `ariaSnapshotJSON` does not return a partial view, it BLOCKS — 30s to a
   * Playwright `TimeoutError` that `settle()` does not catch and that therefore
   * escapes `replay()` untyped. `observe()` compounded it, because the
   * enrichment loop calls `describe()` per actionable node and each of those
   * blocks too. So the dialog faults could not be exercised at all: an armed
   * `broadcast` run did not finish within 400s.
   *
   * WHAT THIS GUARD DOES NOT COVER, measured rather than reasoned about: a dialog
   * that arrives AFTER the check above has passed. `observe()` then has a snapshot
   * in flight, and `describe()` — which the enrichment loop calls per actionable
   * node — carries no guard of its own, so each waits out Playwright's 30s
   * default. `launch()`'s `page.goto` is unguarded for the same reason, and was
   * measured at exactly that: 30s to `TimeoutError` when a dialog was already
   * queued at navigation. So an armed `broadcast` replay is bounded in the common
   * case and NOT bounded in general — four runs of the shipped fault against this
   * mock: three completed (59s, 89s, 119s) and one was still stalled at s04's
   * postcondition when it was killed at 400s, having logged `step.acted s04` and
   * no `recovery.applied`. `scripts/fault.ts` records the same intermittency from
   * the other side, and its `broadcast` expectation is deliberately left red.
   *
   * Nothing here touches the page. `page.url()` is a synchronous read of state
   * the driver already holds, so it answers while the dialog is up.
   *
   * WHAT IS DELIBERATELY EMPTY, because a caller must not mistake this for a
   * normal perception: there are no nodes and no text, since we genuinely cannot
   * see the screen behind the dialog. Reporting the last known text instead would
   * be worse than reporting none — a postcondition could then match content that
   * is no longer visible and a blocked run would be recorded as a success.
   * `screen` is null for the same reason.
   *
   * The digest keys on the MESSAGE, so discovery's no-progress detector sees a
   * stuck dialog as a stuck surface rather than as movement.
   */
  private blockedObservation(message: string): Observation {
    return {
      location: this.page.url(),
      screen: null,
      nodes: [],
      text: "",
      dialog: { message },
      digest: digestOf(`dialog|${message}`),
    };
  }

  async observe(): Promise<Observation> {
    /**
     * ANSWER FROM THE DIALOG, NOT FROM THE PAGE.
     *
     * This is what makes `undeclared_dialog` reachable. `classify()` produces
     * that failure kind from `observation.dialog`, and a step's pre- and
     * postcondition are the two moments `observe()` runs — so reporting the
     * dialog promptly is the whole mechanism by which a blocked surface becomes
     * a typed result instead of a 30s hang. It is equally what lets a DECLARED
     * `plan.recovery[]` rule keyed on a `dialog` atom fire at all.
     */
    const blocking = this.pendingDialog;
    if (blocking !== null) return this.blockedObservation(blocking.message());

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

    /**
     * Enrich the controls a model can actually act on with the two facts that
     * distinguish them on this surface: the app's own field name and the label
     * beside them. Without this the model is choosing between identical-looking
     * `textbox` lines. Each one costs a round trip, so the number ENRICHED is
     * capped — but the cap counts only the nodes it actually spends a round trip
     * on.
     *
     * THE CAP USED TO COUNT THE WRONG LIST, and it silently broke the flagship
     * screen. The test was `enriched.length >= 40`, but `enriched` accumulates
     * EVERY node — table cells, rows, static text — so a dense grid exhausted the
     * budget before the controls were reached, and any actionable node past
     * overall index 39 lost `fieldName` and `anchorText` while still looking
     * enriched. Measured on CRD0500: 46 nodes, 4 actionable, only 2 enriched —
     * the OVERRIDE CODE field and the APPLY submit reached the model as a bare
     * `textbox` and `button`, on the one screen from which anything can be
     * changed. `serialize.ts` records that exactly this blindness had already
     * caused a wrong-control pick once.
     */
    const ACTIONABLE = new Set(["textbox", "button", "link", "combobox", "checkbox", "radio"]);
    const MAX_ENRICHED = 40;
    const enriched: Node[] = [];
    let enrichedActionable = 0;
    for (const n of nodes) {
      if (!ACTIONABLE.has(n.role) || enrichedActionable >= MAX_ENRICHED) {
        enriched.push(n);
        continue;
      }
      enrichedActionable += 1;
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

  /**
   * Walk the frame path OUTERMOST FIRST, descending one hop at a time: by name,
   * then url pattern, then positional index among that hop's candidates.
   *
   * IT USED TO NOT DESCEND, and it failed silently, which is the worst way for a
   * targeting bug to fail. The loop returned on the first hop that matched
   * ANYTHING in the flat `page.frames()` list, so a two-hop path stopped at the
   * outer frame and never reached the inner one — and reported `degraded: false`
   * while doing it, so nothing downstream could tell that the write had landed
   * in the wrong container. Measured against this mock: a path of
   * `[{name:"nav"},{name:"content"}]` resolved clean and non-degraded, and a real
   * fill through it put the member id into the NAV frame's quick-lookup box
   * rather than the search screen's member-id field — which is precisely the
   * "it picked the wrong one" failure `types.ts` says is not hypothetical.
   *
   * Each hop is now searched among the DESCENDANTS OF THE PREVIOUS HOP, so a
   * later hop can only ever narrow. A hop that matches nothing refuses loudly
   * instead of falling through to the next one.
   *
   * SCOPE, so this is not read as more than it is: every artifact and every
   * minted target in this repo uses exactly ONE hop, and `describe()` can only
   * ever produce zero or one. Because `page.frames()` is flat, a single named hop
   * already reaches an arbitrarily nested frame, so this is not what the §3.7
   * nested-frameset story depends on. It is a hand-authoring trap being closed,
   * and the behaviour for the one-hop paths that actually ship is unchanged:
   * the first hop still searches the whole tree from the main frame.
   */
  private resolveFrame(target: TargetDescriptor): { frame: Frame; degraded: boolean } {
    const all = this.page.frames();
    let scope: Frame = this.page.mainFrame();
    let degraded = false;

    for (const hop of target.framePath) {
      // Everything below the current scope, at any depth. Built iteratively
      // rather than recursively so there is no named helper to hoist.
      const candidates: Frame[] = [];
      const pending: Frame[] = [...scope.childFrames()];
      while (pending.length > 0) {
        const next = pending.shift();
        if (!next) break;
        candidates.push(next);
        pending.push(...next.childFrames());
      }

      const byName = hop.name === undefined ? undefined : candidates.find((f) => f.name() === hop.name);
      if (byName) {
        scope = byName;
        continue;
      }
      // The primary hop missed; anything below this point is a fallback, and the
      // caller is told so via `degraded` on the Resolution.
      degraded = true;

      const byUrl =
        hop.urlPattern === undefined ? undefined : candidates.find((f) => new RegExp(hop.urlPattern ?? "").test(f.url()));
      if (byUrl) {
        scope = byUrl;
        continue;
      }

      const byIndex = hop.index === undefined ? undefined : candidates[hop.index];
      if (byIndex) {
        scope = byIndex;
        continue;
      }

      throw new SurfaceRefused("target_unresolvable", `no frame matched the path for ${target.id}`, {
        tried: target.framePath,
        failedHop: hop,
        // What was actually available AT THIS HOP, which is the debuggable fact —
        // the full list would not say where the descent stopped.
        availableAtHop: candidates.map((f) => f.name() || "(unnamed)"),
        available: all.map((f) => f.name() || "(main)"),
      });
    }

    return { frame: scope, degraded };
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
  /**
   * The durable facts of ONE already-resolved element, in a single round trip.
   *
   * Shared by `describe()` (record time) and `verifyElement()` (replay time) on
   * purpose: the role a target is MINTED with and the role it is later CHECKED
   * against must be computed the same way, or a target can be recorded as one
   * thing and verified as another.
   *
   * THE ROLE IS COMPUTED, NOT READ. It used to be `el.getAttribute("role")`,
   * which is empty on every control on every screen here — this markup is
   * deliberately pre-ARIA, with no roles, no test ids and no `<label for>`. So
   * `facts.role` was the empty string everywhere, which is what made the
   * verification below unable to fail.
   *
   * The mapping is a pragmatic subset of the HTML-AAM, not an implementation of
   * it: enough to tell the controls on a legacy servicing screen apart, and
   * honest about the ones it lumps together (a password field answers `textbox`,
   * which is not its ARIA role but is the useful answer for targeting). It is
   * inline rather than factored into a helper because this function's SOURCE is
   * serialised into the page — a named nested function would be rewritten to
   * reference esbuild's `__name` and fail exactly as the banner did.
   */
  private async factsOf(
    loc: Locator,
  ): Promise<{ tag: string; role: string; fieldName: string | null; anchorText: string | null }> {
    return loc.evaluate((el: Element) => {
      const row = el.closest("tr");
      const cells = row ? Array.from(row.querySelectorAll("td")) : [];
      const mine = cells.findIndex((c) => c.contains(el));

      const tag = el.tagName.toLowerCase();
      const type = (el.getAttribute("type") ?? "").toLowerCase();
      let role = el.getAttribute("role") ?? "";
      if (role === "") {
        if (tag === "a") role = el.hasAttribute("href") ? "link" : "generic";
        else if (tag === "button") role = "button";
        else if (tag === "textarea") role = "textbox";
        else if (tag === "select") role = el.hasAttribute("multiple") ? "listbox" : "combobox";
        else if (tag !== "input") role = "generic";
        // An `<input type="image">` submit is a BUTTON. Getting this one wrong is
        // what made the old verify vacuous: every input, submits included, passed
        // a `textbox` check.
        else if (type === "submit" || type === "button" || type === "image" || type === "reset") role = "button";
        else if (type === "checkbox") role = "checkbox";
        else if (type === "radio") role = "radio";
        else if (type === "hidden") role = "none";
        else role = "textbox";
      }

      // WHAT NAMES THIS CONTROL — and the two cases are genuinely different.
      //
      // A control with no text of its own (an input, a select) is named by the
      // label cell beside it: on these screens that is the only thing tying it to
      // a meaning. A LINK or BUTTON carries its own visible text, which is both
      // stabler and what the binding already names it by.
      //
      // MEASURED 2026-09-13 on a live discovery run. The results grid renders
      // `… | OPEN | <a>SELECT</a>`, so the cell-to-the-left rule anchored the
      // detail link on `OPEN` — the STATUS column's DATA. The compiler rightly
      // refused the artifact: the binding names that link `SELECT`, and an anchor
      // of `OPEN` would resolve against one member's card status and miss the
      // next member, whose row reads `FROZEN`. Row data is not a label, and a
      // target anchored on it is welded to one record.
      //
      // Written as plain consts, not a helper: this function's source is
      // serialised into the page, where a named nested function is rewritten to
      // reference esbuild's `__name` and throws exactly as the banner did.
      const own = (el.textContent ?? "").trim();
      const namesItself = (tag === "a" || tag === "button") && own !== "" && own.length <= 40;

      return {
        tag,
        role,
        fieldName: el.getAttribute("name"),
        anchorText: namesItself ? own : mine > 0 ? (cells[mine - 1]?.textContent ?? "").trim() : null,
      };
    });
  }

  async describe(ref: string): Promise<TargetFacts | null> {
    const loc = this.page.locator(`aria-ref=${ref}`);
    if ((await loc.count().catch(() => 0)) !== 1) return null;

    const facts = await this.factsOf(loc.first());

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
    /**
     * RESOLUTION TOUCHES THE PAGE, so it blocks behind a dialog exactly as
     * acting does.
     *
     * This guard is the one the first version of this fix MISSED, and the miss
     * was measured rather than reasoned about: with `observe()` and `perform()`
     * guarded but not this, an armed `broadcast` replay still took 832s. The
     * reason is that predicate evaluation does not act — it calls `find()` and
     * `read()`, both of which funnel through here into `locator.count()`, and
     * each of those waits out Playwright's 30s default. A step's pre- and
     * postcondition evaluate several atoms, so the hang simply moved from the
     * action to the predicates.
     *
     * Callers are built for this. `predicate.ts` wraps both in
     * `.catch(() => null)`, so a refusal reads as "not present" / "unreadable",
     * which is the honest answer while a dialog covers the screen: we genuinely
     * cannot see whether the element is there.
     */
    const queued = this.pendingDialog;
    if (queued !== null) {
      throw new SurfaceRefused(
        "dialog_blocking",
        `a native dialog is blocking this page, so ${target.id} cannot be resolved until it is answered`,
        { point: "driver", target: target.id, dialog: queued.message() },
      );
    }

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

  /**
   * Re-read the resolved element's own facts before acting on it.
   *
   * A CHECK THAT CAN ACTUALLY FAIL, which the previous one could not. It tested
   * `(role === "textbox" && tag === "input")`, and on this surface EVERY control
   * that is not a link is an `<input>` — including the `type="image"` submits.
   * So a target recorded as a textbox verified happily against a submit button,
   * and the one thing this gate exists to catch — the plan pointing at the wrong
   * KIND of control after a redesign — went straight through.
   *
   * It now compares against the same computed role `describe()` mints with, so
   * asking for a `textbox` and resolving a submit is a miss, and `locate()` moves
   * on to the next strategy instead of clicking it.
   */
  private async verifyElement(loc: Locator, target: TargetDescriptor): Promise<boolean> {
    try {
      if (target.verify.role) {
        const { role } = await this.factsOf(loc);
        if (role !== target.verify.role) return false;
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
    /**
     * Guarded in its OWN right, not just via `locate()`.
     *
     * `locate()` below is called with `.catch(() => null)`, so its refusal is
     * swallowed here by design — and then the static-text fallback goes straight
     * back to the page (`resolveFrame`, `row.count()`, `cells.nth()`), which
     * would block behind the dialog all over again. Refusing up front is what
     * makes the whole method prompt rather than only its first half.
     */
    const queued = this.pendingDialog;
    if (queued !== null) {
      throw new SurfaceRefused(
        "dialog_blocking",
        `a native dialog is blocking this page, so ${target.id} cannot be read until it is answered`,
        { point: "driver", target: target.id, dialog: queued.message() },
      );
    }

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
    /**
     * NOTICE A QUEUED DIALOG BEFORE TOUCHING THE PAGE.
     *
     * Every verb below except the two dialog answers goes through the page, and
     * a queued native dialog does not make those fail — it makes them BLOCK.
     * Measured against this mock: `locator.click` returned after exactly 30s with
     * `Timeout 30000ms exceeded`, as an untyped Playwright error that escapes the
     * engine entirely. A prompt typed refusal is strictly better than a hang that
     * ends in a stack trace.
     *
     * The engine rarely arrives here, because `observe()` reports the dialog at
     * the step boundary first and `classify()` names it. This is the second line,
     * for the callers that reach for the page anyway: the discovery loop acting
     * on a stale view, a scripted operator, an embedder driving the driver
     * directly.
     */
    const queued = this.pendingDialog;
    if (queued !== null && action.kind !== "accept_dialog" && action.kind !== "dismiss_dialog") {
      throw new SurfaceRefused(
        "dialog_blocking",
        `a native dialog is blocking this page, so ${action.kind} cannot be performed until it is answered`,
        { point: "driver", action: action.kind, dialog: queued.message() },
      );
    }

    switch (action.kind) {
      /**
       * A DRIVER CAPABILITY WITH NO CURRENT PRODUCER, kept deliberately.
       *
       * `press` is in the `SurfaceAction` vocabulary and in every shipped
       * policy's `allowedActions`, but nothing emits one: the compiler has no
       * verb that mints it and no artifact in the repo contains one. It stays
       * because a keyboard is how a real 3270/5250-style screen is driven — PF
       * keys, not clicks — and the seam is meant to admit that adapter without a
       * vocabulary change. Said plainly rather than left to look load-bearing.
       */
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
        await this.raceQueuedDialog(found.locator.fill(action.value));
        return found.resolution;
      }
      /**
       * `navigate` IS A CLICK. Identical implementation, deliberately and not by
       * oversight: on this class of application you do not navigate by URL, you
       * click the link or the menu item that gets you there — and the only
       * mutating route refuses GET precisely so a URL copied out of a log cannot
       * re-trigger anything. The two verbs stay distinct in the vocabulary
       * because the ARTIFACT means different things by them, and a reviewer
       * reading a plan should be able to see "this step moves screens" without
       * inferring it from the target's name. Nothing here treats them
       * differently, and nothing should pretend otherwise.
       */
      case "click":
      case "navigate": {
        const found = await this.locate(action.target);
        if (!found) return null;
        await this.raceQueuedDialog(found.locator.click());
        return found.resolution;
      }
    }
  }

  /**
   * Await a page call, but stop waiting the moment a native dialog is queued.
   *
   * THE IN-FLIGHT CASE, which checking `pendingDialog` beforehand cannot cover:
   * an `onsubmit` confirm() is raised BY the click, so there is nothing to notice
   * until the click is already blocked on it. Measured: the shipped
   * `confirm_submit` fault made the real replay CLI die after 52s with
   * `locator.click: Timeout 30000ms exceeded` — an untyped crash where the fault
   * catalogue promises a typed `undeclared_dialog`.
   *
   * This is a CONDITION, not a timeout. Nothing here guesses how long a click
   * ought to take; the wait ends when the driver is told a dialog exists, which
   * is the same discipline `settle()` applies to the application's own state. A
   * fixed bound would have to be either longer than a slow machine or shorter
   * than a slow app.
   *
   * The action is reported as ISSUED rather than refused, and that is the honest
   * answer: the click really was dispatched and the page really did begin
   * handling it. Whether the submit behind the dialog committed is not knowable
   * from here — so the engine learns what happened from the step's
   * postcondition, where `observe()` reports the dialog and the run gets a typed
   * `undeclared_dialog` instead of a phantom success.
   */
  private async raceQueuedDialog(op: Promise<unknown>): Promise<void> {
    let wake = (): void => {};
    const arrived = new Promise<"dialog">((resolve) => {
      wake = (): void => resolve("dialog");
      this.dialogWaiters.push(wake);
    });
    const completed = op.then(() => "completed" as const);
    // The loser stays pending and rejects later — a click behind a dialog throws
    // at Playwright's 30s default. Marking it handled here is what stops that
    // becoming an unhandled rejection long after the run has moved on.
    void completed.catch(() => {});

    try {
      await Promise.race([completed, arrived]);
    } finally {
      const i = this.dialogWaiters.indexOf(wake);
      if (i >= 0) this.dialogWaiters.splice(i, 1);
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
      await frame.evaluate(paintBanner).catch((e: unknown) => {
        /**
         * LOGGED, NEVER SWALLOWED.
         *
         * The bare `.catch(() => {})` this replaces is the single reason the
         * banner could be broken for the life of the feature without anyone
         * noticing: every frame was failing with
         * `ReferenceError: __name is not defined` and the comment attributed it
         * to a frame navigating mid-paint. Both things land here, and the log
         * cannot tell them apart — which is exactly why it must print rather than
         * decide. A frame torn down mid-paint is genuinely harmless; a
         * ReferenceError means no operator will ever see a banner, and those two
         * must not look the same from outside.
         *
         * A failure here is NOT fatal to the turn, and that is still right: the
         * session is already locked (`beginHumanTurn` arms before it paints) and
         * the operator console at its own port is a second, independent way to
         * hand back.
         */
        console.warn(
          `operator banner: paint FAILED in frame "${frame.name() || "(main)"}" — ${e instanceof Error ? e.message : String(e)}`,
        );
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

      /**
       * UNREF'D, for the reason `escalation.ts`'s own deadline is.
       *
       * Node keeps a process alive for a pending timer. Two deadlines race a
       * human turn — the orchestrator's TTL and this one — and when the
       * orchestrator's wins, this timer is still pending for the remainder of the
       * TTL. The replay CLI hid that by calling `process.exit()`, but a caller
       * embedding `replay()` as a library inherited a process that would not exit
       * for up to the whole TTL (two minutes by default) after an escalation had
       * already returned.
       */
      if (typeof timer.unref === "function") timer.unref();

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
   * `exposeBinding` throws on a second registration of the same name, hence a
   * latch per registration rather than an idempotent re-register.
   *
   * EACH PIECE LATCHES ONLY ONCE IT HAS ACTUALLY LANDED. A single `plumbed = true`
   * set BEFORE the awaits — which is what this replaced — records the whole
   * installation as complete the moment it STARTS, so a context that closes or a
   * binding that rejects part way latches as done and is never retried, and every
   * later `notice()` and `awaitHandback()` runs against half-installed plumbing
   * that silently does nothing. Per-piece flags mean a retry re-registers only
   * what is genuinely missing, which is also the only way a retry can be safe
   * given `exposeBinding`'s own refusal to register a name twice.
   *
   * WHAT IS STILL NOT HANDLED, said rather than implied: nothing here retries on
   * its own. A caller that swallows the rejection gets a driver with partial
   * plumbing until it calls again. `runEscalation` does not swallow it — a throw
   * out of `beginHumanTurn()` now propagates from inside its guarded region, so
   * the lease is restored and journalled and the run fails loudly.
   */
  private async ensurePlumbing(): Promise<void> {
    const context: BrowserContext = this.page.context();

    // Node answers PER FRAME, which is the E5 correction made mechanical: the
    // binding hands us the calling frame, so the choice is made here with
    // `frame.name()` and `frame.url()` in hand rather than guessed in the page.
    if (!this.noticeBound) {
      await context.exposeBinding("__meridianNotice", (source) => this.noticeFor(source.frame));
      this.noticeBound = true;
    }

    if (!this.handbackBound) {
      await context.exposeBinding("__meridianHandback", (_source, payload: unknown) => {
        const p = (payload ?? {}) as { kind?: unknown; operator?: unknown; note?: unknown };
        const note = typeof p.note === "string" ? p.note : undefined;
        return this.signalHandback({
          kind: p.kind === "aborted" ? "aborted" : "handed_back",
          operator: typeof p.operator === "string" ? p.operator : "banner",
          ...(note === undefined ? {} : { note }),
        });
      });
      this.handbackBound = true;
    }

    if (!this.initScriptAdded) {
      await context.addInitScript(paintBanner);
      this.initScriptAdded = true;
    }
  }

  /**
   * WHICH FRAME GETS THE BANNER — decided in Node, for the reason
   * DECISIONS.md records.
   *
   * Name then url pattern, mirroring `resolveFrame` above, because a hardcoded
   * name breaks on tenant B, whose `tenantB` config renames content/nav to
   * main/sidebar (mock/tenant.ts).
   *
   * The fallback is the case worth stating. If the caller named a frame and some
   * frame on the page matches it, every other frame answers null — one banner,
   * where it was asked for. If NOTHING matches, the name is stale, which is
   * precisely the drift this system expects to meet; a human staring at a session
   * with no banner at all is worse than a banner in two places, so every
   * paintable frame gets one.
   *
   * ── NO PRODUCTION CALLER PASSES A TARGET ────────────────────────────────────
   *
   * Said outright, because everything above describes a selection that does not
   * currently happen. The only paint on the production path is
   * `beginHumanTurn()`'s, which calls `notice(text)` with no `NoticeTarget`; the
   * orchestrator cannot supply one either, since `runEscalation` knows this
   * object only as a `HumanTurnLock` (begin and end, nothing else). So in
   * production the early return below is always taken and EVERY paintable frame
   * gets a banner. The one caller anywhere that passes a target is
   * `tests/handoff.integration.test.ts`.
   *
   * That is left as it is rather than wired up, and the reason is a real one
   * rather than an excuse: choosing a frame needs the tenant's frame NAME, which
   * lives in the binding, and the driver is deliberately the one layer that has
   * never heard of a binding — `BoundSurface` sits above it precisely so the
   * driver deals only in literals. Passing a `NoticeTarget` down would mean
   * threading tenant configuration into the driver to improve where a banner is
   * painted, which is a poor trade against painting it in every frame. The
   * untargeted branch is a correct fallback, not a degraded one; what would be
   * wrong is reading the code above and believing per-tenant placement is
   * happening.
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
