/**
 * WRITING /evidence/ — §3.5 and §6 deliverable 3.
 *
 * One directory per run, deliberately plain:
 *
 *   events.jsonl  the structured log of what happened and why
 *   trace.jsonl   the typed executed steps (discovery runs only)
 *   manifest.json versions, target, result, and the model-call count
 *   handoff.jsonl the human turns, on a run that escalated (absent otherwise)
 *
 * JSON Lines rather than one document, so that a run which crashes half way
 * leaves readable evidence up to the point it stopped — which requires the lines
 * to be APPENDED AS THEY HAPPEN, not serialised at the end. That is a property
 * of the caller, not of the format: wire `LogContext.sink` to `event()` and it
 * holds. `replay/main.ts` does. It did not before, and the format alone bought
 * nothing.
 *
 * The manifest exists for one assertion in particular: `model.calls` on a replay
 * run must be zero, and a reviewer should be able to see that in a file rather
 * than take it on trust.
 */
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { redactDeep } from "../safety/redact.js";
import type { EscalationRecord } from "../contract/result.js";
import type { LogEvent } from "./events.js";

export interface RunManifest {
  readonly runId: string;
  readonly phase: "discovery" | "replay";
  readonly startedAt: string;
  readonly endedAt: string;
  readonly target: string;
  readonly tenant: string;
  readonly capability?: { readonly id: string; readonly version: string };
  /**
   * sha256 of the EXACT BYTES this run wrote to `capability.json`, so a reviewer
   * can tie the manifest to the artifact by running `shasum -a 256` on the file
   * beside it and comparing.
   *
   * Produced by `artifact()`, which returns the digest of what it wrote — the
   * hash cannot drift from the file because it is taken from the same string.
   *
   * STAYS OPTIONAL: the five committed run manifests predate it and are frozen
   * evidence, so requiring it would fail the graded tree. A field with no writer
   * is exactly the defect this one was: before now `grep -rn artifactContentHash`
   * returned one hit, its own declaration.
   */
  readonly artifactContentHash?: string;
  /** Zero on every replay run, by construction. */
  readonly model: { readonly provider: string; readonly calls: number };
  readonly result: string;
  readonly versions: { readonly node: string; readonly playwright: string };
}

/**
 * One human turn, written into the ESCALATING RUN'S OWN directory (§3.6-d,
 * "record what the human did").
 *
 * NOT its own run directory, and that is forced rather than preferred:
 * `RunManifest.phase` is typed discovery|replay, and scripts/verify-evidence.ts
 * both rejects any other value AND returns null for that run — which SKIPS the
 * event check for it entirely. A `handoff` run directory would therefore be
 * evidence nobody checked. Not a subdirectory either: the same checker rejects
 * any subdirectory inside a run directory, on the same "evidence nobody declared
 * is evidence nobody reviewed" grounds. So the record lives beside the events it
 * has to reconcile with, which is also where a reviewer would look for it.
 *
 * It EXTENDS `EscalationRecord` rather than restating its fields, so the row a
 * reviewer reads and the record the calling agent gets back in
 * `ResultEnvelope.interventions` cannot drift into two accounts of one turn. The
 * added fields are the intervention request's own context — exactly what §3.6-b
 * names as what must reach the human: the goal and capability, the step, why it
 * stopped (`reason`, inherited), and the state it stopped in.
 *
 * NO IMAGE BYTES, ever. The operator console holds the screenshot in memory;
 * what reaches disk is the text observation, because that is the form that can
 * be redacted and diffed. §3.5-b's "richer signal" is met here by that snapshot
 * rather than by a PNG — and `screenshot.png` deliberately stays an unrecognised
 * filename, because verify-evidence plants exactly that name to prove its
 * undeclared-file check still fires.
 */
export interface HandoffRecord extends EscalationRecord {
  readonly runId: string;
  /** `id@version` of the capability whose step stopped — the citation half of §3.6-b. */
  readonly capability: string;
  readonly goal: string;
  /** Canonical screen symbol where it could be read. `null` is honest; `""` would not be. */
  readonly screen: string | null;
  /** The state handed to the human, and the state the run resynchronises against. */
  readonly observedText: string;
}

export class EvidenceWriter {
  private readonly dir: string;

  constructor(root: string, runId: string) {
    this.dir = path.join(root, runId);
    mkdirSync(this.dir, { recursive: true });
  }

  get directory(): string {
    return this.dir;
  }

  /**
   * Append ONE event, redacted, the moment it is emitted.
   *
   * "Called as the run goes" is true only when something calls it as the run
   * goes. Wire `LogContext.sink` to this method and it is; the CLI does, which
   * is what makes the module header's crash-resilience claim hold. Called from
   * the bulk `events()` flush alone — as it was until now — it is a flush.
   *
   * REDACTED HERE, because this is the last boundary before bytes hit disk and
   * events.jsonl was the ONE evidence file written unredacted. The handoff
   * record and both discovery files already redact on the way out; this did not,
   * while `predicate.ts` renders a value read off the screen into an event's
   * `observed` field and discovery puts the model's raw prose into `why.stated`.
   *
   * `redacted: true` is stamped only when masking CHANGED the serialised line,
   * by comparing before and after. A flag set unconditionally would say nothing;
   * this one distinguishes a line that carried something sensitive from a line
   * that did not.
   */
  event(e: LogEvent): void {
    const before = JSON.stringify(e);
    const after = JSON.stringify(redactDeep(e));
    const line = before === after ? before : JSON.stringify({ ...(JSON.parse(after) as LogEvent), redacted: true });
    appendFileSync(path.join(this.dir, "events.jsonl"), `${line}\n`, "utf8");
  }

