/**
 * TENANT CONFIGURATION — the same vendor product, configured two ways.
 *
 * This is the thing that makes the §3.7 reuse story testable rather than
 * asserted. The capability artifact names SYMBOLS (`MEMBER_SEARCH`, `MEMBER_ID`);
 * a tenant supplies the literals (`MBR0300`, `MBRNO`). One artifact, two
 * institutions, no plan edits.
 *
 * Tenant B differs in every way a real vendor deployment differs — screen ids,
 * field names, visible labels, the content frame's NAME, and an extra leading
 * grid column — so a run against B exercises the binding layer and the frame
 * fallback for real. Its `requiresReasonCode` toggle is the one difference a
 * binding CANNOT absorb, which is what makes it genuine drift.
 */

export interface TenantConfig {
  readonly id: string;
  readonly institution: string;
  readonly product: string;
  /** The content frame's name. Tenant B renames it, which breaks a name-only frame hop. */
  readonly contentFrame: string;
  readonly navFrame: string;
  /** SYMBOL -> the screen id this tenant actually renders. */
  readonly screenIds: Readonly<Record<string, string>>;
  /** SYMBOL -> the form field name in this tenant's markup. */
  readonly fields: Readonly<Record<string, string>>;
  /** SYMBOL -> the visible label text, which the structural anchor keys on. */
  readonly labels: Readonly<Record<string, string>>;
  /** Result grid columns, in render order. Tenant B prepends one. */
  readonly resultColumns: readonly string[];
  /**
   * Drift, not variation: a mandatory field the recorded plan knows nothing
   * about. No binding can express it, so replay must fail loudly rather than
   * silently adapt.
   */
  readonly requiresReasonCode: boolean;
}

const SCREENS_A = {
  SIGN_ON: "SEC0100",
  MENU: "MNU0200",
  MEMBER_SEARCH: "MBR0300",
  MEMBER_RESULTS: "MBR0310",
  MEMBER_DETAIL: "MBR0400",
  CARD_SERVICES: "CRD0500",
  CONFIRMATION: "CNF9000",
  AUDIT_INQUIRY: "AUD9500",
} as const;

export const tenantA: TenantConfig = {
  id: "fcu",
  institution: "FIRST COMMUNITY CU",
  product: "MERIDIAN MSC 4.2",
  contentFrame: "content",
  navFrame: "nav",
  screenIds: SCREENS_A,
  fields: {
    OPERATOR_ID: "OPRID",
    PASSCODE: "PASSWD",
    MEMBER_ID: "MBRNO",
    LAST_NAME: "LNAME",
    SUBMIT: "SUBMIT",
    CARD_SELECT: "SEL",
    CARD_ACTION: "CACT",
    OVERRIDE_CODE: "OVRCD",
    CARD_APPLY: "APPLY",
  },
  labels: {
    MEMBER_ID: "MEMBER ID",
    LAST_NAME: "LAST NAME",
    CARD_STATUS: "CARD STATUS",
    CONFIRMATION: "CONFIRMATION",
    CARD_SELECT: "CARD (LAST 4)",
    CARD_ACTION: "ACTION",
    OVERRIDE_CODE: "OVERRIDE CODE",
    CARD_SERVICES_LINK: "CARD SERVICES",
    OPEN_MEMBER: "SELECT",
  },
  resultColumns: ["MBR", "NAME", "TYPE", "BALANCE", "STATUS"],
  requiresReasonCode: false,
};

export const tenantB: TenantConfig = {
  id: "hcu",
  institution: "HARBORLIGHT CU",
  product: "MERIDIAN MSC 4.4",
  // Renamed at load time — this is what makes the frame-path fallback load-bearing.
  contentFrame: "main",
  navFrame: "sidebar",
  screenIds: {
    SIGN_ON: "SN0100",
    MENU: "MM0200",
    MEMBER_SEARCH: "MS0300",
    MEMBER_RESULTS: "MS0310",
    MEMBER_DETAIL: "MS0400",
    CARD_SERVICES: "CD0500",
    CONFIRMATION: "CF9000",
    AUDIT_INQUIRY: "AU9500",
  },
  fields: {
    OPERATOR_ID: "USERID",
    PASSCODE: "PASSCODE",
    MEMBER_ID: "MEMBERNO",
    LAST_NAME: "SURNAME",
    SUBMIT: "GO",
    CARD_SELECT: "CARDSEL",
    CARD_ACTION: "CARDACT",
    OVERRIDE_CODE: "SUPCODE",
    CARD_APPLY: "DOACT",
  },
  labels: {
    MEMBER_ID: "MEMBER NO",
    LAST_NAME: "SURNAME",
    CARD_STATUS: "CARD STATUS",
    CONFIRMATION: "REFERENCE",
    // MEASURED COLLISION, recorded rather than hidden. CRD0500's card grid
    // renders a static "CARD NO" header, and `table_anchor` matches any ROW
    // containing its key as a case-insensitive substring — so on THIS tenant the
    // CARD_SELECT anchor matches the header row as well as its own form row and
    // resolves 2, which `locate()` refuses rather than guessing.
    //
    // Left as-is deliberately: tenant B exists to expose the variation a binding
    // CANNOT absorb, and this is a second instance of it alongside
    // `requiresReasonCode`. A tenant-B binding would have to change the label or
    // the vendor would have to change the header; neither is something the
    // artifact can express, which is the point. Tenant A, which every fixture and
    // every run targets, is collision-free — see tests/mock-app.test.ts, which
    // pins both facts.
    CARD_SELECT: "CARD NO",
    CARD_ACTION: "ACTION CODE",
    OVERRIDE_CODE: "SUPERVISOR CODE",
    CARD_SERVICES_LINK: "CARDS",
    OPEN_MEMBER: "VIEW",
  },
  // One extra leading column: anything reading by grid index silently reads wrong.
  resultColumns: ["BRANCH", "MBR", "NAME", "TYPE", "BALANCE", "STATUS"],
  requiresReasonCode: false,
};

export const TENANTS: Readonly<Record<string, TenantConfig>> = { a: tenantA, b: tenantB };

export const tenantByKey = (key: string): TenantConfig => {
  const t = TENANTS[key];
  if (!t) throw new Error(`unknown tenant "${key}" (expected: ${Object.keys(TENANTS).join(", ")})`);
  return t;
};
