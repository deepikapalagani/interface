/**
 * SOURCE INVARIANTS — a comment's claim, made checkable instead of trusted.
 *
 * `settle.ts` calls itself "the ONLY module in the replay path permitted to
 * reference a timer", and that claim is load-bearing. Every wait in replay is
 * supposed to be bounded by a DECLARED condition from the artifact; a bare
 * `setTimeout` anywhere else under `src/replay/**` would be an undeclared wait
 * that nothing in the determinism story can see, and the symptom would be a run
 * that passes on a fast machine and fails on a slow one.
 *
 * It is also the wall that keeps the escalation TTL out of the engine. A handoff
 * deadline is a wall-clock timer, and the moment one is armed inside a replay
 * module, replay stops being a function of the artifact and the surface alone.
 * The TTL belongs to the escalation path; this test is what stops it drifting
 * into the engine as that path is built.
 *
 * The claim was previously asserted by the comment only — MEASURED: no such test
 * existed anywhere in the repo. Rather than deleting the sentence, this makes it
 * true. MEASURED at the time of writing: exactly one match under `src/replay`,
 * `settle.ts`'s `defaultSleep`, which is injectable precisely so tests need
 * neither a real clock nor real elapsed time.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPLAY_DIR = fileURLToPath(new URL("../src/replay", import.meta.url));

const tsFiles = (dir: string): string[] =>
  readdirSync(dir)
    .sort()
    .flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return tsFiles(full);
      return full.endsWith(".ts") ? [full] : [];
    });

describe("source invariants", () => {
  it("settle.ts is the ONLY module under src/replay that references a timer", () => {
    const files = tsFiles(REPLAY_DIR);

    // Without this the assertion below passes vacuously on an empty walk — a
    // renamed directory would silently turn the invariant into a no-op, which is
    // worse than having no check at all.
    expect(files.length).toBeGreaterThan(1);

    const withTimer = files
      .filter((f) => /setTimeout|setInterval/.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(REPLAY_DIR, f));

    // Both halves matter: settle.ts must still own a timer (or the injectable
    // sleep has been removed and the comment is stale in the other direction),
    // and nothing else may have acquired one.
    expect(withTimer).toEqual(["settle.ts"]);
  });
});
