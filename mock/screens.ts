/**
 * THE SCREENS — deliberately hostile, in the ways that matter.
 *
 * Every trait here is chosen because it defeats a lazy automation strategy and
 * is realistic for a server-rendered back-office app of this generation:
 *
 *   - a real <frameset>, so frame traversal is mandatory
 *   - no test ids, no ARIA, no <label for>: a field is identified only by its
 *     position next to a text cell, or by the app's own form-field name
 *   - the SAME field name in the nav and content frames, so unscoped targeting
 *     is ambiguous
 *   - an <input type="image" alt=""> submit, which has no accessible name at all
 *   - screen ids rendered as plain text — the only self-describing thing present
 *   - dense bordered grids with no row keys
 *
 * What is deliberately NOT hostile: the happy path is clean and every control is
 * clickable. Over-hostility would sabotage the one graded discovery run.
 */
import type { TenantConfig } from "./tenant.js";
import type { Member, MockState } from "./seed.js";

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A 60x20 clickable submit with an empty alt — no accessible name by design. */
const SUBMIT_GIF =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

const chrome = (t: TenantConfig, screenId: string, title: string, clock: string): string => `
<table border="0" cellspacing="0" cellpadding="0" width="100%">
 <tr>
  <td><font face="Arial" size="1">${esc(screenId)}</font></td>
  <td align="center"><font face="Arial" size="1">${esc(t.institution)}</font></td>
  <td align="right"><font face="Arial" size="1">${esc(t.product)} &nbsp; ${esc(clock)}</font></td>
 </tr>
</table><hr size="1">
<font face="Arial" size="2"><b>${esc(title)}</b></font><br><br>`;

const page = (body: string): string =>
  `<!doctype html><html><body bgcolor="#ffffff" topmargin="4" leftmargin="6">${body}</body></html>`;

/** A label cell next to its control: the only relationship binding the two. */
const labelledField = (label: string, field: string, size: number, maxlength?: number): string =>
  `<tr><td><font face="Arial" size="2">${esc(label)}</font></td>` +
  `<td><input type="text" name="${esc(field)}" size="${size}"` +
  `${maxlength ? ` maxlength="${maxlength}"` : ""}></td></tr>`;

export const frameset = (t: TenantConfig): string =>
  `<!doctype html><html><head><title>${esc(t.product)}</title></head>
<frameset cols="170,*" frameborder="1" border="1">
 <frame name="${esc(t.navFrame)}" src="/nav">
 <frame name="${esc(t.contentFrame)}" src="/screen/search">
</frameset></html>`;

/** The nav frame carries a quick-lookup box using the SAME field name as the search screen. */
export const navFrame = (t: TenantConfig): string =>
  page(`<font face="Arial" size="1"><b>MEMBER SERVICES</b><hr size="1">
<form action="/screen/results" method="get">QUICK LOOKUP<br>
<input type="text" name="${esc(t.fields["MEMBER_ID"] ?? "MBRNO")}" size="8" maxlength="10"></form><br>
INQUIRY<br>ACCOUNTS<br>CARD SERVICES<br>STOP PAYMENT<br></font>`);

/**
 * SEC0100 — sign-on.
 *
 * The form posted to `/signon`, which `main.ts` does not route, so the only
 * control on the screen was a dead end onto the 404 render. Nothing in the repo
 * navigates here, so this was never a blocked flow — it is hygiene, and
 * tests/mock-app.test.ts now pins every screen's form action to a routed path so
 * the next dead action fails a test rather than waiting to be noticed.
 *
 * `/screen/menu` by GET: the app's other forms are GET, and the menu is where a
 * sign-on lands. No credential is checked, because the mock holds none.
 */
