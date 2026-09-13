/**
 * "No LLM in replay" — checked, not claimed.
 *
 * §3.3 requires replay to run "without invoking the LLM for decisions", and §7
 * weights correctness of that loop second only to system design. It is also the
 * easiest claim in the whole submission to make and the easiest to quietly
 * break: one convenience import six months later and the production path has a
 * model in it again.
 *
 * So it is enforced structurally. This walks the import graph from BOTH doors
 * into the production path and fails if either can reach a model SDK, the
 * provider adapters, the discovery loop, or the raw model transcript. A runtime
 * check could not do this — it would only prove the model was not called on the
 * paths a test happened to exercise. The import graph proves it cannot be.
 *
 * ── THREE IMPORT FORMS, BECAUSE TWO OF THEM WERE INVISIBLE ──────────────────
 *
 * Until 2026-09-13 this file matched one regex,
 * `/(?:from|import)\s*["']([^"']+)["']/`, which requires a quote IMMEDIATELY
 * after `import`. The parenthesis in `await import("@anthropic-ai/sdk")` defeats
 * it, and a specifier held in a variable is invisible to it for the same reason.
 * MEASURED: a reviewer planted both forms in the replay path and this gate
 * printed "self-test passed" and "OK — 21 modules reachable … none of them a
 * model", exit 0. In an ESM `"type": "module"` codebase a dynamic import is the
 * natural way to add a model call — exactly the convenience import above.
 *
 * All three forms are now read, and the third one FAILS rather than being
 * skipped: a specifier this walker cannot evaluate is a specifier it cannot
 * clear, and reporting OK on it would be the same vacuous pass in a new place.
 *
 * Two guards against a vacuous pass, because a checker that silently resolves
 * nothing also reports success:
 *
 *   - it prints how many modules it walked, and fails if that is implausibly
 *     small;
 *   - `--self-test` plants ALL THREE forms, one at a time, and asserts each is
 *     caught by name. The old self-test planted only a static import — the one
 *     form the walker already understood — so it was structurally incapable of
 *     exposing the hole above.
 *
 * Run: npx tsx scripts/verify-no-llm.ts [--self-test]
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Both doors into the production path.
 *
 * `index.ts` is the library entry an agent calls; `main.ts` is the CLI a reviewer
 * runs. Walking only the first would leave the guarantee hollow at exactly the
 * file most likely to grow a convenience import — the one with argument parsing
 * and wiring in it.
 */
const ENTRIES = ["src/replay/index.ts", "src/replay/main.ts"];

const FORBIDDEN_PACKAGES = ["@anthropic-ai/sdk", "openai", "@google/generative-ai"];
const FORBIDDEN_PATHS = ["src/model/", "src/discover/", "src/compile/"];
/** Replay must work from the artifact, never from the raw model transcript (§2 item 3). */
const FORBIDDEN_READS = ["transcript.jsonl"];

/** `import x from "y"`, `import "y"`, `export … from "y"`. */
const STATIC_IMPORT_RE = /(?:from|import)\s*["']([^"']+)["']/g;
/** `import("y")` / `await import("y")` — a literal this walker can evaluate. */
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
/** `import(` with anything but a quote after it: a specifier that cannot be read. */
const OPAQUE_IMPORT_RE = /\bimport\s*\(\s*(?!["'])/g;

interface Violation {
  readonly chain: readonly string[];
  readonly offence: string;
}

const readSource = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

/**
 * Blank out comments before looking for imports.
 *
 * Needed because this file's own subject matter — the words `import(` — now
 * appears in prose inside the tree it walks, and a gate that fails on a sentence
 * is a gate people learn to ignore. Block comments go whole. A `//` is honoured
 * only when no quote precedes it on that line, so `"https://…"` is left alone.
 *
 * The residual risk is a trailing `//` comment that both follows a string on its
 * line AND contains `import(`: that produces a FALSE POSITIVE naming the file.
 * Deliberate, and the only acceptable direction — a false negative here is the
 * hole this whole change exists to close.
 */
const stripComments = (source: string): string =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => {
      const slash = line.indexOf("//");
      if (slash < 0) return line;
      const before = line.slice(0, slash);
      return /["'`]/.test(before) ? line : before;
    })
    .join("\n");

/** Resolve a relative specifier, honouring the ESM `.js`-means-`.ts` convention. */
const resolveSpecifier = (fromFile: string, spec: string): string | null => {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base.replace(/\.js$/, ".ts"), `${base}.ts`, path.join(base, "index.ts")]) {
    if (fs.existsSync(candidate)) return path.relative(process.cwd(), candidate);
  }
  return null;
};

const walk = (
  entry: string,
  extraSource?: { file: string; source: string },
): { violations: Violation[]; visited: Set<string> } => {
  const violations: Violation[] = [];
  const visited = new Set<string>();
  const queue: { file: string; chain: string[] }[] = [{ file: entry, chain: [entry] }];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const { file, chain } = current;
    if (visited.has(file)) continue;
    visited.add(file);

    const source = extraSource && extraSource.file === file ? extraSource.source : readSource(file);
    if (source === null) continue;

    // Deliberately the RAW source: the rule is that the replay path must not so
    // much as name the transcript, and that strictness costs nothing today.
    for (const read of FORBIDDEN_READS) {
      if (source.includes(read)) violations.push({ chain, offence: `reads ${read}` });
    }

    const code = stripComments(source);

    // A dynamic import whose specifier is not a literal cannot be cleared by
    // reading it, so it is refused rather than skipped. There are none in this
    // tree; if one arrives, this fails and names the file rather than walking
    // past the one construct it cannot evaluate.
    for (const _opaque of code.matchAll(OPAQUE_IMPORT_RE)) {
      violations.push({
        chain,
        offence: "uses a dynamic import whose specifier is not a string literal, so this walker cannot tell what it loads",
      });
    }

    for (const match of [...code.matchAll(STATIC_IMPORT_RE), ...code.matchAll(DYNAMIC_IMPORT_RE)]) {
      const spec = match[1];
      if (!spec) continue;

      if (FORBIDDEN_PACKAGES.some((p) => spec === p || spec.startsWith(`${p}/`))) {
        violations.push({ chain: [...chain, spec], offence: `imports ${spec}` });
        continue;
      }

      const resolved = resolveSpecifier(file, spec);
      if (!resolved) continue;

      const normalised = resolved.split(path.sep).join("/");
      if (FORBIDDEN_PATHS.some((p) => normalised.startsWith(p))) {
        violations.push({ chain: [...chain, normalised], offence: `reaches ${normalised}` });
        continue;
      }
      queue.push({ file: resolved, chain: [...chain, normalised] });
    }
  }

  return { violations, visited };
};

