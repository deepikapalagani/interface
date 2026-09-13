/**
 * THE MOCK IS NOW AN APPLICATION THAT CAN CHANGE SOMETHING, AND THIS PINS IT.
 *
 * Everything §3.4 and §3.6 need to demonstrate — a risky action, an audit trail
 * that can contradict the automation, a fault that commits before it fails — rests
 * on one POST route. So this suite drives the real server over HTTP, with no
 * browser and no model, and holds it to the four properties the rest of the system
 * assumes:
 *
 *   1. SCREEN IDS ARE UNAMBIGUOUS. `observe()` takes the FIRST match of
 *      /\b[A-Z]{2,3}\d{4}\b/ across every frame's joined text. `CNF4401` matches
 *      that pattern exactly as `CNF9000` does, so if a confirmation number could
 *      ever precede the chrome, every predicate asserting a screen would fail with
 *      a misleading message. Each renderer is checked for the id it intends.
 *
 *   2. STRUCTURAL ANCHORS RESOLVE EXACTLY ONE CONTROL. `table_anchor` is "the row
 *      containing this label, then the control inside it", and Playwright's
 *      `hasText` is a case-insensitive substring match that also matches ancestor
 *      rows. A second matching row makes `locate()` refuse — correctly, but the
 *      flow then cannot run at all — so the counts are asserted rather than hoped
 *      for. These checks are textual on purpose: they state the property without
 *      paying for a browser, and the browser proof is the integration suites.
 *
 *   3. RESET RESTORES EVERYTHING, AND TWO IDENTICAL SEQUENCES ARE BYTE-IDENTICAL.
 *      This is the property `scripts/verify-determinism.ts` rests on, asserted
 *      here at the source rather than only end to end.
 *
 *   4. FAULTS FIRE ONCE, DETERMINISTICALLY, AND `abend_after_commit` REALLY
 *      COMMITS. The last one is the whole point of that fault: the change lands,
 *      the audit row is written, and the caller is shown an abend that cannot tell
 *      it so.
 */
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyCardAction } from "../mock/actions.js";
import { createServer } from "../mock/main.js";
import * as screens from "../mock/screens.js";
import { FAULTS, freshState, type AuditRow } from "../mock/seed.js";
import { tenantA, tenantB } from "../mock/tenant.js";

const CLOCK = "14:05:00";
const AT = "2026-03-02T14:05:00Z";
const MEMBER = "400200101";
const FROZEN_MEMBER = "400203344";
const ABSENT = "400299999";

/** The same regex `PlaywrightSurface.observe()` uses to decide what screen it is on. */
const SCREEN_ID = /\b[A-Z]{2,3}\d{4}\b/;

/**
 * Tags stripped AND the entities `esc()` emits decoded, so this sees what a
 * browser's `innerText` would. Without the decode, the audit trail's
 * "ACTIVE -> FROZEN" is rendered as "ACTIVE -&gt; FROZEN" and is unfindable —
 * which is a defect in the assertion, not in the screen. `&amp;` is decoded LAST
 * so an escaped "&amp;lt;" cannot be double-decoded into a real "<".
 */
const textOf = (html: string): string =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** Non-nested <tr> blocks. Valid here precisely because no screen nests a table. */
const rowsOf = (html: string): string[] => html.match(/<tr\b[\s\S]*?<\/tr>/gi) ?? [];

/** Rows a `table_anchor` keyed on `key` would match: case-insensitive substring. */
const anchorRows = (html: string, key: string): string[] =>
  rowsOf(html).filter((row) => textOf(row).toUpperCase().includes(key.toUpperCase()));

/** Controls inside those rows — what `tr.filter(...).locator("input, ...")` counts. */
const anchorControls = (html: string, key: string): number =>
  anchorRows(html, key)
    .flatMap((row) => row.match(/<(?:input|select|textarea|a|button)\b/gi) ?? [])
    .length;

interface StateBody {
  readonly tenant: string;
  readonly confirmationSeq: number;
  readonly armedFault: string | null;
  readonly audit: readonly AuditRow[];
  readonly members: readonly string[];
  readonly cards: Readonly<Record<string, readonly { last4: string; status: string }[]>>;
}

let server: Server;
let base: string;

