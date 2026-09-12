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

const substitute = (value: string, params: Readonly<Record<string, string>>): string =>
  value.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (whole, name: string) => params[name] ?? whole);

/**
 * Data rows in the observation, header excluded.
 *
 * Every rendered grid on this class of surface has exactly one header row, so
 * subtracting one per table gives the count a human means by "how many records".
 *
 * MEASURED 2026-09-12, AND THE ASSUMPTION DOES NOT HOLD AS USED. An observation
 * spans the whole frameset, so navigation chrome is counted too:
 *
 *     search form ............ 2
 *     results, 1 match ....... 1
 *     results, 0 matches ..... 2   <- NOT 0; the empty render is itself a form
 *
 * So `rowCount eq 0` never matches "NO RECORDS MATCH", and `gte 1` matches it as
 * readily as a genuine hit. Every rowCount predicate on this surface is therefore
 * unreliable, and the committed `lookup@1.0.0` checkpoint (`eq 1`) classifies a
 * not-found as a hard failure instead of the business outcome it is.
 *
 * THE FIX IS THE `grid` FIELD THE SCHEMA ALREADY REQUIRES AND THIS FUNCTION
 * IGNORES: the count must be scoped to the declared grid rather than taken across
 * the page. That needs a grid target and a way to count within it, so it lands
 * with the app profile and the outcome table, not here.
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
      const needle = substitute(atom.contains, ctx.params);
      const ok = obs.text.includes(needle);
      return { kind: "text", ok, expected: `text contains "${needle}"`, observed: ok ? "present" : "absent" };
    }
    case "rowCount": {
      const n = dataRowCount(obs);
      const ok = atom.op === "eq" ? n === atom.n : atom.op === "gte" ? n >= atom.n : n <= atom.n;
      return { kind: "rowCount", ok, expected: `rows ${atom.op} ${atom.n}`, observed: `${n} row(s)` };
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
      if (!target) return { kind: "absent", ok: true, expected: `${atom.target} absent`, observed: "symbol not declared" };
      const found = await ctx.surface.find(target).catch(() => null);
      return { kind: "absent", ok: found === null, expected: `${atom.target} absent`, observed: found ? "present" : "absent" };
    }
    case "valueEquals": {
      const target = ctx.targets.get(atom.target);
      if (!target) return { kind: "valueEquals", ok: false, expected: `${atom.target} declared`, observed: "symbol not declared" };
      const want = substitute(atom.value, ctx.params);
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