/**
 * Each plant is a real source form, asserted to produce a NAMED offence.
 *
 * The third one is the reason this list exists: its specifier is a variable, so
 * no amount of reading the string tells you what it loads, and the only honest
 * answer is to refuse it.
 */
const PLANTS: readonly { readonly what: string; readonly source: string; readonly expect: string }[] = [
  {
    what: 'a static `import "@anthropic-ai/sdk"`',
    source: 'import "@anthropic-ai/sdk";\n',
    expect: "imports @anthropic-ai/sdk",
  },
  {
    what: 'a dynamic `await import("@anthropic-ai/sdk")`',
    source: 'const late = async () => (await import("@anthropic-ai/sdk")).default;\n',
    expect: "imports @anthropic-ai/sdk",
  },
  {
    what: "a dynamic import whose specifier is held in a variable",
    source: 'const spec = "@anthropic-ai/sdk";\nconst late = async () => import(spec);\n',
    expect: "not a string literal",
  },
];

const selfTest = (): boolean => {
  const entry = ENTRIES[0] ?? "";
  const original = readSource(entry) ?? "";
  let ok = true;

  for (const plant of PLANTS) {
    const planted = walk(entry, { file: entry, source: `${plant.source}${original}` });
    const caught = planted.violations.find((v) => v.offence.includes(plant.expect));
    if (!caught) {
      console.error(`verify-no-llm: SELF-TEST FAILED — ${plant.what} was NOT caught.`);
      console.error(`  expected an offence containing ${JSON.stringify(plant.expect)}; got: ${planted.violations.map((v) => v.offence).join(" | ") || "(no violations at all)"}`);
      ok = false;
      continue;
    }
    console.log(`verify-no-llm: self-test passed (${plant.what} caught: ${caught.offence}).`);
  }
  return ok;
};

const main = (): void => {
  const missing = ENTRIES.filter((e) => !fs.existsSync(e));
  if (missing.length > 0) {
    console.error(`verify-no-llm: entry not found: ${missing.join(", ")}`);
    process.exit(1);
  }

  let failed = false;
  const walked = new Set<string>();

  for (const entry of ENTRIES) {
    const { violations, visited } = walk(entry);
    for (const m of visited) walked.add(m);

    // Guard against a vacuous pass: a walker that resolved nothing would also
    // report zero violations.
    if (visited.size < 3) {
      console.error(`verify-no-llm: only ${visited.size} module(s) walked from ${entry} — the graph did not resolve, so this proves nothing.`);
      failed = true;
      continue;
    }

    if (violations.length > 0) {
      failed = true;
      console.error(`verify-no-llm: FAILED from ${entry} — the replay path can reach a model.`);
      for (const v of violations) {
        console.error(`  VIOLATION: ${v.offence}`);
        console.error(`    via ${v.chain.join("\n      -> ")}`);
      }
    }
  }

  if (process.argv.includes("--self-test") && !selfTest()) process.exit(1);

  if (failed) process.exit(1);

  console.log(`verify-no-llm: OK — ${walked.size} modules reachable from ${ENTRIES.join(" and ")}, none of them a model.`);
  console.log(`  forbidden: ${[...FORBIDDEN_PACKAGES, ...FORBIDDEN_PATHS, ...FORBIDDEN_READS].join(", ")}`);
  console.log("  read in each module: static imports, dynamic import() with a literal specifier, and any import() whose specifier is not a literal (refused).");
};

main();