const get = (p: string): Promise<Response> => fetch(new URL(p, base));

const postForm = (p: string, form: Record<string, string>): Promise<Response> =>
  fetch(new URL(p, base), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });

const reset = async (): Promise<void> => {
  await fetch(new URL("__admin/reset", base), { method: "POST" });
};

const stateText = async (): Promise<string> => (await get("__admin/state")).text();
const state = async (): Promise<StateBody> => JSON.parse(await stateText()) as StateBody;

const armFault = (name: string): Promise<Response> =>
  fetch(new URL("__admin/fault", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fault: name }),
  });

/** A FREEZE of card 4021 on the seeded member — the flagship transaction. */
const freeze = (over: Partial<Record<string, string>> = {}): Promise<Response> =>
  postForm("screen/card-action", { id: MEMBER, SEL: "4021", CACT: "FREEZE", OVRCD: "", ...over });

const statusOf = (s: StateBody, member: string, last4: string): string | undefined =>
  s.cards[member]?.find((c) => c.last4 === last4)?.status;

beforeAll(async () => {
  server = createServer(tenantA);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  base = `http://localhost:${(server.address() as AddressInfo).port}/`;
});

afterAll(() => {
  server?.close();
});

beforeEach(reset);

/* ------------------------------------------------------- 1. screen id pickup */

describe("screen ids are picked up unambiguously", () => {
  const seed = freshState();
  const rose = seed.members[MEMBER];
  if (!rose) throw new Error("the seed no longer holds member 400200101 — this suite's ground truth is stale");
  const noFault = { broadcast: false, confirmSubmit: false } as const;

  const cases: readonly { readonly name: string; readonly html: string; readonly id: string }[] = [
    { name: "signOn", html: screens.signOn(tenantA, CLOCK), id: "SEC0100" },
    { name: "menu", html: screens.menu(tenantA, CLOCK), id: "MNU0200" },
    { name: "search", html: screens.search(tenantA, CLOCK), id: "MBR0300" },
    { name: "results (one match)", html: screens.results(tenantA, CLOCK, [rose]), id: "MBR0310" },
    { name: "results (empty)", html: screens.results(tenantA, CLOCK, []), id: "MBR0310" },
    { name: "detail", html: screens.detail(tenantA, CLOCK, rose), id: "MBR0400" },
    { name: "cardServices", html: screens.cardServices(tenantA, CLOCK, rose, null, noFault), id: "CRD0500" },
    {
      name: "cardServices (message)",
      html: screens.cardServices(tenantA, CLOCK, rose, "NO SUCH CARD ON THIS MEMBERSHIP — MSG 0114", noFault),
      id: "CRD0500",
    },
    {
      name: "cardServices (both faults armed)",
      html: screens.cardServices(tenantA, CLOCK, rose, null, { broadcast: true, confirmSubmit: true }),
      id: "CRD0500",
    },
    {
      name: "confirmation carrying CNF4401",
      html: screens.confirmation(tenantA, CLOCK, rose, {
        last4: "4021",
        action: "FREEZE",
        status: "FROZEN",
        confirmation: "CNF4401",
      }),
      id: "CNF9000",
    },
    { name: "abend", html: screens.abend(tenantA, CLOCK), id: "SYS0500" },
    { name: "methodNotAllowed", html: screens.methodNotAllowed(tenantA, CLOCK), id: "SYS0405" },
    { name: "notFound", html: screens.notFound(tenantA, CLOCK), id: "SYS0404" },
  ];

  for (const c of cases) {
    it(`${c.name} leads with ${c.id}`, () => {
      expect(SCREEN_ID.exec(textOf(c.html))?.[0]).toBe(c.id);
    });
  }

  it("an audit screen holding issued confirmations still leads with AUD9500", () => {
    // CNF4401 matches the screen-id pattern. If a row could precede the chrome,
    // every predicate asserting a screen on this page would read the wrong id.
    const withRows = freshState();
    applyCardAction(withRows, { memberId: MEMBER, last4: "4021", action: "FREEZE", override: "", at: AT, screen: "CRD0500" });
    applyCardAction(withRows, { memberId: MEMBER, last4: "7788", action: "FREEZE", override: "", at: AT, screen: "CRD0500" });

    const html = screens.auditInquiry(tenantA, CLOCK, withRows);
    expect(textOf(html)).toContain("CNF4401");
    expect(SCREEN_ID.exec(textOf(html))?.[0]).toBe("AUD9500");
  });

  it("the frameset and the nav frame carry no screen id at all", () => {
    expect(SCREEN_ID.exec(textOf(screens.frameset(tenantA)))).toBeNull();
    expect(SCREEN_ID.exec(textOf(screens.navFrame(tenantA)))).toBeNull();
  });

  it("no message code can be mistaken for a screen id", () => {
    for (const code of ["MSG 0071", "MSG 0102", "MSG 0114", "MSG 0121", "MSG 0140"]) {
      expect(SCREEN_ID.test(code)).toBe(false);
    }
  });
});

