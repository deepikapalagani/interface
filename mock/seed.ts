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

export interface Card {
  readonly last4: string;
  /** Rendered unmasked on the card screen — the redaction target. */
  readonly pan: string;
  readonly product: string;
  status: "ACTIVE" | "FROZEN" | "LOST_STOLEN";
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

export interface MockState {
  readonly members: Record<string, Member>;
  /** Monotonic, seeded — reset restores it, so confirmation numbers repeat exactly. */
  confirmationSeq: number;
  /** Append-only; the automation's evidence is reconciled against this. */
  audit: AuditRow[];
}

export interface AuditRow {
  readonly at: string;
  readonly actor: "AUTOMATION" | "HUMAN";
  readonly screen: string;
  readonly action: string;
  readonly memberId: string | null;
  readonly confirmation: string | null;
  readonly outcome: "APPLIED" | "DENIED";
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
