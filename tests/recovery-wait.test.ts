/**
 * THE RECOVERABLE CLASS, FOR THE VERBS THAT DO NOT ACT.
 *
 * §3.3-f names two recoverable conditions: "dismiss a known interstitial" and
 * "wait/retry a transient load". The first half worked. The second was INVERTED,
 * and nothing in this suite could see it, which is why it shipped that way.
 *
 * `settle()` returns the instant ANY raced expectation holds, and
 * `expectationsFor` used to race every rule in `plan.recovery` — including the
 * two the engine answers by DOING NOTHING. So a `wait_and_retry` rule declared
 * against a transient load ENDED the wait the moment the load appeared: the
 * engine issued no action, re-observed the same load, and spent `maxAttempts` in
 * microseconds before hard-failing. Declaring the spec's own named example of a
 * recoverable condition made the run strictly WORSE than declaring nothing at
 * all — measured at ~1ms to failure against ~1229ms to success.
 *
 * Both directions are proven here, because a rule that fires on everything is as
 * broken as one that fires on nothing:
 *
 *   - the NON-ACTING verb must no longer end the wait (the regression), and
 *   - the ACTING verb must still be raced, because a dialog BLOCKS the page —
 *     the postcondition cannot come true underneath it, so noticing it promptly
 *     is the whole point, and waiting out the budget first would be a different
 *     defect introduced by the fix.
 *
 * Each pair runs THE SAME PLAN against THE SAME scripted surface, differing only
 * in what `plan.recovery` contains — the pairing `tests/side-effect.test.ts`
 * uses, for the same reason.
 *
 * No browser, no mock server, no model. The surface clears its own interstitial
 * after a fixed NUMBER OF OBSERVATIONS rather than after an elapsed time, so the
 * test is deterministic in poll count — a wall-clock test here would be the
 * "passes on a fast machine, fails on a slow one" failure that `settle.ts`'s own
 * header exists to argue against.
 */
import { describe, expect, it } from "vitest";
import { parseCapability, type Capability, type TargetDescriptor } from "../src/capability/schema.js";
import { ControlLease } from "../src/control/lease.js";
import { EventSequencer } from "../src/evidence/events.js";
import { PolicyDocument } from "../src/policy/policy.js";
import { runSteps, type RunReport } from "../src/replay/executor.js";
import { GatedSurface } from "../src/surface/gated.js";
import type {
  ActionContext,
  Observation,
  Resolution,
  ScreenshotOptions,
  Surface,
  SurfaceAction,
} from "../src/surface/types.js";

/** The interstitial text a `wait_and_retry` rule keys on. */
const LOADING_TEXT = "PLEASE WAIT — PROCESSING";

type RecoveryRule = Capability["plan"]["recovery"][number];

/**
 * One plan; `recovery` is the only knob.
 *
 * A factory rather than near-identical literals, so the two halves of a pair
 * cannot drift: if they differed in anything but the declared recovery, the pair
 * would prove nothing about the declared recovery.
 */
const capabilityWith = (recovery: readonly RecoveryRule[]): Capability =>
  parseCapability({
    schemaVersion: 1,
    contract: {
      id: "msc.card.recovery_wait",
      version: "1.0.0",
      goal: "Apply a card action through a transient interstitial.",
      purpose: "Fixture for the recoverable class: the smallest plan where a declared recovery rule can change the result.",
      inputs: [],
      outputs: [],
      outcomes: [],
      risk: "reversible",
      requiresSession: false,
    },
    plan: {
      app: "MERIDIAN MSC",
      targets: [
        {
          id: "APPLY",
          screen: "CARD_SERVICES",
          framePath: [{ name: "content" }],
          strategies: [{ kind: "field_key", key: "APPLY", matchedAtRecord: 1 }],
          verify: {},
          nameMayContainPii: false,
          robustness: "Fixture target; resolution is stubbed by the scripted surface.",
        },
      ],
      steps: [
        {
          ref: "s01",
          title: "Apply the card action",
          action: "click",
          target: "APPLY",
          pre: { all: [{ atom: "screen", is: "CARD_SERVICES" }], any: [] },
          post: { all: [{ atom: "screen", is: "CONFIRMATION" }], any: [] },
          risk: "reversible",
          approval: "none",
        },
      ],
      recovery: [...recovery],
      checkpoint: { all: [{ atom: "text", contains: "CNF" }], any: [] },
    },
    provenance: {
      discoveredAt: "2026-09-13T00:00:00Z",
      model: "none - test fixture, no model produced this",
      traceDigest: "0".repeat(64),
      appProfileVersion: "meridian-msc@4.2",
      modelAuthoredFields: [],
    },
    verification: { replayResult: "not_yet_verified" },
  });

