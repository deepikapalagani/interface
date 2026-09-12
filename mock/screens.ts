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

export const signOn = (t: TenantConfig, clock: string): string =>
  page(`${chrome(t, t.screenIds["SIGN_ON"] ?? "SEC0100", "OPERATOR SIGN-ON", clock)}
<form action="/signon" method="post"><table border="0" cellpadding="3">
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
  const header = cols.map((c) => `<td bgcolor="#dfe3e6"><font face="Arial" size="1"><b>${esc(c)}</b></font></td>`).join("");
  const cell = (v: string) => `<td><font face="Arial" size="1">${esc(v)}</font></td>`;
  const rows = matches
    .map((m) => {
      const base: Record<string, string> = {
        BRANCH: m.branch, MBR: m.id, NAME: m.name,
        TYPE: m.accounts[0]?.type ?? "", BALANCE: m.accounts[0]?.balance ?? "", STATUS: m.accounts[0]?.status ?? "",
      };
      return `<tr>${cols.map((c) => cell(base[c] ?? "")).join("")}</tr>`;
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
</table><br>
<table border="1" cellspacing="0" cellpadding="2">
<tr><td bgcolor="#dfe3e6"><font face="Arial" size="1"><b>SUFFIX</b></font></td>
<td bgcolor="#dfe3e6"><font face="Arial" size="1"><b>TYPE</b></font></td>
<td bgcolor="#dfe3e6"><font face="Arial" size="1"><b>BALANCE</b></font></td></tr>
${m.accounts.map((a) => `<tr><td><font face="Arial" size="1">${esc(a.suffix)}</font></td><td><font face="Arial" size="1">${esc(a.type)}</font></td><td align="right"><font face="Arial" size="1">${esc(a.balance)}</font></td></tr>`).join("")}
</table><br>
<a href="/screen/cards?id=${esc(m.id)}"><font face="Arial" size="2">CARD SERVICES</font></a>`);

export const auditInquiry = (t: TenantConfig, clock: string, state: MockState): string =>
  page(`${chrome(t, t.screenIds["AUDIT_INQUIRY"] ?? "AUD9500", "AUDIT INQUIRY", clock)}
<table border="1" cellspacing="0" cellpadding="2">
<tr><td bgcolor="#dfe3e6"><font face="Arial" size="1"><b>AT</b></font></td>
<td bgcolor="#dfe3e6"><font face="Arial" size="1"><b>ACTOR</b></font></td>
<td bgcolor="#dfe3e6"><font face="Arial" size="1"><b>ACTION</b></font></td>
<td bgcolor="#dfe3e6"><font face="Arial" size="1"><b>CONFIRMATION</b></font></td>
<td bgcolor="#dfe3e6"><font face="Arial" size="1"><b>OUTCOME</b></font></td></tr>
${state.audit.map((r) => `<tr><td><font face="Arial" size="1">${esc(r.at)}</font></td><td><font face="Arial" size="1">${esc(r.actor)}</font></td><td><font face="Arial" size="1">${esc(r.action)}</font></td><td><font face="Arial" size="1">${esc(r.confirmation ?? "")}</font></td><td><font face="Arial" size="1">${esc(r.outcome)}</font></td></tr>`).join("")}
</table>`);

export const notFound = (t: TenantConfig, clock: string): string =>
  page(`${chrome(t, "SYS0404", "SCREEN NOT FOUND", clock)}<font face="Arial" size="2">NO SUCH SCREEN.</font>`);
