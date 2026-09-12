/**
 * THE REDACTION POLICY — one owner, and the default is SAFE.
 *
 * §3.4 requires that credentials, tokens and full PII never reach an artifact or
 * a log. Before this module that requirement existed as a `redact` hook on
 * `SerializeOptions` whose default was identity, and a `redacted?: boolean` on
 * the event envelope. No call site passed the hook. The system read as
 * redaction-aware while redacting nothing, which is worse than an absent
 * mechanism: a reviewer sees the seam and assumes the property.
 *
 * The committed evidence was clean only by accident. Every run so far stopped at
 * MBR0300/MBR0310, and MBR0400 is the only screen that renders an SSN — measured
 * against the live mock: `SSN 900-55-0101` sits in the member header as plain
 * text. The first run to click through to it writes that literal into the
 * discovery evidence verbatim.
 *
 * So the lesson is in the SHAPE of this file rather than in its rules: safety
 * that has to be opted into is safety nobody opts into. Callers get the policy
 * unless they deliberately override it.
 *
 * ── WHERE THE LINE IS, AND WHY IT IS NOT "EVERY DIGIT" ──────────────────────
 *
 * The model still has to do its job. Redacting the member id would destroy
 * discovery: `400200101` is what the agent types into MEMBER ID, it is what the
 * results grid is keyed by, and it becomes the capability's declared input
 * parameter. A run that cannot see it cannot record the step that uses it.
 *
 * This masks what §3.4 actually names — a full SSN, a full PAN, a credential, a
 * token — and deliberately leaves the working data of a servicing screen: member
 * id, member name, branch, balances, account suffixes, confirmation numbers.
 * Those are what the operator sees and what the model reasons over.
 *
 * LAST FOUR SURVIVE, on purpose. It is what a real servicing screen shows, and
 * here it is load-bearing rather than cosmetic: member 400200101 holds two cards
 * whose only visible difference is `4021` against `7788`. Masking a PAN whole
 * would leave the flagship capability (`msc.card.set_status`) unable to tell
 * which card it was asked to freeze — safety that breaks the thing it protects.
 *
 * ── TWO SHAPES ARE SHARED, NOT INVENTED ────────────────────────────────────
 *
 * Both from measurements already recorded in `scripts/verify-evidence.ts`, so
 * the detector and the redactor cannot disagree about what a leak looks like:
 *
 *   - The card shape is GUARDED, `(?<![\w-])\d{13,19}(?![\w-])`. Measured over
 *     the committed evidence: the bare `\b\d{13,19}\b` form matches 24 provider
 *     tool-call ids of the form `call_-7267060200698277786`; the guarded form
 *     matches none. A redactor that mangles tool-call ids corrupts the evidence
 *     it exists to protect, and would break the assistant/tool pairing a
 *     reviewer reads the file for. `src/capability/schema.ts` carried the bare
 *     form until 2026-09-12 and now carries this one, so all three detectors
 *     agree on a single shape rather than two.
 *
 *   - Only the HYPHENATED SSN is matched. A bare `\d{9}` rule would redact every
 *     member id on this surface — precisely the failure this policy exists to
 *     avoid, since a 9-digit member id and a 9-digit SSN are indistinguishable
 *     by shape alone. The limit is real and worth stating plainly: an SSN
 *     rendered without separators passes through untouched. On this surface it
 *     never is, and the separator is what carries the meaning.
 *
 * ── WHAT THIS FILE DOES NOT COVER ──────────────────────────────────────────
 *
 * Redaction has four boundaries and this module owns two of them (the model
 * context, and the discovery evidence files). The other two are enforced
 * elsewhere and are named here so the gap is visible rather than assumed:
 * the ARTIFACT is protected by the schema's own refinement — a PII-shaped
 * literal must be a `{{param}}` — and a SCREENSHOT is masked at capture time by
 * `PlaywrightSurface`, because a captured PNG already contains the PAN.
 *
 * Still open, and not fixable from here: `replay/predicate.ts` writes a read
 * value into an event's `observed` field, so a capability that reads an SSN
 * field would log it. That producer, and `LogEvent.redacted`, live behind the
 * event writer rather than behind this module.
 */

import { readFileSync } from "node:fs";

/** What replaces a value with no safe remainder. A passcode has no useful last four. */
export const CREDENTIAL_MASK = "[redacted:credential]";

/**
 * A credential is identified by the FIELD it belongs to, never by its shape:
 * `hunter2` and `ROSE` are the same string to a regex. Kept deliberately tight —
 * an over-broad name rule would start masking values the model needs to type,
 * which is the same failure as redacting the member id.
 */
const CREDENTIAL_FIELD = /pass(?:word|code|wd)|secret|token|api[_-]?key|authorization|credential/i;

interface Rule {
  readonly re: RegExp;
  readonly mask: (match: string, ...groups: string[]) => string;
}