const WAIT_RULE: RecoveryRule = {
  id: "wait-for-processing",
  when: { atom: "text", contains: LOADING_TEXT },
  do: "wait_and_retry",
  maxAttempts: 3,
  note: "The submit renders a processing interstitial before the confirmation. Give it time rather than failing.",
};

const DIALOG_RULE: RecoveryRule = {
  id: "dismiss-broadcast",
  when: { atom: "dialog", messageContains: "SYSTEM BROADCAST" },
  do: "dismiss_dialog",
  maxAttempts: 3,
  note: "A queued operator broadcast can land on the confirmation render. Dismissing it is declared and bounded.",
};

const AT_CARD_SERVICES: Observation = {
  location: "http://localhost:7101/screen/cards",
  screen: "CARD_SERVICES",
  nodes: [],
  text: "CRD0500 CARD SERVICES — CARD 4021 — CARD STATUS ACTIVE",
  dialog: null,
  digest: "d-card-services",
};

/** The transient state. Note it is NOT the confirmation screen. */
const AT_LOADING: Observation = {
  location: "http://localhost:7101/screen/card-action",
  screen: "PROCESSING",
  nodes: [],
  text: `CRD0500 ${LOADING_TEXT}`,
  dialog: null,
  digest: "d-loading",
};

const AT_CONFIRMATION: Observation = {
  location: "http://localhost:7101/screen/card-action",
  screen: "CONFIRMATION",
  nodes: [],
  text: "CNF9000 CARD STATUS CHANGE ACCEPTED — CARD 4021 — FROZEN — CNF4401",
  dialog: null,
  digest: "d-confirmation",
};

const resolution: Resolution = { strategyUsed: "field_key", strategyExpected: "field_key", matched: 1, degraded: false };

const policy = PolicyDocument.parse({
  version: "1.0.0",
  allowedOrigins: ["http://localhost:7101"],
  deniedRoutes: ["/__admin"],
  allowedActions: ["navigate", "click", "fill", "press", "dismiss_dialog"],
  screenRules: [],
  riskHandling: { read_only: "allow", reversible: "allow", irreversible: "confirm" },
  caps: { maxSteps: 40, maxRunSeconds: 300 },
});

/**
 * A surface that clears its own interstitial after `clearsAfter` observations.
 *
 * This is the shape `ScriptedSurface` in `side-effect.test.ts` cannot express:
 * there, the observation flips only when something ACTS on it. The whole point of
 * a transient load is that it clears because time passed and nobody touched it.
 */
class TransientSurface implements Surface {
  readonly acted: SurfaceAction[] = [];
  observations = 0;
  private submitted = false;
  private dialogUp = false;

  constructor(
    private readonly clearsAfter: number,
    private readonly withDialog = false,
  ) {}

  async observe(): Promise<Observation> {
    this.observations += 1;
    if (!this.submitted) return AT_CARD_SERVICES;
    if (this.withDialog) {
      // A blocking dialog means the page has NOT advanced. Returning the
      // confirmation screen with a dialog attached would let the postcondition
      // hold underneath it, and the recovery rule would never be needed — the
      // test would pass while proving nothing.
      return this.dialogUp
        ? { ...AT_CARD_SERVICES, dialog: { message: "SYSTEM BROADCAST: nightly batch begins at 23:00" } }
        : AT_CONFIRMATION;
    }
    return this.observations <= this.clearsAfter ? AT_LOADING : AT_CONFIRMATION;
  }
  async find(_t: TargetDescriptor): Promise<Resolution | null> {
    return resolution;
  }
  async describe(_ref: string): Promise<null> {
    return null;
  }
  async read(_t: TargetDescriptor): Promise<string | null> {
    return null;
  }
  async act(action: SurfaceAction, _ctx: ActionContext): Promise<Resolution | null> {
    this.acted.push(action);
    if (action.kind === "dismiss_dialog") {
      this.dialogUp = false;
      return resolution;
    }
    // The submit lands; the app then renders the interstitial (or the dialog)
    // before the confirmation it will eventually settle on.
    this.submitted = true;
    this.observations = 0;
    if (this.withDialog) this.dialogUp = true;
    return resolution;
  }
  onDialog(_h: (m: string) => void): void {}
  async screenshot(_options: ScreenshotOptions): Promise<Uint8Array> {
    return new Uint8Array([137, 80, 78, 71]);
  }
  async close(): Promise<void> {}
}