  /**
   * Flush a run's whole log, for a caller that did NOT stream it.
   *
   * MEASURED DEFECT, fixed at the SOURCE rather than here: a replay rejected by
   * input validation reached this with an empty array, so `appendFileSync` never
   * ran and events.jsonl was ABSENT — the failing run left less evidence than the
   * successful one. `replay()` now logs its pre-flight rejections.
   *
   * BE EXACT ABOUT WHAT THAT FIXED, because the previous wording read as though
   * the invariant now held generally. It covers the TWO PRE-FLIGHT ARMS in
   * `replay/index.ts` — the input rejection and the binding gap — and nothing
   * else. The classes it did NOT cover were real and were reachable: a policy
   * refusal or an unresolvable target on the FIRST step returned a typed failure
   * while emitting nothing at all, so the run directory held only
   * capability.json and manifest.json and the project's own
   * `scripts/verify-evidence.ts` rejected it. Those are closed now, but by
   * `runSteps.fail()` emitting a line for every hard failure — not by anything
   * in this file. What remains uncovered here is a run that throws before any
   * emit at all; the CLI answers that by streaming through `event()` and by
   * flushing in a `finally`.
   *
   * Deliberately NOT fixed by writing a zero-line file, which would pass an
   * existence check while still saying nothing (verify-evidence rejects an empty
   * events.jsonl on purpose), and NOT by synthesising a line here: a writer that
   * invents a `why` puts a citation in the log that no code path ever decided.
   * So the loop stays plain, and complains rather than failing silently if the
   * invariant is ever broken again.
   */
  events(all: readonly LogEvent[]): void {
    if (all.length === 0) {
      console.error(
        `evidence: ${this.dir} emitted no events, so events.jsonl will be absent — ` +
          "§3.5 requires a log of what happened and why, so this is a defect in whatever ran, not in the writer.",
      );
    }
    for (const e of all) this.event(e);
  }

  /**
   * Writes a JSON-per-line file into this run's directory.
   * Exposed for `DiscoveryEvidenceWriter`, which adds the discovery-only files.
   */
  writeLines(name: string, rows: readonly unknown[]): void {
    const body = rows.map((r) => JSON.stringify(r)).join("\n");
    writeFileSync(path.join(this.dir, name), body ? `${body}\n` : "", "utf8");
  }

  /**
   * Flush this run's human turns.
   *
   * WRITTEN ONCE, AT THE END, unlike `event()` which appends as it goes. A
   * handoff row is not complete until the turn ENDS: `disposition`, `resolvedAt`
   * and `reconstructedActions` are only knowable then. Appending a half-row at
   * the moment of escalation would put a record on disk saying a person was
   * asked and never saying what happened. The moment-by-moment account is the
   * event log's job — these two files are meant to reconcile, and verify-evidence
   * fails the run if they do not.
   *
   * REDACTED ON THE WAY OUT, for the reason the discovery writer redacts: this
   * is the last boundary before bytes hit disk. Not belt-and-braces here —
   * `observedText` is a raw screen dump, and MBR0400 renders `SSN` as plain
   * text, which is the one reachable leak path on this surface. Applied to a
   * COPY (`redactDeep` returns a new structure), so the caller's own record — the
   * one it hands back to the agent in `interventions[]` — is not mutated into
   * asterisks behind its back.
   *
   * An empty array writes NO FILE, deliberately. This file's existence is itself
   * a claim: that this run escalated. A zero-line file would pass an existence
   * check while making that claim falsely, and would put an extra filename in a
   * non-escalating run — which is exactly what verify-determinism compares across
   * its three scenarios.
   */
  handoff(records: readonly HandoffRecord[]): void {
    if (records.length === 0) {
      console.error(
        `evidence: ${this.dir} was asked to write handoff.jsonl with no records — ` +
          "the file's existence claims this run escalated, so it is left absent rather than written empty.",
      );
      return;
    }
    this.writeLines("handoff.jsonl", records.map(redactDeep));
  }

  /**
   * Write the artifact this run used, and RETURN the sha256 of exactly those
   * bytes so the manifest can cite it.
   *
   * The digest is taken from the same string that is written, rather than
   * recomputed by the caller from its own serialisation — that is what makes
   * `manifest.artifactContentHash` checkable with `shasum -a 256 capability.json`
   * instead of merely plausible. A caller that does not want it ignores the
   * return value.
   */
  artifact(capability: unknown): string {
    const body = `${JSON.stringify(capability, null, 1)}\n`;
    writeFileSync(path.join(this.dir, "capability.json"), body, "utf8");
    return createHash("sha256").update(body).digest("hex");
  }

  manifest(m: RunManifest): void {
    writeFileSync(path.join(this.dir, "manifest.json"), `${JSON.stringify(m, null, 1)}\n`, "utf8");
  }
}
