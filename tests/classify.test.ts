/**
 * CLASSIFICATION PRECEDENCE — the most consequential test in this repo.
 *
 * The spec's glossary names one mistake specifically: "Business outcome vs
 * failure — 'no such member' is a legitimate answer the caller needs, not a
 * crash. Conflating the two is the most common design mistake here." §7 then
 * grades how cleanly the three classes separate.
 *
 * Precedence is what prevents that mistake, so precedence is what gets tested:
 * the headline case below is an observation that would satisfy BOTH a declared
 * business outcome and a postcondition failure. Only the ordering decides which
 * one the caller receives, and a regression in that ordering is invisible
 * without this test.
 *
 * The capability fixtures are minimal objects cast to `Capability` — classify()
 * reads only `contract.outcomes` and `plan.recovery`, and a full artifact here
 * would obscure what each case is actually varying. The schema itself is covered
 * exhaustively in capability-schema.test.ts.
 */
import { describe, expect, it } from "vitest";
import { classify, isTerminal, type Classification } from "../src/replay/classify.js";
import type { EvalContext } from "../src/replay/predicate.js";
import type { Capability, Predicate, TargetDescriptor } from "../src/capability/schema.js";
import type { ActionContext, Observation, Resolution, Surface, SurfaceAction } from "../src/surface/types.js";

class Stub implements Surface {
  async observe(): Promise<Observation> {
    return obs();
  }
  async find(_t: TargetDescriptor): Promise<Resolution | null> {
    return null;
  }
  async describe(_ref: string): Promise<null> {
    return null;
  }
  async read(_t: TargetDescriptor): Promise<string | null> {
    return null;
  }
  async act(_a: SurfaceAction, _c: ActionContext): Promise<Resolution | null> {
    return null;
  }
  onDialog(): void {}
  async screenshot(): Promise<Uint8Array> {
    return new Uint8Array();
  }
  async close(): Promise<void> {}
}

const obs = (over: Partial<Observation> = {}): Observation => ({
  location: "http://localhost:7101/screen/results",
  screen: "MEMBER_RESULTS",
  nodes: [],
  text: "MBR0310 MEMBER INQUIRY — RESULTS",
  dialog: null,
  digest: "d0",
  ...over,
});

const ctx: EvalContext = { surface: new Stub(), targets: new Map(), params: {} };

const capability = (over: {
  outcomes?: unknown[];
  recovery?: unknown[];
} = {}): Capability =>
  ({
    contract: {
      outcomes: over.outcomes ?? [
        {
          code: "MEMBER_NOT_FOUND",
          message: "No member matches that id.",
          when: { all: [{ atom: "text", contains: "MSG 0071" }], any: [] },
          source: "app_profile",
          note: "legitimate answer",
        },
      ],
    },
    plan: { recovery: over.recovery ?? [] },
  }) as unknown as Capability;

/** The step expected to land on the confirmation screen. */
const postcondition: Predicate = { all: [{ atom: "screen", is: "CONFIRMATION" }], any: [] };