export const signOn = (t: TenantConfig, clock: string): string =>
  page(`${chrome(t, t.screenIds["SIGN_ON"] ?? "SEC0100", "OPERATOR SIGN-ON", clock)}
<form action="/screen/menu" method="get"><table border="0" cellpadding="3">
${labelledField("OPERATOR ID", t.fields["OPERATOR_ID"] ?? "OPRID", 12)}
<tr><td><font face="Arial" size="2">PASSCODE</font></td>
<td><input type="password" name="${esc(t.fields["PASSCODE"] ?? "PASSWD")}" size="12"></td></tr>
<tr><td>&nbsp;</td><td><input type="image" src="${SUBMIT_GIF}" alt="" width="60" height="20" name="${esc(t.fields["SUBMIT"] ?? "SUBMIT")}"></td></tr>
</table></form>`);

export const menu = (t: TenantConfig, clock: string): string =>
  page(`${chrome(t, t.screenIds["MENU"] ?? "MNU0200", "MAIN MENU", clock)}
<table border="0" cellpadding="2"><font face="Arial" size="2">
<tr><td>1.</td><td><a href="/screen/search">MEMBER INQUIRY</a></td></tr>
<tr><td>2.</td><td>ACCOUNT MAINTENANCE</td></tr>
<tr><td>3.</td><td>CARD SERVICES</td></tr>
<tr><td>9.</td><td><a href="/screen/audit">AUDIT INQUIRY</a></td></tr>
</font></table>`);

export const search = (t: TenantConfig, clock: string): string =>
  page(`${chrome(t, t.screenIds["MEMBER_SEARCH"] ?? "MBR0300", "MEMBER INQUIRY", clock)}
<form action="/screen/results" method="get"><table border="0" cellpadding="3">
${labelledField(t.labels["MEMBER_ID"] ?? "MEMBER ID", t.fields["MEMBER_ID"] ?? "MBRNO", 12, 10)}
${labelledField(t.labels["LAST_NAME"] ?? "LAST NAME", t.fields["LAST_NAME"] ?? "LNAME", 20)}
<tr><td>&nbsp;</td><td><input type="image" src="${SUBMIT_GIF}" alt="" width="60" height="20" name="${esc(t.fields["SUBMIT"] ?? "SUBMIT")}"></td></tr>
</table></form>`);

/**
 * Results NEVER auto-advance, even on a single hit. A UI that skips a screen when
 * there is one match makes the recorded step count depend on the data, which is
 * the sort of thing that turns a deterministic replay into a coin flip.
 */
export const results = (t: TenantConfig, clock: string, matches: readonly Member[]): string => {
  const cols = t.resultColumns;
  // ONE TRAILING COLUMN, and it is what makes the results -> detail hop
  // targetable at all. The `OPEN <id>` links below the grid sit outside any
  // <tr>, so a structural anchor — which resolves "the row containing this
  // label, then the control inside that row" — could never reach them. The
  // header cell is the literal "ACTION" and the body cell carries the tenant's
  // OPEN_MEMBER label, so the header row can never match the anchor key.
  //
  // With one match there is exactly one data row and the anchor resolves 1; with
  // two, `locate()` refuses rather than guessing, which is the correct behaviour
  // for a flow that must open a named member.
  //
  // `resultColumns` is deliberately untouched, so tenant B's extra leading column
  // still breaks anything reading the grid by index.
  const open = t.labels["OPEN_MEMBER"] ?? "SELECT";
  const header =
    cols.map((c) => `<td bgcolor="#dfe3e6"><font face="Arial" size="1"><b>${esc(c)}</b></font></td>`).join("") +
    `<td bgcolor="#dfe3e6"><font face="Arial" size="1"><b>ACTION</b></font></td>`;
  const cell = (v: string) => `<td><font face="Arial" size="1">${esc(v)}</font></td>`;
  const rows = matches
    .map((m) => {
      const base: Record<string, string> = {
        BRANCH: m.branch, MBR: m.id, NAME: m.name,
        TYPE: m.accounts[0]?.type ?? "", BALANCE: m.accounts[0]?.balance ?? "", STATUS: m.accounts[0]?.status ?? "",
      };
      return (
        `<tr>${cols.map((c) => cell(base[c] ?? "")).join("")}` +
        `<td><font face="Arial" size="1"><a href="/screen/detail?id=${esc(m.id)}">${esc(open)}</a></font></td></tr>`
      );
    })
    .join("\n");
  const empty = `<font face="Arial" size="2" color="#7E1416">NO RECORDS MATCH SELECTION — MSG 0071</font>`;
  return page(`${chrome(t, t.screenIds["MEMBER_RESULTS"] ?? "MBR0310", "MEMBER INQUIRY — RESULTS", clock)}
${matches.length === 0 ? empty : `<table border="1" cellspacing="0" cellpadding="2">
<tr>${header}</tr>
${rows}
</table><br><font face="Arial" size="1">${matches.length} RECORD(S)</font><br><br>
${matches.map((m) => `<a href="/screen/detail?id=${esc(m.id)}"><font face="Arial" size="2">OPEN ${esc(m.id)}</font></a><br>`).join("")}`}`);
};