/* --------------------------------------------------- 2. anchors resolve once */

describe("every structural anchor the card flow uses resolves exactly one control", () => {
  const seed = freshState();
  const rose = seed.members[MEMBER];
  if (!rose) throw new Error("the seed no longer holds member 400200101");
  const noFault = { broadcast: false, confirmSubmit: false } as const;

  it("results -> detail: the ACTION column, one row per match", () => {
    const html = screens.results(tenantA, CLOCK, [rose]);
    expect(anchorRows(html, "SELECT")).toHaveLength(1);
    expect(anchorControls(html, "SELECT")).toBe(1);
    // The header says ACTION precisely so it cannot match the anchor key.
    expect(textOf(html)).toContain("ACTION");
  });

  it("detail -> cards: CARD SERVICES is a labelled row now, not a loose link", () => {
    const html = screens.detail(tenantA, CLOCK, rose);
    expect(anchorRows(html, "CARD SERVICES")).toHaveLength(1);
    expect(anchorControls(html, "CARD SERVICES")).toBe(1);
    expect(html).toContain(`/screen/cards?id=${MEMBER}`);
  });

  it("the card form's three fields each anchor one control", () => {
    const html = screens.cardServices(tenantA, CLOCK, rose, null, noFault);
    for (const key of ["CARD (LAST 4)", "ACTION", "OVERRIDE CODE"]) {
      expect(anchorRows(html, key), `rows matching ${key}`).toHaveLength(1);
      expect(anchorControls(html, key), `controls under ${key}`).toBe(1);
    }
  });

  it("CARD STATUS is a grid header with no control — a label, never an anchor key", () => {
    const html = screens.cardServices(tenantA, CLOCK, rose, null, noFault);
    expect(anchorRows(html, "CARD STATUS")).toHaveLength(1);
    expect(anchorControls(html, "CARD STATUS")).toBe(0);
  });

  it("the confirmation's CONFIRMATION row is unique, as read()'s fallback requires", () => {
    const html = screens.confirmation(tenantA, CLOCK, rose, {
      last4: "4021",
      action: "FREEZE",
      status: "FROZEN",
      confirmation: "CNF4401",
    });
    // read()'s static-text path requires row.count() === 1, so the title must not
    // contain the label literal either.
    expect(anchorRows(html, "CONFIRMATION")).toHaveLength(1);
    expect(textOf(html)).toContain("CARD STATUS CHANGE ACCEPTED");
    expect(textOf(html)).toContain("4021");
    expect(textOf(html)).not.toContain(rose.cards[0]?.pan ?? "«no pan»");
  });

  it("no screen the card flow touches nests a table", () => {
    const pages = [
      screens.results(tenantA, CLOCK, [rose]),
      screens.detail(tenantA, CLOCK, rose),
      screens.cardServices(tenantA, CLOCK, rose, null, noFault),
      screens.confirmation(tenantA, CLOCK, rose, { last4: "4021", action: "FREEZE", status: "FROZEN", confirmation: "CNF4401" }),
    ];
    for (const html of pages) {
      // A nested table would make `hasText` match ancestor rows and every anchor
      // on the page resolve 2.
      expect(/<table[^>]*>(?:(?!<\/table>)[\s\S])*<table/i.test(html)).toBe(false);
    }
  });

  it("RECORDS tenant B's CARD_SELECT collision rather than hiding it", () => {
    // Tenant B's CARD_SELECT label is "CARD NO", which is also the card grid's
    // static header, so the anchor matches two rows and `locate()` refuses. This
    // is drift a binding cannot absorb — the same class as `requiresReasonCode` —
    // and it is asserted so it stays a known measurement instead of resurfacing
    // as a mystery. Tenant A, which every fixture targets, is collision-free.
    const bRose = freshState().members[MEMBER];
    if (!bRose) throw new Error("the seed no longer holds member 400200101");
    const html = screens.cardServices(tenantB, CLOCK, bRose, null, noFault);
    expect(tenantB.labels["CARD_SELECT"]).toBe("CARD NO");
    expect(anchorRows(html, "CARD NO")).toHaveLength(2);
  });
});

