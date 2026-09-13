/**
 * PREDICATE EVALUATION — pure decision-making, shared by everything that asks
 * "is the world in the state we expected?"
 *
 * Preconditions, postconditions, checkpoints, business-outcome detection and
 * recovery triggers are all the same question asked against different predicate
 * sets. Collapsing them onto one evaluator is what keeps the replay engine small
 * enough that "no LLM decides anything" is checkable by reading it.
 *
 * Every evaluation returns what was EXPECTED and what was OBSERVED for each
 * atom, because §3.3-g requires a failure to say "what step, what was expected,
 * what was observed" — and a boolean cannot.
 */
import type { Atom, Predicate, TargetDescriptor } from "../capability/schema.js";
import type { Observation, Surface } from "../surface/types.js";

export interface AtomResult {
  readonly kind: Atom["atom"];
  readonly ok: boolean;
  readonly expected: string;
  readonly observed: string;
}

export interface PredicateResult {
  readonly ok: boolean;
  readonly atoms: readonly AtomResult[];
  /** A one-line rendering suitable for a failure's `expected` / `observed` pair. */
  readonly summary: string;
}

export interface EvalContext {
  readonly surface: Surface;
  /** Declared targets by SYMBOL, for atoms that name a control. */
  readonly targets: ReadonlyMap<string, TargetDescriptor>;
  /** Resolves `{{param}}` references against the caller's inputs. */
  readonly params: Readonly<Record<string, string>>;
}

/** One `{{param}}` interpolation, and what it could not fill in. */
export interface Substitution {
  readonly value: string;
  /** Parameters the template named that the caller did not supply. */
  readonly missing: readonly string[];
}

/**
 * Interpolate `{{param}}` references, REPORTING what was missing instead of
 * leaving the placeholder behind.
 *
 * The version this replaced was `params[name] ?? whole`, which silently left
 * `{{note}}` in the string when no `note` was supplied. That is harmless-looking
 * here and dangerous one layer up: the executor used the same fallback for
 * `step.value`, so replay typed the literal seven characters `{{note}}` into a
 * live form, and the step's own postcondition — `valueEquals ... "{{note}}"` —
 * then confirmed it had done so. A template that cannot be filled is a question
 * the artifact cannot answer, and both callers now have to decide what to do
 * about it rather than being handed a plausible-looking string.
 *
 * Shared by this module and `executor.ts` deliberately: two interpolation rules
 * would let a predicate and the action it guards disagree about what was typed.
 */
export const substituteParams = (
  value: string,
  params: Readonly<Record<string, string>>,
): Substitution => {
  const missing: string[] = [];
  const out = value.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (whole, name: string) => {
    const supplied = params[name];
    if (supplied === undefined) {
      missing.push(name);
      return whole;
    }
    return supplied;
  });
  return { value: out, missing };
};

/**
 * Data rows in the observation, header excluded.
 *
 * Every rendered grid on this class of surface has exactly one header row, so
 * subtracting one per table gives the count a human means by "how many records".
 *
 * RE-MEASURED 2026-09-13 against a mock started from `mock/main.ts` in this tree
 * on an ephemeral port, driven through the real `PlaywrightSurface`. The table
 * that stood here before was measured against an older mock and every one of its
 * load-bearing claims is now false, so it is replaced rather than reworded:
 *
 *                             dataRowCount   raw rows / tables   eq 0    gte 1
 *     search form ...............  2              4 / 2          false   true
 *     results, 1 match ..........  1              3 / 2          false   true
 *     results, 0 matches ........  0              1 / 1          TRUE    false
 *
 * So on this surface `rowCount eq 0` DOES match "NO RECORDS MATCH SELECTION",
 * `gte 1` does NOT match it, and the empty render is not "itself a form" — it is
 * one table carrying one header row. The committed `lookup@1.0.0` checkpoint
 * (`eq 1`) is consistent with that, and the committed not-found replay records
 * `business_outcome`, not a hard failure.
 *
 * WHAT IS STILL TRUE, AND IS THE REAL LIMITATION: the count is taken PAGE-WIDE.
 * An observation spans the whole frameset, so this number is "data rows visible
 * anywhere right now", not "rows in the grid the atom names". The `grid` field
 * the schema requires is IGNORED by the arm below — scoping it needs a
 * Surface-level way to count within a named region, which does not exist. The
 * search form scoring 2 is exactly that limitation showing: those rows are form
 * chrome, not records. Rather than hide it, the rowCount arm now says so in its
 * own `observed` string, and the schema documents the matching exemption.
 *
 * Exported so the discovery executor records row counts with THIS function. A
 * second counting rule in the compiler would let an artifact assert a number the
 * evaluator can never reproduce — the two must agree by construction, not by
 * coincidence.
 */
export const dataRowCount = (obs: Observation): number => {
  const rows = obs.nodes.filter((n) => n.role === "row").length;
  const tables = obs.nodes.filter((n) => n.role === "table").length;
  return Math.max(0, rows - tables);
};