const run = async (
  recovery: readonly RecoveryRule[],
  opts: { readonly clearsAfter?: number; readonly withDialog?: boolean } = {},
): Promise<{ readonly stub: TransientSurface; readonly report: RunReport }> => {
  /**
   * 250ms per read, matching `side-effect.test.ts`, and the ratio to `stepMs`
   * below is load-bearing rather than arbitrary.
   *
   * `settle`'s poll interval is a REAL 100ms sleep and is not injectable through
   * `ExecutorDeps`, while the budget is measured on THIS clock. So the number of
   * real sleeps a test performs is `stepMs / <this increment>`. An earlier draft
   * used 25ms against a 5000ms budget — 200 polls, twenty real seconds per
   * attempt — and the never-clearing case blew vitest's timeout while looking
   * like an engine hang. It was arithmetic in the test.
   */
  let clock = 1_000;
  const now = (): number => {
    clock += 250;
    return clock;
  };

  let leaseTick = 0;
  const lease = new ControlLease(() => new Date(Date.UTC(2026, 8, 13, 12, 0, leaseTick++)).toISOString());
  // Clears on the third observation after the submit, comfortably inside the
  // ~5 polls a 1200ms budget allows at 250ms per read.
  const stub = new TransientSurface(opts.clearsAfter ?? 2, opts.withDialog ?? false);

  const report = await runSteps(capabilityWith(recovery), {}, {
    surface: new GatedSurface(stub, policy, lease),
    lease,
    log: new EventSequencer({
      runId: "recovery-wait-test",
      phase: "replay",
      now: () => "2026-09-13T12:00:00.000Z",
      controlOwner: () => lease.holder,
    }),
    budgets: { stepMs: 1_200, runMs: 60_000 },
    now,
    runId: "recovery-wait-test",
  });

  return { stub, report };
};

describe("a transient interstitial clears on its own", () => {
  it("NO recovery rule declared: settle waits it out and the run completes", async () => {
    const { report } = await run([]);

    // The control. It establishes that this surface does settle by itself, so
    // the paired test below is measuring the recovery rule and nothing else.
    expect(report.outcome.kind).toBe("completed");
    expect(report.stepsCompleted).toBe(1);
    expect(report.recoveries).toHaveLength(0);
  });

  it("wait_and_retry DECLARED: the same run must still complete, not fail faster", async () => {
    const { report } = await run([WAIT_RULE]);

    // Identical plan, identical surface, one declared recovery rule. Before the
    // fix this returned `failed` / `postcondition_failed` with three recovery
    // attempts recorded, in about a millisecond: `settle` raced the rule's own
    // `when`, so the interstitial APPEARING is what ended the wait for it.
    //
    // Declaring a recovery for a condition must never be worse than declaring
    // nothing for it. That is the property this test exists to hold.
    expect(report.outcome.kind).toBe("completed");
    expect(report.stepsCompleted).toBe(1);
  });

  it("wait_and_retry cannot rescue a load that never clears — it still fails, on the postcondition", async () => {
    const { report } = await run([WAIT_RULE], { clearsAfter: Number.MAX_SAFE_INTEGER });

    // The other direction: the fix must not turn a genuine failure into a hang or
    // a false success. The wait stays BOUNDED by the step budget and by
    // `maxAttempts`, which is the property that matters here.
    //
    // The exact `failureKind` is deliberately NOT pinned. It depends on whether
    // re-entering a step re-evaluates its precondition — which it may, since the
    // surface is parked on PROCESSING rather than CARD_SERVICES by then. Pinning
    // a kind measured on the BROKEN engine would assert something this test never
    // established, which is the habit the rest of this suite exists to break.
    expect(report.outcome.kind).toBe("failed");
    expect(report.recoveries).toHaveLength(WAIT_RULE.maxAttempts);
    expect(report.recoveries.every((r) => r.ruleId === WAIT_RULE.id)).toBe(true);
  });
});

describe("an acting recovery verb is still raced, so a blocking dialog is caught promptly", () => {
  it("dismiss_dialog DECLARED: the engine issues the dismissal and the run completes", async () => {
    const { stub, report } = await run([DIALOG_RULE], { withDialog: true });

    // A dialog BLOCKS the page: the postcondition cannot come true underneath it,
    // so this rule must stay in settle's race. Removing the non-acting verbs from
    // that race must not have removed this one with them.
    expect(report.outcome.kind).toBe("completed");
    expect(stub.acted.map((a) => a.kind)).toContain("dismiss_dialog");
    expect(report.recoveries).toHaveLength(1);
    expect(report.recoveries[0]?.ruleId).toBe("dismiss-broadcast");
  });
});