/* ------------------------------------------------------------ 3. the routes */

describe("the mutating route", () => {
  it("applies a FREEZE, renders CNF9000, and writes exactly one APPLIED row", async () => {
    const body = await (await freeze()).text();
    expect(textOf(body)).toContain("CNF9000");
    expect(textOf(body)).toContain("CNF4401");

    const after = await state();
    expect(statusOf(after, MEMBER, "4021")).toBe("FROZEN");
    // The other card is untouched: the confirmation proves WHICH card changed.
    expect(statusOf(after, MEMBER, "7788")).toBe("ACTIVE");
    expect(after.confirmationSeq).toBe(4401);

    expect(after.audit).toHaveLength(1);
    expect(after.audit[0]).toEqual({
      seq: 1,
      at: AT,
      actor: "AUTOMATION",
      screen: "CRD0500",
      action: "FREEZE 4021",
      memberId: MEMBER,
      confirmation: "CNF4401",
      outcome: "APPLIED",
      detail: "ACTIVE -> FROZEN",
    });
  });

  it("attributes a row to a HUMAN iff the request carried an override code", async () => {
    await postForm("screen/card-action", { id: MEMBER, SEL: "4021", CACT: "LOST_STOLEN", OVRCD: "77123" });
    const after = await state();
    expect(after.audit[0]?.actor).toBe("HUMAN");
    expect(after.audit[0]?.outcome).toBe("APPLIED");
    expect(statusOf(after, MEMBER, "4021")).toBe("LOST_STOLEN");
  });

  const denials: readonly { readonly what: string; readonly form: Record<string, string>; readonly message: string; readonly detail: string }[] = [
    {
      what: "an action code the app does not know",
      form: { id: MEMBER, SEL: "4021", CACT: "DESTROY", OVRCD: "" },
      message: "INVALID ACTION CODE — MSG 0102",
      detail: "MSG 0102 INVALID ACTION CODE",
    },
    {
      what: "a card that is not on this membership",
      form: { id: MEMBER, SEL: "9999", CACT: "FREEZE", OVRCD: "" },
      message: "NO SUCH CARD ON THIS MEMBERSHIP — MSG 0114",
      detail: "MSG 0114 NO SUCH CARD ON THIS MEMBERSHIP",
    },
    {
      what: "a card already in the requested status",
      form: { id: FROZEN_MEMBER, SEL: "9090", CACT: "FREEZE", OVRCD: "" },
      message: "CARD ALREADY IN REQUESTED STATUS — MSG 0121",
      detail: "MSG 0121 CARD ALREADY IN REQUESTED STATUS",
    },
    {
      what: "LOST_STOLEN with no supervisor override",
      form: { id: MEMBER, SEL: "4021", CACT: "LOST_STOLEN", OVRCD: "" },
      message: "SUPERVISOR OVERRIDE REQUIRED — MSG 0140",
      detail: "MSG 0140 SUPERVISOR OVERRIDE REQUIRED",
    },
  ];

  for (const d of denials) {
    it(`refuses ${d.what}: renders ${d.message.slice(-8)} and records a DENIED row`, async () => {
      const body = await (await postForm("screen/card-action", d.form)).text();
      expect(textOf(body)).toContain("CRD0500");
      expect(textOf(body)).toContain(d.message);

      const after = await state();
      // A refusal is recorded, because otherwise "nothing happened" and "we
      // refused you" are indistinguishable in the independent record.
      expect(after.audit).toHaveLength(1);
      expect(after.audit[0]?.outcome).toBe("DENIED");
      expect(after.audit[0]?.detail).toBe(d.detail);
      expect(after.audit[0]?.confirmation).toBeNull();
      // Nothing moved.
      expect(after.confirmationSeq).toBe(4400);
    });
  }

  it("an unknown member renders MBR0310 + MSG 0071 and records NOTHING", async () => {
    const body = await (await postForm("screen/card-action", { id: ABSENT, SEL: "4021", CACT: "FREEZE", OVRCD: "" })).text();
    expect(textOf(body)).toContain("MBR0310");
    expect(textOf(body)).toContain("NO RECORDS MATCH SELECTION — MSG 0071");

    // Nothing was attempted against a membership, so nothing is recorded under one.
    expect((await state()).audit).toHaveLength(0);
  });

  it("refuses GET with 405 + SYS0405, so a URL from a log cannot re-trigger it", async () => {
    const response = await get("screen/card-action?id=400200101&SEL=4021&CACT=FREEZE");
    expect(response.status).toBe(405);
    expect(textOf(await response.text())).toContain("SYS0405");
    expect((await state()).audit).toHaveLength(0);
  });

  it("serves CRD0500 for a known member and MBR0310 + MSG 0071 for an unknown one", async () => {
    expect(textOf(await (await get(`screen/cards?id=${MEMBER}`)).text())).toContain("CRD0500");

    const missing = textOf(await (await get(`screen/cards?id=${ABSENT}`)).text());
    expect(missing).toContain("MBR0310");
    expect(missing).toContain("NO RECORDS MATCH SELECTION — MSG 0071");
  });

  it("renders the PAN unmasked on CRD0500 — the redaction target must be reachable", async () => {
    const seeded = freshState().members[MEMBER]?.cards[0]?.pan;
    expect(seeded).toBeTruthy();
    expect(await (await get(`screen/cards?id=${MEMBER}`)).text()).toContain(seeded ?? "«no pan»");
  });

  it("every form action a screen renders is a routed path", async () => {
    // SEC0100's form posted to /signon, which main.ts does not route, so the
    // only control on the screen was a dead end onto the 404 render. Nothing
    // navigates there, so it was never a blocked flow — but "the app's own
    // controls go somewhere" is the sort of property that is cheap to pin and
    // expensive to notice by hand, so it is pinned here rather than fixed once.
    const seed = freshState();
    const rose = seed.members[MEMBER];
    if (!rose) throw new Error("the seed no longer holds member 400200101");
    const noFault = { broadcast: false, confirmSubmit: false } as const;

    const pages = [
      screens.navFrame(tenantA),
      screens.signOn(tenantA, CLOCK),
      screens.search(tenantA, CLOCK),
      screens.cardServices(tenantA, CLOCK, rose, null, noFault),
    ];

    const actions = new Set<string>();
    for (const html of pages) {
      for (const m of html.matchAll(/action="([^"]+)"/g)) {
        const action = m[1];
        if (action) actions.add(action);
      }
    }
    expect(actions.size).toBeGreaterThan(0);

    for (const action of actions) {
      // GET on the mutating route answers 405 + SYS0405, which IS routed. Only
      // the 404 render means nothing handles the path.
      const body = textOf(await (await get(action)).text());
      expect(body, `${action} should be routed, not fall through to the 404 render`).not.toContain("SYS0404");
    }
  });

  it("renders every audit field on /screen/audit", async () => {
    await freeze();
    const row = (await state()).audit[0];
    if (!row) throw new Error("the FREEZE wrote no audit row");

    // One column per field: recording a fact and not rendering it is the exact
    // gap this change exists to close.
    expect(screens.AUDIT_COLUMNS).toHaveLength(Object.keys(row).length);

    const rendered = textOf(await (await get("screen/audit")).text());
    for (const value of [String(row.seq), row.at, row.actor, row.screen, row.action, row.memberId, row.confirmation, row.outcome, row.detail]) {
      expect(rendered, `audit screen should render ${String(value)}`).toContain(String(value));
    }
  });
});