/** The member header renders an unmasked SSN — one of the two redaction targets. */
export const detail = (t: TenantConfig, clock: string, m: Member): string =>
  page(`${chrome(t, t.screenIds["MEMBER_DETAIL"] ?? "MBR0400", "MEMBER DETAIL", clock)}
<table border="0" cellpadding="2">
<tr><td><font face="Arial" size="2">MEMBER</font></td><td><font face="Arial" size="2">${esc(m.id)} &nbsp; ${esc(m.name)}</font></td></tr>
<tr><td><font face="Arial" size="2">SSN</font></td><td><font face="Arial" size="2">${esc(m.ssn)}</font></td></tr>
<tr><td><font face="Arial" size="2">BRANCH</font></td><td><font face="Arial" size="2">${esc(m.branch)}</font></td></tr>
<tr><td><font face="Arial" size="2">${esc(t.labels["CARD_SERVICES_LINK"] ?? "CARD SERVICES")}</font></td><td><font face="Arial" size="2"><a href="/screen/cards?id=${esc(m.id)}">OPEN</a></font></td></tr>
</table><br>
<table border="1" cellspacing="0" cellpadding="2">
<tr><td bgcolor="#dfe3e6"><font face="Arial" size="1"><b>SUFFIX</b></font></td>
<td bgcolor="#dfe3e6"><font face="Arial" size="1"><b>TYPE</b></font></td>
<td bgcolor="#dfe3e6"><font face="Arial" size="1"><b>BALANCE</b></font></td></tr>
${m.accounts.map((a) => `<tr><td><font face="Arial" size="1">${esc(a.suffix)}</font></td><td><font face="Arial" size="1">${esc(a.type)}</font></td><td align="right"><font face="Arial" size="1">${esc(a.balance)}</font></td></tr>`).join("")}
</table>`);

/** Faults armed against the card screen, resolved by the caller before rendering. */
export interface CardScreenFaults {
  /** Queue a native alert() after load — a RECOVERABLE dialog. */
  readonly broadcast: boolean;
  /** Put a confirm() on the form's submit — an UNDECLARED dialog that blocks it. */
  readonly confirmSubmit: boolean;
}

/**
 * CRD0500 — the only screen from which anything can be changed.
 *
 * NO NESTED TABLES, anywhere on this screen, and that is a hard structural
 * requirement rather than a style preference: `table_anchor` resolves a target as
 * "the <tr> containing this label, then the control inside it", and Playwright's
 * `hasText` matches ANCESTOR rows too. One nested table would make every anchor
 * on the screen resolve 2 and `locate()` would refuse all of them. Every labelled
 * row therefore holds exactly ONE control, and the four tables here are siblings.
 *
 * The PAN is rendered UNMASKED in the grid. That is the entire point of this
 * screen existing: it is the redaction target, so masking at capture time is
 * proven against a screen that really does leak rather than asserted. No
 * capability target ever resolves to that cell.
 *
 * The hidden member id sits INSIDE the form but OUTSIDE the table, so it cannot
 * be picked up as the control belonging to any labelled row.
 */