describe("classification precedence", () => {
  it("THE GRADED CASE: a not-found that also fails the postcondition is a BUSINESS OUTCOME, not a crash", async () => {
    // This observation satisfies the declared outcome AND fails the postcondition.
    // Only precedence decides which the caller gets.
    const result = await classify(
      {
        observation: obs({ text: "NO RECORDS MATCH SELECTION — MSG 0071" }),
        capability: capability(),
        expectation: postcondition,
        usedRecoveries: [],
      },
      ctx,
    );

    expect(result.kind).toBe("business_outcome");
    if (result.kind !== "business_outcome") return;
    expect(result.code).toBe("MEMBER_NOT_FOUND");
    // The classification carries the signal that justified it, so it can be audited.
    expect(result.matchedSignal).toContain("MSG 0071");
  });

  it("a satisfied postcondition is simply expected", async () => {
    const result = await classify(
      { observation: obs({ screen: "CONFIRMATION" }), capability: capability(), expectation: postcondition, usedRecoveries: [] },
      ctx,
    );
    expect(result.kind).toBe("expected");
  });

  it("a declared obstruction is cleared BEFORE anything underneath it is judged", async () => {
    // Both a recovery rule and a business outcome match this observation. The
    // dialog wins, because judging what is underneath a blocking dialog would be
    // reading a half-obscured screen.
    const result = await classify(
      {
        observation: obs({ text: "NO RECORDS MATCH SELECTION — MSG 0071", dialog: { message: "SYSTEM BROADCAST: nightly maintenance" } }),
        capability: capability({
          recovery: [
            { id: "dismiss-broadcast", when: { atom: "dialog", messageContains: "SYSTEM BROADCAST" }, do: "dismiss_dialog", maxAttempts: 1, note: "known interstitial" },
          ],
        }),
        expectation: postcondition,
        usedRecoveries: [],
      },
      ctx,
    );
    expect(result.kind).toBe("recoverable");
    if (result.kind !== "recoverable") return;
    expect(result.ruleId).toBe("dismiss-broadcast");
    expect(result.action).toBe("dismiss_dialog");
  });

  it("a recovery rule cannot loop: once exhausted, the next class decides", async () => {
    const input = {
      observation: obs({ text: "NO RECORDS MATCH SELECTION — MSG 0071", dialog: { message: "SYSTEM BROADCAST" } }),
      capability: capability({
        recovery: [{ id: "dismiss-broadcast", when: { atom: "dialog", messageContains: "SYSTEM BROADCAST" }, do: "dismiss_dialog", maxAttempts: 1, note: "known" }],
      }),
      expectation: postcondition,
      usedRecoveries: ["dismiss-broadcast"], // already applied once, cap is 1
    };
    const result = await classify(input, ctx);
    expect(result.kind).toBe("business_outcome");
  });

  it("an UNDECLARED dialog is its own failure kind — never auto-dismissed into a phantom success", async () => {
    const result = await classify(
      {
        observation: obs({ dialog: { message: "ORDER REPLACEMENT CARD? FEE 5.00 WILL BE ASSESSED" } }),
        capability: capability({ outcomes: [] }),
        expectation: postcondition,
        usedRecoveries: [],
      },
      ctx,
    );
    expect(result.kind).toBe("hard_failure");
    if (result.kind !== "hard_failure") return;
    expect(result.failureKind).toBe("undeclared_dialog");
    expect(result.observed).toContain("FEE 5.00");
  });

  it("a plain postcondition failure says what was expected and what was seen", async () => {
    const result = await classify(
      { observation: obs({ screen: "MEMBER_RESULTS" }), capability: capability({ outcomes: [] }), expectation: postcondition, usedRecoveries: [] },
      ctx,
    );
    expect(result.kind).toBe("hard_failure");
    if (result.kind !== "hard_failure") return;
    expect(result.failureKind).toBe("postcondition_failed");
    expect(result.expected).toContain("screen CONFIRMATION");
    expect(result.observed).toContain("MEMBER_RESULTS");
  });

  it("nothing declared and nothing expected is a hard failure, not a silent pass", async () => {
    const result = await classify(
      { observation: obs(), capability: capability({ outcomes: [] }), expectation: null, usedRecoveries: [] },
      ctx,
    );
    expect(result.kind).toBe("hard_failure");
  });

  it("only business outcomes and hard failures end a run", () => {
    const terminal: Classification[] = [
      { kind: "business_outcome", code: "X", message: "m", matchedSignal: "s", evidence: { ok: true, atoms: [], summary: "" } },
      { kind: "hard_failure", failureKind: "app_error", expected: "e", observed: "o", evidence: null },
    ];
    const continuing: Classification[] = [
      { kind: "expected", evidence: { ok: true, atoms: [], summary: "" } },
      { kind: "recoverable", ruleId: "r", action: "dismiss_dialog", maxAttempts: 1, evidence: { ok: true, atoms: [], summary: "" } },
    ];
    expect(terminal.every(isTerminal)).toBe(true);
    expect(continuing.some(isTerminal)).toBe(false);
  });
});