/* ------------------------------------------------------- 4. determinism */

describe("determinism", () => {
  it("reset restores card statuses, the counter, the trail and the armed fault", async () => {
    await armFault("broadcast");
    await freeze();
    await postForm("screen/card-action", { id: MEMBER, SEL: "9999", CACT: "FREEZE", OVRCD: "" });

    const dirty = await state();
    expect(dirty.audit.length).toBeGreaterThan(0);
    expect(statusOf(dirty, MEMBER, "4021")).toBe("FROZEN");

    await reset();

    const clean = await state();
    expect(clean.audit).toEqual([]);
    expect(clean.confirmationSeq).toBe(4400);
    expect(clean.armedFault).toBeNull();
    expect(statusOf(clean, MEMBER, "4021")).toBe("ACTIVE");
    expect(statusOf(clean, MEMBER, "7788")).toBe("ACTIVE");
    expect(statusOf(clean, FROZEN_MEMBER, "9090")).toBe("FROZEN");
  });

  it("two identical reset -> act -> read sequences are byte-identical", async () => {
    await reset();
    await freeze();
    const first = await stateText();

    await reset();
    await freeze();
    const second = await stateText();

    // Not "equivalent" — the same bytes. Nothing in a row may derive from wall
    // time, request count or poll count.
    expect(second).toBe(first);
  });

  it("the admin plane exposes no PAN, no SSN and no request counter", async () => {
    await freeze();
    const raw = await stateText();

    const seed = freshState();
    const rose = seed.members[MEMBER];
    if (!rose) throw new Error("the seed no longer holds member 400200101");
    for (const card of rose.cards) expect(raw).not.toContain(card.pan);
    expect(raw).not.toContain(rose.ssn);

    // The exact key set: a request counter here would be contaminated by the
    // determinism checker's own two probes.
    expect(Object.keys(JSON.parse(raw) as Record<string, unknown>)).toEqual([
      "tenant", "confirmationSeq", "armedFault", "audit", "members", "cards",
    ]);
  });

  it("reads never append to the audit trail", async () => {
    // settle() polls on a wall clock and can re-observe; a read-logging trail
    // would make the app's final state a function of machine speed.
    for (const route of ["screen/search", `screen/results?MBRNO=${MEMBER}`, `screen/detail?id=${MEMBER}`, `screen/cards?id=${MEMBER}`, "screen/audit"]) {
      await get(route);
    }
    expect((await state()).audit).toHaveLength(0);
  });
});