export const cardServices = (
  t: TenantConfig,
  clock: string,
  m: Member,
  message: string | null,
  faults: CardScreenFaults,
): string =>
  page(`${chrome(t, t.screenIds["CARD_SERVICES"] ?? "CRD0500", "CARD SERVICES", clock)}
<table border="0" cellpadding="2">
<tr><td><font face="Arial" size="2">MEMBER</font></td><td><font face="Arial" size="2">${esc(m.id)} &nbsp; ${esc(m.name)}</font></td></tr>
</table><br>
<table border="1" cellspacing="0" cellpadding="2">
<tr><td bgcolor="#dfe3e6"><font face="Arial" size="1"><b>CARD NO</b></font></td>
<td bgcolor="#dfe3e6"><font face="Arial" size="1"><b>PRODUCT</b></font></td>
<td bgcolor="#dfe3e6"><font face="Arial" size="1"><b>${esc(t.labels["CARD_STATUS"] ?? "CARD STATUS")}</b></font></td></tr>
${m.cards.map((c) => `<tr><td><font face="Arial" size="1">${esc(c.pan)}</font></td><td><font face="Arial" size="1">${esc(c.product)}</font></td><td><font face="Arial" size="1">${esc(c.status)}</font></td></tr>`).join("")}
</table><br>
${message === null ? "" : `<font face="Arial" size="2" color="#7E1416">${esc(message)}</font><br><br>`}
<form action="/screen/card-action" method="post"${faults.confirmSubmit ? ` onsubmit="return confirm('CONFIRM CARD STATUS CHANGE')"` : ""}>
<input type="hidden" name="id" value="${esc(m.id)}">
<table border="0" cellpadding="3">
${labelledField(t.labels["CARD_SELECT"] ?? "CARD (LAST 4)", t.fields["CARD_SELECT"] ?? "SEL", 6, 4)}
${labelledField(t.labels["CARD_ACTION"] ?? "ACTION", t.fields["CARD_ACTION"] ?? "CACT", 14, 12)}
${labelledField(t.labels["OVERRIDE_CODE"] ?? "OVERRIDE CODE", t.fields["OVERRIDE_CODE"] ?? "OVRCD", 10, 10)}
<tr><td>&nbsp;</td><td><input type="image" src="${SUBMIT_GIF}" alt="" width="60" height="20" name="${esc(t.fields["CARD_APPLY"] ?? "APPLY")}"></td></tr>
</table></form>
${faults.broadcast ? `<script>setTimeout(function(){alert('SYSTEM BROADCAST: NIGHTLY MAINTENANCE 22:00')},0)</script>` : ""}`);

export interface ConfirmationDetail {
  /** The last four ONLY. The PAN never reaches this screen. */
  readonly last4: string;
  /** The action code, echoed verbatim so a checkpoint can assert it. */
  readonly action: string;
  readonly status: string;
  readonly confirmation: string;
}

/**
 * CNF9000 — proof that a specific card was changed.
 *
 * ONE flat label/value table, and exactly ONE row may contain the CONFIRMATION
 * label literal: `PlaywrightSurface.read()`'s static-text fallback anchors a row
 * by its label and reads the next cell, and it requires `row.count() === 1`. The
 * title is deliberately "CARD STATUS CHANGE ACCEPTED" rather than anything
 * containing "CONFIRMATION", for the same reason.
 *
 * Echoing the action code and the last four is what makes the checkpoint prove
 * the RIGHT card was changed, rather than merely that some confirmation appeared.
 */
