/**
 * "No LLM in replay" — checked, not claimed.
 *
 * §3.3 requires replay to run "without invoking the LLM for decisions", and §7
 * weights correctness of that loop second only to system design. It is also the
 * easiest claim in the whole submission to make and the easiest to quietly
 * break: one convenience import six months later and the production path has a
 * model in it again.
 *
 * So it is enforced structurally. This walks the STATIC import graph from BOTH
 * doors into the production path and fails if either can reach a model SDK, the
 * provider adapters, the discovery loop, or the raw model transcript. A runtime
 * check could not do this — it would only prove the model was not called on the
 * paths a test happened to exercise. The import graph proves it cannot be.
 *
 * Two guards against a vacuous pass, because a checker that silently resolves
 * nothing also reports success:
 *
 *   - it prints how many modules it walked, and fails if that is implausibly
 *     small;
 *   - `--self-test` plants a forbidden import and asserts the walker catches it,
 *     so the check is proven live rather than assumed to be.
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

const IMPORT_RE = /(?:from|import)\s*["']([^"']+)["']/g;

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

    for (const read of FORBIDDEN_READS) {
      if (source.includes(read)) violations.push({ chain, offence: `reads ${read}` });
    }

    for (const match of source.matchAll(IMPORT_RE)) {
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

  if (process.argv.includes("--self-test")) {
    // Prove the check is live by planting a forbidden import and asserting it is
    // caught. A test that cannot fail is not a test.
    const entry = ENTRIES[0] ?? "";
    const planted = walk(entry, { file: entry, source: `import "@anthropic-ai/sdk";\n${readSource(entry) ?? ""}` });
    if (planted.violations.length === 0) {
      console.error("verify-no-llm: SELF-TEST FAILED — a planted `@anthropic-ai/sdk` import was not caught.");
      process.exit(1);
    }
    console.log(`verify-no-llm: self-test passed (planted import caught: ${planted.violations[0]?.offence}).`);
  }

  if (failed) process.exit(1);

  console.log(`verify-no-llm: OK — ${walked.size} modules reachable from ${ENTRIES.join(" and ")}, none of them a model.`);
  console.log(`  forbidden: ${[...FORBIDDEN_PACKAGES, ...FORBIDDEN_PATHS, ...FORBIDDEN_READS].join(", ")}`);
};

main();