/* ------------------------------------------------------------- 5. faults */

describe("faults", () => {
  it("refuses an unknown name with a 400 that names the legal set", async () => {
    const response = await armFault("go_bananas");
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; faults: string[] };
    expect(body.faults).toEqual(FAULTS.map((f) => f.name));
    expect((await state()).armedFault).toBeNull();
  });

  it("arms and clears, visibly in /__admin/state", async () => {
    await armFault("broadcast");
    expect((await state()).armedFault).toBe("broadcast");
    await armFault("none");
    expect((await state()).armedFault).toBeNull();
  });

  it("broadcast fires ONCE on the next card screen, then disarms itself", async () => {
    await armFault("broadcast");

    const first = await (await get(`screen/cards?id=${MEMBER}`)).text();
    expect(first).toContain("SYSTEM BROADCAST: NIGHTLY MAINTENANCE 22:00");
    // Queued after load, so it cannot interfere with the click that navigated here.
    expect(first).toContain("setTimeout");
    expect((await state()).armedFault).toBeNull();

    // Self-disarming is what lets a "recover and continue" rule terminate.
    expect(await (await get(`screen/cards?id=${MEMBER}`)).text()).not.toContain("SYSTEM BROADCAST");
  });

  it("confirm_submit puts an undeclared confirm() on the form, once", async () => {
    await armFault("confirm_submit");

    const first = await (await get(`screen/cards?id=${MEMBER}`)).text();
    expect(first).toContain("onsubmit=\"return confirm('CONFIRM CARD STATUS CHANGE')\"");
    expect((await state()).armedFault).toBeNull();
    expect(await (await get(`screen/cards?id=${MEMBER}`)).text()).not.toContain("onsubmit");
  });

  it("abend_after_commit COMMITS, and the audit trail is the only place that says so", async () => {
    await armFault("abend_after_commit");

    const body = textOf(await (await freeze()).text());
    // The caller is shown an abend and cannot tell what landed.
    expect(body).toContain("SYS0500");
    expect(body).not.toContain("CNF9000");
    expect(body).not.toContain("CNF4401");

    const after = await state();
    // ...but it DID land. This is the dangerous direction, and the whole reason
    // `reconcile_required` exists rather than a claimed outcome.
    expect(statusOf(after, MEMBER, "4021")).toBe("FROZEN");
    expect(after.audit).toHaveLength(1);
    expect(after.audit[0]?.outcome).toBe("APPLIED");
    expect(after.audit[0]?.confirmation).toBe("CNF4401");
    expect(after.armedFault).toBeNull();
  });

  it("abend_after_commit does NOT fire on an action that was refused", async () => {
    await armFault("abend_after_commit");

    const body = textOf(await (await postForm("screen/card-action", { id: MEMBER, SEL: "9999", CACT: "FREEZE", OVRCD: "" })).text());
    expect(body).toContain("CRD0500");
    expect(body).not.toContain("SYS0500");

    // It fires on the next action that would otherwise SUCCEED, so it is still armed.
    expect((await state()).armedFault).toBe("abend_after_commit");
  });

  it("two identical reset -> arm -> run sequences agree on the fault transition", async () => {
    const once = async (): Promise<string> => {
      await reset();
      await armFault("abend_after_commit");
      await freeze();
      return stateText();
    };
    expect(await once()).toBe(await once());
  });
});