export const confirmation = (t: TenantConfig, clock: string, m: Member, detail: ConfirmationDetail): string =>
  page(`${chrome(t, t.screenIds["CONFIRMATION"] ?? "CNF9000", "CARD STATUS CHANGE ACCEPTED", clock)}
<table border="0" cellpadding="2">
<tr><td><font face="Arial" size="2">MEMBER</font></td><td><font face="Arial" size="2">${esc(m.id)} &nbsp; ${esc(m.name)}</font></td></tr>
<tr><td><font face="Arial" size="2">CARD</font></td><td><font face="Arial" size="2">${esc(detail.last4)}</font></td></tr>
<tr><td><font face="Arial" size="2">ACTION</font></td><td><font face="Arial" size="2">${esc(detail.action)}</font></td></tr>
<tr><td><font face="Arial" size="2">NEW STATUS</font></td><td><font face="Arial" size="2">${esc(detail.status)}</font></td></tr>
<tr><td><font face="Arial" size="2">${esc(t.labels["CONFIRMATION"] ?? "CONFIRMATION")}</font></td><td><font face="Arial" size="2">${esc(detail.confirmation)}</font></td></tr>
</table>`);

/**
 * SYS0500 — the transaction was interrupted AFTER it committed.
 *
 * The screen deliberately cannot tell you whether anything landed, because the
 * real one cannot either. That is what makes it the honest trigger for
 * `reconcile_required`: the truth is in AUDIT INQUIRY and nowhere else.
 */
export const abend = (t: TenantConfig, clock: string): string =>
  page(`${chrome(t, "SYS0500", "SYSTEM ABEND — TRANSACTION INTERRUPTED", clock)}
<font face="Arial" size="2">THE TRANSACTION WAS INTERRUPTED. THIS SCREEN CANNOT REPORT WHETHER IT COMMITTED — CONSULT AUDIT INQUIRY.</font>`);

/**
 * SYS0405 — a mutating effect must not be reachable by a URL alone.
 *
 * Deliberate: a URL copied out of a log can never re-trigger a state change,
 * because the only route that changes anything refuses GET.
 */
export const methodNotAllowed = (t: TenantConfig, clock: string): string =>
  page(`${chrome(t, "SYS0405", "METHOD NOT ALLOWED", clock)}
<font face="Arial" size="2">THIS TRANSACTION MUST BE SUBMITTED FROM ITS OWN SCREEN.</font>`);

/**
 * Every field of `AuditRow`, in render order.
 *
 * Exported so a test can assert this list covers the row type exactly. Recording
 * nine facts and rendering five is the same declared-but-unshipped gap this whole
 * screen exists to close — and the two that were previously missing, `screen` and
 * `memberId`, are precisely the ones a reconciler needs to tie a row to a run.
 */
export const AUDIT_COLUMNS = [
  "SEQ", "AT", "ACTOR", "SCREEN", "ACTION", "MEMBER", "CONFIRMATION", "OUTCOME", "DETAIL",
] as const;

export const auditInquiry = (t: TenantConfig, clock: string, state: MockState): string => {
  const head = AUDIT_COLUMNS.map(
    (c) => `<td bgcolor="#dfe3e6"><font face="Arial" size="1"><b>${esc(c)}</b></font></td>`,
  ).join("");
  const cell = (v: string): string => `<td><font face="Arial" size="1">${esc(v)}</font></td>`;
  const rows = state.audit
    .map((r) =>
      `<tr>${[
        String(r.seq), r.at, r.actor, r.screen, r.action,
        r.memberId ?? "", r.confirmation ?? "", r.outcome, r.detail,
      ].map(cell).join("")}</tr>`,
    )
    .join("");
  return page(`${chrome(t, t.screenIds["AUDIT_INQUIRY"] ?? "AUD9500", "AUDIT INQUIRY", clock)}
<table border="1" cellspacing="0" cellpadding="2">
<tr>${head}</tr>
${rows}
</table>`);
};

export const notFound = (t: TenantConfig, clock: string): string =>
  page(`${chrome(t, "SYS0404", "SCREEN NOT FOUND", clock)}<font face="Arial" size="2">NO SUCH SCREEN.</font>`);
