/**
 * THE ONE RULE TABLE FOR THE ONE MUTATING TRANSACTION.
 *
 * A PURE FUNCTION over `MockState`, with no HTTP, no clock and no randomness, so
 * every branch below is unit-testable without a server and two identical
 * `reset -> act` sequences produce byte-identical state by construction. The
 * frozen timestamp is passed IN rather than read, for the same reason the mock's
 * clock is frozen at all: anything derived from wall time or request count
 * diverges between two otherwise identical runs.
 *
 * ── WHY REFUSALS ARE WRITTEN TO THE AUDIT TRAIL ─────────────────────────────
 *
 * A DENIED row is not noise. Without it, "nothing happened" and "the app refused
 * you" are indistinguishable in the independent record — and a refusal is a pure
 * function of state and inputs, so it is perfectly deterministic. The only
 * attempt that writes nothing is one against a member that does not exist:
 * nothing was attempted against a membership, so there is no membership to
 * record it under.
 *
 * ── ACTOR ATTRIBUTION, STATED HONESTLY ──────────────────────────────────────
 *
 * The mock has NO notion of a session or a holder, and this function does not
 * invent one. A row is recorded `HUMAN` iff the request carried a non-empty
 * override code and `AUTOMATION` otherwise: the app records the AUTHORITY the
 * request carried, not who was at the keyboard, because only a supervisor holds
 * that code. Any non-empty override is accepted and none is seeded, so the mock
 * holds no credential to leak.
 *
 * Nothing here refuses a request because a human holds the session — the mock
 * cannot see that, and `src/control/lease.ts` must not claim it can.
 */
import { nextConfirmation, type AuditRow, type Card, type CardStatus, type MockState } from "./seed.js";

/** The three action codes this transaction accepts, and what each leaves behind. */
const TARGET_STATUS: Readonly<Record<string, CardStatus>> = {
  FREEZE: "FROZEN",
  UNFREEZE: "ACTIVE",
  LOST_STOLEN: "LOST_STOLEN",
};

/**
 * The app's own refusal messages.
 *
 * The codes are pairwise non-substrings, so a predicate asserting `MSG 0114`
 * cannot be satisfied by `MSG 0121`; and none matches `/\b[A-Z]{2,3}\d{4}\b/`
 * — the space defeats it — so none can be mistaken for a screen id by the
 * perception layer.
 */
interface Refusal {
  readonly code: string;
  readonly text: string;
}

const REFUSALS = {
  NO_MEMBER: { code: "0071", text: "NO RECORDS MATCH SELECTION" },
  BAD_ACTION: { code: "0102", text: "INVALID ACTION CODE" },
  NO_CARD: { code: "0114", text: "NO SUCH CARD ON THIS MEMBERSHIP" },
  ALREADY: { code: "0121", text: "CARD ALREADY IN REQUESTED STATUS" },
  NO_OVERRIDE: { code: "0140", text: "SUPERVISOR OVERRIDE REQUIRED" },
} as const satisfies Readonly<Record<string, Refusal>>;

/** As rendered on the screen. */
const messageOf = (r: Refusal): string => `${r.text} — MSG ${r.code}`;
/** As written to the audit trail. Derived from the same row so the two cannot drift. */
const detailOf = (r: Refusal): string => `MSG ${r.code} ${r.text}`;

export interface CardActionRequest {
  readonly memberId: string;
  readonly last4: string;
  /**
   * Taken VERBATIM, with no case folding.
   *
   * CNF9000 echoes this string back, which is what lets a capability's
   * checkpoint assert `text contains {{action}}`. Upper-casing it here would
   * break that for any caller that did not already send upper case, so a
   * lower-case code is refused as an invalid action code instead — which is also
   * how an app of this generation behaves.
   */
  readonly action: string;
  readonly override: string;
  /** The frozen VIRTUAL_NOW. Passed in so this function reads no clock. */
  readonly at: string;
  /** This tenant's own id for the card services screen, e.g. "CRD0500". */
  readonly screen: string;
}

/** Which screen the caller should render. Symbols, not tenant literals. */
export type CardActionScreen = "MEMBER_RESULTS" | "CARD_SERVICES" | "CONFIRMATION";

export interface CardActionResult {
  /** `NO_MEMBER` appends no audit row; the other two always do. */
  readonly outcome: "APPLIED" | "DENIED" | "NO_MEMBER";
  /** The app's message line, or null when the action succeeded. */
  readonly message: string | null;
  readonly confirmation: string | null;
  readonly screen: CardActionScreen;
  /** The card the action resolved to, so the confirmation can echo its last four. */
  readonly card: Card | null;
  readonly newStatus: CardStatus | null;
}

const record = (
  state: MockState,
  req: CardActionRequest,
  outcome: AuditRow["outcome"],
  confirmation: string | null,
  detail: string,
): void => {
  state.audit.push({
    seq: state.audit.length + 1,
    at: req.at,
    actor: req.override.trim() === "" ? "AUTOMATION" : "HUMAN",
    screen: req.screen,
    action: [req.action, req.last4].filter((part) => part !== "").join(" "),
    memberId: req.memberId,
    confirmation,
    outcome,
    detail,
  });
};

/**
 * Evaluate one card-status change against the seeded state, recording exactly
 * one audit row for every attempt against a real membership.
 *
 * The ordering of the guards is part of the contract: a card already in the
 * requested status is reported as such even when the action is LOST_STOLEN, so
 * "already lost/stolen" reads as MSG 0121 rather than as a missing override.
 */
export const applyCardAction = (state: MockState, req: CardActionRequest): CardActionResult => {
  const member = state.members[req.memberId];
  if (!member) {
    // Nothing was attempted against a membership, so nothing is recorded under
    // one. The caller renders the empty results screen, exactly as /screen/detail
    // does, so MEMBER_NOT_FOUND is detectable on this path too.
    return {
      outcome: "NO_MEMBER",
      message: messageOf(REFUSALS.NO_MEMBER),
      confirmation: null,
      screen: "MEMBER_RESULTS",
      card: null,
      newStatus: null,
    };
  }

  const deny = (refusal: Refusal): CardActionResult => {
    record(state, req, "DENIED", null, detailOf(refusal));
    return {
      outcome: "DENIED",
      message: messageOf(refusal),
      confirmation: null,
      screen: "CARD_SERVICES",
      card: null,
      newStatus: null,
    };
  };

  const wanted = TARGET_STATUS[req.action];
  if (wanted === undefined) return deny(REFUSALS.BAD_ACTION);

  const card = member.cards.find((c) => c.last4 === req.last4);
  if (card === undefined) return deny(REFUSALS.NO_CARD);

  if (card.status === wanted) return deny(REFUSALS.ALREADY);

  // The structural reason LOST_STOLEN needs a person: the artifact schema forbids
  // a `secret` input, so a capability cannot carry this code at all. The run must
  // escalate and a supervisor must type it into the live session.
  if (req.action === "LOST_STOLEN" && req.override.trim() === "") return deny(REFUSALS.NO_OVERRIDE);

  const was = card.status;
  card.status = wanted;
  const confirmation = nextConfirmation(state);
  record(state, req, "APPLIED", confirmation, `${was} -> ${wanted}`);

  return { outcome: "APPLIED", message: null, confirmation, screen: "CONFIRMATION", card, newStatus: wanted };
};