/** Keep the trailing four, mask the rest — the form a servicing screen renders. */
const keepLast4 = (digits: string): string => `${"*".repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;

const RULES: readonly Rule[] = [
  // Ordered first so the hyphens are consumed before any digit-run rule sees them.
  { re: /(?<![\d-])(\d{3})-(\d{2})-(\d{4})(?![\d-])/g, mask: (_m, _a, _b, last4) => `***-**-${last4}` },
  { re: /(?<![\w-])(\d{13,19})(?![\w-])/g, mask: (_m, pan) => keepLast4(pan) },
  { re: /\b(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, mask: (_m, prefix) => `${prefix}${CREDENTIAL_MASK}` },
  {
    re: /\b(api[_-]?key|access[_-]?token|secret)(["' :=]+)[A-Za-z0-9._~+/=-]{16,}/gi,
    mask: (_m, key, sep) => `${key}${sep}${CREDENTIAL_MASK}`,
  },
];

/**
 * The one credential this system actually holds, masked BY VALUE.
 *
 * Sourced at runtime rather than copied, for the same reason `verify-evidence`
 * sources it that way: a copy goes stale on a key rotation and the protection
 * silently lapses. The discovery CLI reads it from `.env` rather than exporting
 * it, so the environment alone is not enough to find it.
 *
 * Short values are ignored deliberately — an unset or placeholder key would
 * otherwise be a substring matching half of every line it touched.
 */
const MIN_KEY_LENGTH = 16;
let cachedKey: string | null | undefined;

const liveModelKey = (): string | null => {
  // Resolved once: this runs per rendered line during a discovery run.
  if (cachedKey !== undefined) return cachedKey;

  const fromEnv = process.env["MODEL_API_KEY"];
  if (fromEnv !== undefined && fromEnv.length >= MIN_KEY_LENGTH) {
    cachedKey = fromEnv;
    return cachedKey;
  }

  cachedKey = null;
  // Two candidates, and the second is the one that carries the guarantee. A bare
  // ".env" resolves against the process CWD: MEASURED from /private/tmp, the live
  // 49-character key went UNMASKED because the read missed the file entirely and
  // the failure was silent. Anchoring the fallback to this module's own location
  // means the masking cannot lapse merely because a caller was launched from
  // somewhere other than the repo root.
  for (const source of [".env", new URL("../../.env", import.meta.url)]) {
    try {
      const match = /^MODEL_API_KEY\s*=\s*"?([^"\r\n]+)"?/m.exec(readFileSync(source, "utf8"));
      const value = match?.[1]?.trim();
      if (value !== undefined && value.length >= MIN_KEY_LENGTH) {
        cachedKey = value;
        return cachedKey;
      }
    } catch {
      // Absent or unreadable at this path. The shape rules still apply; this one cannot.
    }
  }
  return cachedKey;
};

/**
 * Mask every sensitive VALUE in a piece of free text.
 *
 * Applied to whole rendered lines rather than to parsed fields, because the
 * screens this reads are server-rendered tables where a value's only context is
 * the label cell beside it — there are no parsed fields to apply it to.
 */
export const redactText = (text: string): string => {
  let out = text;
  for (const rule of RULES) out = out.replace(rule.re, rule.mask as (...args: string[]) => string);
  const key = liveModelKey();
  if (key !== null && out.includes(key)) out = out.split(key).join(CREDENTIAL_MASK);
  return out;
};

/** Whether a field identity names a credential, and so has no safe partial form. */
export const isCredentialField = (name: string): boolean => CREDENTIAL_FIELD.test(name);

/**
 * Redact a literal by the field it was typed into.
 *
 * The field-keyed rule is what catches the class shape cannot: a passcode is an
 * ordinary word. This mirrors the field dimension the policy gate already has
 * (`deniedFields`), so "which fields are credentials" is one idea in the system
 * rather than two.
 */
export const redactTypedValue = (fieldIdentity: string | null, value: string): string =>
  fieldIdentity !== null && isCredentialField(fieldIdentity) ? CREDENTIAL_MASK : redactText(value);

/**
 * Redact an arbitrary JSON-shaped value, returning a NEW structure.
 *
 * Purity is load-bearing rather than hygiene: the discovery CLI hands the same
 * trace array to the evidence writer and to the compiler. If redaction mutated
 * it, the compiled artifact would inherit `****` as a recorded literal and the
 * capability would replay by typing asterisks into the app.
 */
export const redactDeep = (value: unknown): unknown => {
  if (typeof value === "string") return redactText(value);
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactDeep);
  // A Date would otherwise walk to `{}`; this is what the writer's own
  // JSON.stringify would have produced.
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    out[key] = isCredentialField(key) && typeof inner === "string" && inner.length > 0 ? CREDENTIAL_MASK : redactDeep(inner);
  }
  return out;
};