/* -------------------------------------------------- 6. the rule table, pure */

describe("applyCardAction is pure and needs no server", () => {
  it("FREEZE then UNFREEZE returns the card to its seeded status", () => {
    const s = freshState();
    const one = applyCardAction(s, { memberId: MEMBER, last4: "4021", action: "FREEZE", override: "", at: AT, screen: "CRD0500" });
    expect(one).toMatchObject({ outcome: "APPLIED", screen: "CONFIRMATION", confirmation: "CNF4401", newStatus: "FROZEN" });

    const two = applyCardAction(s, { memberId: MEMBER, last4: "4021", action: "UNFREEZE", override: "", at: AT, screen: "CRD0500" });
    expect(two).toMatchObject({ outcome: "APPLIED", confirmation: "CNF4402", newStatus: "ACTIVE" });

    expect(s.members[MEMBER]?.cards[0]?.status).toBe("ACTIVE");
    expect(s.audit.map((r) => r.seq)).toEqual([1, 2]);
  });

  it("an unknown member mutates nothing and records nothing", () => {
    const s = freshState();
    const result = applyCardAction(s, { memberId: ABSENT, last4: "4021", action: "FREEZE", override: "", at: AT, screen: "CRD0500" });
    expect(result).toMatchObject({ outcome: "NO_MEMBER", screen: "MEMBER_RESULTS" });
    expect(s.audit).toHaveLength(0);
    expect(s.confirmationSeq).toBe(4400);
  });

  it("takes the action code verbatim, so CNF9000 can echo what the caller sent", () => {
    // No case folding: the checkpoint asserts `text contains {{action}}`, which a
    // silent upper-casing would break for any caller that did not already shout.
    const s = freshState();
    const result = applyCardAction(s, { memberId: MEMBER, last4: "4021", action: "freeze", override: "", at: AT, screen: "CRD0500" });
    expect(result.outcome).toBe("DENIED");
    expect(result.message).toBe("INVALID ACTION CODE — MSG 0102");
  });

  it("reports an already-lost card as MSG 0121 rather than as a missing override", () => {
    const s = freshState();
    applyCardAction(s, { memberId: MEMBER, last4: "4021", action: "LOST_STOLEN", override: "77123", at: AT, screen: "CRD0500" });
    const again = applyCardAction(s, { memberId: MEMBER, last4: "4021", action: "LOST_STOLEN", override: "", at: AT, screen: "CRD0500" });
    expect(again.message).toBe("CARD ALREADY IN REQUESTED STATUS — MSG 0121");
  });

  it("records the tenant's own screen id, not a hardcoded one", () => {
    const s = freshState();
    applyCardAction(s, { memberId: MEMBER, last4: "4021", action: "FREEZE", override: "", at: AT, screen: "CD0500" });
    expect(s.audit[0]?.screen).toBe("CD0500");
  });
});
