/**
 * SEED DATA — synthetic, deterministic, and shaped like the real thing.
 *
 * Every value here is obviously fake on inspection (900-xx SSNs are never issued;
 * 4111… is the canonical test card) while still being the right SHAPE, so the
 * redaction requirement is demonstrable rather than theoretical. The mock renders
 * these unmasked on purpose: if masking at capture time does not work, the first
 * screenshot of the first run proves it.
 *
 * Determinism is the point. No randomness, no clock reads — `POST /__admin/reset`
 * restores this exact state, including the confirmation counter, so "replay is
 * deterministic" can be checked rather than believed.
 */

export type CardStatus = "ACTIVE" | "FROZEN" | "LOST_STOLEN";

export interface Card {
  readonly last4: string;
  /** Rendered unmasked on the card screen — the redaction target. */
  readonly pan: string;
  readonly product: string;
  status: CardStatus;
}

export interface Account {
  readonly suffix: string;
  readonly type: string;
  readonly balance: string;
  readonly status: string;
}

export interface Member {
  readonly id: string;
  readonly name: string;
  readonly branch: string;
  /** Rendered unmasked in the detail header — the other redaction target. */
  readonly ssn: string;
  readonly accounts: readonly Account[];
  readonly cards: Card[];
}

/**
 * THE FAULTS THIS APP CAN BE TOLD TO EXHIBIT.
 *
 * Each one is ARMED EXPLICITLY and fires on a stated condition, then disarms
 * itself. Nothing here is probabilistic: a lucky replay must never be able to
 * pass, and a self-disarming fault is also what lets "recover and continue"
 * terminate rather than loop forever.
 *
 * The catalogue lives beside the state it is stored in so `scripts/fault.ts
 * --list` reads the same list the server enforces, rather than a second copy
 * that drifts.
 */
export type FaultName = "broadcast" | "confirm_submit" | "abend_after_commit";

export interface FaultSpec {
  readonly name: FaultName;
  /** The exact condition on which it fires. */
  readonly fires: string;
  /**
   * What the APP does, and what that condition is an instance of.
   *
   * Deliberately NOT what replay returns. A mock fixture asserting engine
   * behaviour is a second copy of a claim it cannot check, and this file held
   * exactly that: it promised `broadcast` yielded a run that "continues" while
   * the engine returned `postcondition_failed`. Expectations about the REPLAY
   * outcome live in `scripts/fault.ts`, which is the only place that runs a
   * replay and compares.
   */
  readonly proves: string;
}

export const FAULTS: readonly FaultSpec[] = [
  {
    name: "broadcast",
    fires: "the next CARD SERVICES render; queues a native alert() after load",
    proves: "a known, dismissible interstitial arriving mid-flow — the condition §3.3's RECOVERABLE class is defined over",
  },
  {
    name: "confirm_submit",
    fires: "the next CARD SERVICES render; the card form gains an onsubmit confirm()",
    proves: "an UNDECLARED dialog on the submit path; the app's audit trail staying empty is the independent record that nothing committed",
  },
  {
    name: "abend_after_commit",
    fires: "the next card action that would otherwise succeed; commits, then renders SYS0500",
    proves: "the dangerous direction — the change LANDS and the caller is then shown a screen that cannot say so, leaving the audit trail the only record of the truth",
  },
];

export const isFaultName = (value: string): value is FaultName => FAULTS.some((f) => f.name === value);

export interface MockState {
  readonly members: Record<string, Member>;
  /** Monotonic, seeded — reset restores it, so confirmation numbers repeat exactly. */
  confirmationSeq: number;
  /** Append-only; the automation's evidence is reconciled against this. */
  audit: AuditRow[];
  /**
   * The fault currently armed, or null.
   *
   * It lives in `MockState` rather than at module scope so `POST /__admin/reset`
   * clears it: the determinism corpus can then never be polluted by a fault a
   * previous demo left armed, and a fault demo must arm AFTER its own reset.
   */
  armedFault: FaultName | null;
}

export interface AuditRow {
  /** 1-based index within THIS state's audit array. Never a request counter:
   *  srv.seq counted every request including verify-determinism's own
   *  /__admin/state probes, so a seq-derived field diverges between two
   *  identical runs by construction. Reset restores this by rebuilding the array. */
  readonly seq: number;
  /** Always the frozen VIRTUAL_NOW. Every row therefore shares one timestamp,
   *  which is exactly why `seq` carries the ordering. */
  readonly at: string;
  readonly actor: "AUTOMATION" | "HUMAN";
  readonly screen: string;
  readonly action: string;
  readonly memberId: string | null;
  readonly confirmation: string | null;
  readonly outcome: "APPLIED" | "DENIED";
  /** Why it was refused, or what changed. The reconcilable fact. */
  readonly detail: string;
}

const member = (
  id: string,
  name: string,
  branch: string,
  ssn: string,
  accounts: readonly Account[],
  cards: Card[],
): Member => ({ id, name, branch, ssn, accounts, cards });

/** Built fresh on every reset so no run can mutate another run's starting state. */
export const freshState = (): MockState => ({
  confirmationSeq: 4400,
  audit: [],
  armedFault: null,
  members: {
    "400200101": member("400200101", "ABERNATHY, ROSE", "012", "900-55-0101",
      [
        { suffix: "S0", type: "SHARE SAVINGS", balance: "1,204.55", status: "OPEN" },
        { suffix: "D1", type: "DRAFT", balance: "2,013.77", status: "OPEN" },
      ],
      [
        { last4: "4021", pan: "4111111111114021", product: "DEBIT CLASSIC", status: "ACTIVE" },
        { last4: "7788", pan: "4111111111117788", product: "DEBIT PLATINUM", status: "ACTIVE" },
      ]),
    "400200601": member("400200601", "BRUNELL, THOMAS", "004", "900-55-0601",
      [{ suffix: "S0", type: "SHARE SAVINGS", balance: "88.12", status: "OPEN" }],
      [{ last4: "5512", pan: "4111111111115512", product: "DEBIT CLASSIC", status: "ACTIVE" }]),
    "400203344": member("400203344", "CHOWDHURY, AMARA", "012", "900-55-3344",
      [{ suffix: "S0", type: "SHARE SAVINGS", balance: "9,455.01", status: "OPEN" }],
      [{ last4: "9090", pan: "4111111111119090", product: "DEBIT CLASSIC", status: "FROZEN" }]),
  },
});

/**
 * 400299999 is deliberately absent from the seed. It is the input that produces
 * MEMBER_NOT_FOUND — a business outcome the caller must handle, not a crash.
 */
export const ABSENT_MEMBER_ID = "400299999";

export const nextConfirmation = (state: MockState): string => {
  state.confirmationSeq += 1;
  return `CNF${state.confirmationSeq}`;
};
