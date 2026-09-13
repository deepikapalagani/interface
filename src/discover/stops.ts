/**
 * STOP CONDITIONS — §3.1's "until the goal is met or a stopping condition is hit
 * (max steps, timeout, dead-end)".
 *
 * A discovery loop without these is the thing that quietly burns an afternoon and
 * a budget: a model that cannot find the button will keep observing, re-reading
 * and re-clicking with total conviction. Every stop here is a DECLARED, typed
 * outcome rather than an exception, because "the run stopped and here is exactly
 * why" is evidence, while "the run ended" is not.
 *
 * The three the spec names are the easy ones. The two that matter in practice are
 * the ones it does not:
 *
 *   NO PROGRESS   the surface digest is unchanged across consecutive actions.
 *                 The model believes it is acting; the application disagrees.
 *                 This is the honest detector for a dead end, because a model
 *                 rarely announces one — it just keeps trying.
 *
 *   REPEATED ERROR the same tool error comes back repeatedly. Distinct from no
 *                 progress: the surface may well be changing while every attempt
 *                 is rejected.
 *
 * Budget is included because this project runs on a free tier with real rate
 * limits, and an unbounded loop against a 429-prone endpoint is a way to achieve
 * nothing slowly.
 */

export type StopReason =
  | "goal_reached"
  | "gave_up"
  | "max_steps"
  | "timeout"
  | "no_progress"
  | "repeated_error"
  | "token_budget";

export interface StopVerdict {
  readonly stop: boolean;
  readonly reason: StopReason | null;
  readonly detail: string;
}

export interface StopLimits {
  readonly maxSteps: number;
  readonly maxSeconds: number;
  /** Consecutive identical surface digests before calling it a dead end. */
  readonly noProgressLimit: number;
  /** Consecutive identical tool errors before giving up on that approach. */
  readonly repeatedErrorLimit: number;
  /** Total completion tokens across the run. */
  readonly maxTokens: number;
}

export const DEFAULT_LIMITS: StopLimits = {
  maxSteps: 40,
  maxSeconds: 300,
  noProgressLimit: 3,
  repeatedErrorLimit: 3,
  maxTokens: 120_000,
};

const going: StopVerdict = { stop: false, reason: null, detail: "" };

export class StopController {
  private steps = 0;
  private tokens = 0;
  private readonly startedAt: number;

  private lastDigest: string | null = null;
  private sameDigestRun = 0;

  private lastError: string | null = null;
  private sameErrorRun = 0;

  constructor(
    private readonly limits: StopLimits = DEFAULT_LIMITS,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.startedAt = this.now();
  }

  get stepCount(): number {
    return this.steps;
  }

  get tokensUsed(): number {
    return this.tokens;
  }

  get elapsedSeconds(): number {
    return Math.round((this.now() - this.startedAt) / 1000);
  }

  /** Called once per model turn, before the tool runs. */
  beginStep(): StopVerdict {
    if (this.steps >= this.limits.maxSteps) {
      return { stop: true, reason: "max_steps", detail: `reached the ${this.limits.maxSteps}-step ceiling` };
    }
    if (this.elapsedSeconds >= this.limits.maxSeconds) {
      return { stop: true, reason: "timeout", detail: `ran for ${this.elapsedSeconds}s of ${this.limits.maxSeconds}s` };
    }
    if (this.tokens >= this.limits.maxTokens) {
      return { stop: true, reason: "token_budget", detail: `spent ${this.tokens} of ${this.limits.maxTokens} completion tokens` };
    }
    this.steps += 1;
    return going;
  }

  recordTokens(completionTokens: number): void {
    this.tokens += completionTokens;
  }

  /**
   * The dead-end detector. A model almost never says "I am stuck" — it keeps
   * acting with confidence while the screen stays exactly as it was.
   *
   * FED FROM ACTING OUTCOMES ONLY, and the caller owes that: the verdict below
   * asserts that the model acted and the application did not respond, so a
   * perception turn reaching here would make the stop reason a false statement
   * about what happened. Consecutive perception turns are bounded by `maxSteps`
   * instead, which is the limit that actually describes them.
   */
  recordObservation(digest: string): StopVerdict {
    this.sameDigestRun = digest === this.lastDigest ? this.sameDigestRun + 1 : 0;
    this.lastDigest = digest;

    if (this.sameDigestRun >= this.limits.noProgressLimit) {
      return {
        stop: true,
        reason: "no_progress",
        detail: `the surface did not change across ${this.sameDigestRun + 1} consecutive actions — the model is acting, the application is not responding`,
      };
    }
    return going;
  }

  /** Distinct from no progress: the screen may be moving while every attempt is refused. */
  recordToolError(message: string): StopVerdict {
    this.sameErrorRun = message === this.lastError ? this.sameErrorRun + 1 : 0;
    this.lastError = message;

    if (this.sameErrorRun >= this.limits.repeatedErrorLimit) {
      return {
        stop: true,
        reason: "repeated_error",
        detail: `the same error came back ${this.sameErrorRun + 1} times: ${message}`,
      };
    }
    return going;
  }

  /** A successful tool call clears the error streak; progress is progress. */
  recordToolSuccess(): void {
    this.lastError = null;
    this.sameErrorRun = 0;
  }

  /**
   * The model declared it is done, or declared it is stuck. Both are typed
   * outcomes, and the loop routes its terminal tools through here so this module
   * remains the single owner of every stop reason.
   */
  declared(kind: "finish" | "stuck", detail: string): StopVerdict {
    return { stop: true, reason: kind === "finish" ? "goal_reached" : "gave_up", detail };
  }

  summary(): string {
    return `${this.steps} step(s), ${this.elapsedSeconds}s, ${this.tokens} completion tokens`;
  }
}