const evaluateAtom = async (atom: Atom, obs: Observation, ctx: EvalContext): Promise<AtomResult> => {
  switch (atom.atom) {
    case "screen": {
      const observed = obs.screen ?? "(none)";
      return { kind: "screen", ok: obs.screen === atom.is, expected: `screen ${atom.is}`, observed: `screen ${observed}` };
    }
    case "text": {
      const { value: needle, missing } = substituteParams(atom.contains, ctx.params);
      if (missing.length > 0) {
        // A template that could not be filled is not a comparison that failed —
        // it is one that could not be made. Saying so is the difference between
        // a debuggable predicate and a mysterious `false`.
        return {
          kind: "text",
          ok: false,
          expected: `text contains "${atom.contains}"`,
          observed: `parameter(s) ${missing.join(", ")} were not supplied, so nothing could be compared`,
        };
      }
      const ok = obs.text.includes(needle);
      return { kind: "text", ok, expected: `text contains "${needle}"`, observed: ok ? "present" : "absent" };
    }
    case "rowCount": {
      const n = dataRowCount(obs);
      const ok = atom.op === "eq" ? n === atom.n : atom.op === "gte" ? n >= atom.n : n <= atom.n;
      /**
       * SAYING THE QUIET PART. `atom.grid` is not used to scope this count and
       * cannot be — see `dataRowCount`. Rather than print a bare "3 row(s)" and
       * let a reader assume the number came from the named grid, the observation
       * states the scope it was actually taken at, and flags the symbol when
       * nothing declares it.
       */
      const undeclared = ctx.targets.has(atom.grid) ? "" : ", which plan.targets does not declare";
      return {
        kind: "rowCount",
        ok,
        expected: `rows ${atom.op} ${atom.n} in ${atom.grid}`,
        observed: `${n} data row(s) counted PAGE-WIDE, not scoped to ${atom.grid}${undeclared}`,
      };
    }
    case "dialog": {
      const msg = obs.dialog?.message ?? "";
      const ok = msg.includes(atom.messageContains);
      return { kind: "dialog", ok, expected: `dialog contains "${atom.messageContains}"`, observed: obs.dialog ? `dialog "${msg}"` : "no dialog" };
    }
    case "element": {
      const target = ctx.targets.get(atom.target);
      if (!target) return { kind: "element", ok: false, expected: `${atom.target} declared`, observed: "symbol not declared" };
      const found = await ctx.surface.find(target).catch(() => null);
      const ok = atom.present ? found !== null : found === null;
      return { kind: "element", ok, expected: `${atom.target} ${atom.present ? "present" : "absent"}`, observed: found ? "present" : "absent" };
    }
    case "absent": {
      const target = ctx.targets.get(atom.target);
      /**
       * AN UNDECLARED SYMBOL FAILS HERE, exactly as it does for `element` and
       * `valueEquals`. It used to return ok:TRUE — the phantom-success hole in
       * this file: "TERMINATED_BANNER is absent" was satisfied by nobody having
       * declared TERMINATED_BANNER, so a predicate asserting that a dangerous
       * control is gone passed BECAUSE the plan never said what it was. The two
       * sibling arms eight lines above and below returned ok:false for the
       * identical condition, so the three now agree.
       *
       * Not merely defensive: schema refinement 8 now rejects an undeclared
       * symbol in any of the three atoms, so reaching this branch means the
       * capability bypassed `parseCapability`. Failing loudly is the right answer
       * to that, and an unreachable-but-correct branch costs nothing.
       */
      if (!target) return { kind: "absent", ok: false, expected: `${atom.target} declared`, observed: "symbol not declared" };
      const found = await ctx.surface.find(target).catch(() => null);
      return { kind: "absent", ok: found === null, expected: `${atom.target} absent`, observed: found ? "present" : "absent" };
    }
    case "valueEquals": {
      const target = ctx.targets.get(atom.target);
      if (!target) return { kind: "valueEquals", ok: false, expected: `${atom.target} declared`, observed: "symbol not declared" };
      const { value: want, missing } = substituteParams(atom.value, ctx.params);
      if (missing.length > 0) {
        return {
          kind: "valueEquals",
          ok: false,
          expected: `${atom.target} = "${atom.value}"`,
          observed: `parameter(s) ${missing.join(", ")} were not supplied, so nothing could be compared`,
        };
      }
      const got = await ctx.surface.read(target).catch(() => null);
      return { kind: "valueEquals", ok: got === want, expected: `${atom.target} = "${want}"`, observed: got === null ? "unreadable" : `"${got}"` };
    }
  }
};

/**
 * Depth-1 by construction: `all` must every hold, `any` needs one. There is no
 * nesting, so there is no expression language to reason about — which is exactly
 * what makes replay auditable.
 */
export const evaluatePredicate = async (
  predicate: Predicate,
  obs: Observation,
  ctx: EvalContext,
): Promise<PredicateResult> => {
  const all = await Promise.all(predicate.all.map((a) => evaluateAtom(a, obs, ctx)));
  const any = await Promise.all(predicate.any.map((a) => evaluateAtom(a, obs, ctx)));

  const allOk = all.every((r) => r.ok);
  const anyOk = any.length === 0 || any.some((r) => r.ok);
  const atoms = [...all, ...any];
  const failed = atoms.filter((r) => !r.ok);

  return {
    ok: allOk && anyOk,
    atoms,
    summary:
      allOk && anyOk
        ? atoms.map((a) => a.expected).join(" AND ")
        : failed.map((a) => `${a.expected} (saw ${a.observed})`).join("; "),
  };
};
