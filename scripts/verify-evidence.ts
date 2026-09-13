/**
 * /evidence/ — checked, not asserted.
 *
 * §6 asks for an evidence directory and §3.5 for "a structured log of what the
 * agent did and why". Both are easy to satisfy in appearance: a directory full
 * of plausible JSON looks like evidence whether or not it is complete, internally
 * consistent, or safe to publish. A reviewer cannot tell by reading it, and
 * neither can a future change to the writers.
 *
 * So the deliverable is checked mechanically. Three properties, in order of how
 * badly they fail if wrong:
 *
 *   COMPLETE      `seq` is gapless per run. A log with a hole in it cannot be
 *                 distinguished from a log that was quietly truncated, so a
 *                 missing line must be detectable rather than merely absent.
 *                 This reads the FILE, not `EventSequencer.isComplete()`, which
 *                 only ever inspected an in-memory array and therefore cannot
 *                 see the duplicate `seq 1..N` that re-running a CLI with an
 *                 existing --run-id appends (measured: `event()` uses
 *                 appendFileSync while every other writer truncates).
 *
 *   CONSISTENT    the manifest's claims match the run's own files — and the two
 *                 sides of the `model.calls` claim are NOT equally checked, so
 *                 this says which is which rather than "neither is taken on
 *                 trust", which was false of the replay half.
 *                 On DISCOVERY the count is cross-examined against the assistant
 *                 turns in the run's own transcript, so a false `calls: 0` is
 *                 provably false. That check is one-sided — it can only catch an
 *                 UNDERCOUNT — and a run that commits no transcript evades it
 *                 entirely.
 *                 On REPLAY the only rule is `calls === 0`: that the file says
 *                 what it is supposed to say. Nothing here can tell a truthful
 *                 zero from a written one. The structural argument for the replay
 *                 claim is not in this script at all — it is
 *                 `verify-no-llm.ts`, which reads the import graph.
 *
 *   SAFE          no secret or raw PII anywhere under evidence/ (§3.4-e). The
 *                 seeded PAN/SSN literals and the live MODEL_API_KEY are read at
 *                 RUNTIME from mock/seed.ts and .env rather than copied here, so
 *                 the detector cannot go stale against a reseed or a key
 *                 rotation — and so that this file never itself contains a
 *                 secret. Offences name the label, never the value.
 *
 * TWO MEASURED CHOICES worth recording, because the obvious version of each is
 * wrong:
 *
 *   - The card-number shape is `(?<![\w-])\d{13,19}(?![\w-])`. Measured
 *     2026-09-12 over the committed evidence: the bare `\b\d{13,19}\b` form
 *     produces 24 hits, every one a Z.ai tool-call id of the form
 *     `call_-7267060200698277786`. The guarded form produces 0. A detector that
 *     cries wolf 24 times is a detector nobody reads. The schema carried the
 *     bare form until 2026-09-12; all three detectors now share this one.
 *
 *   - No Luhn filter. MEASURED 2026-09-12 across every 13-19 digit run in the
 *     committed evidence — 7 distinct values, 5 Luhn-invalid and 2 Luhn-VALID,
 *     one of them the tool-call id `7266999899357443983` — against all four
 *     seeded PANs, every one Luhn-INVALID by construction. So a Luhn gate here
 *     would suppress every genuine leak and keep a false positive: exactly
 *     backwards on this data.
 *
 * Guards against a vacuous pass, because a checker that finds nothing to inspect
 * also reports success:
 *
 *   - it fails if there are no run directories, or if the secret ground truth
 *     could not be sourced from mock/seed.ts;
 *   - it prints how many runs and files it scanned;
 *   - `--self-test` builds a deliberately broken evidence tree in a temp
 *     directory and asserts each planted defect is caught by the check that owns
 *     it.
 *
 *     It did NOT prove that one-by-one until 2026-09-13, and the correction is
 *     worth keeping: the expected-offence needles were plain substrings that
 *     cross-satisfied one another, so "missing required field" was answered
 *     equally by the manifest loop, the event loop, the why-arm loop and the
 *     handoff loop. MEASURED: a reviewer deleted the ENTIRE manifest
 *     required-fields loop and the self-test still reported every class caught,
 *     exit 0. Every offence now carries a prefix naming the record it came from
 *     ("the manifest is missing…", "an event line is missing…", "why arm …",
 *     "a handoff record is missing…") and every needle includes that prefix, so
 *     deleting a check leaves its own needle unmatched and nothing else's.
 *
 * Run: npx tsx scripts/verify-evidence.ts [--self-test]
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { safeParseCapability } from "../src/capability/schema.js";

const RUN_ROOT = "evidence/runs";
const SCAN_ROOT = "evidence";

/**
 * The complete set of filenames any writer produces, measured across
 * EvidenceWriter (events/capability/manifest/handoff) and
 * DiscoveryEvidenceWriter (trace/transcript). An unrecognised file in a graded
 * deliverable is an unreviewed file, which is the leak vector this whole script
 * exists for — so adding a writer means adding its name here, deliberately.
 *
 * `handoff.jsonl` was added when `EvidenceWriter.handoff` began producing it,
 * and DECLARING a name is only half the job: a name listed here is a name this
 * script stops complaining about, so each one has to be EARNED by a check that
 * can fail. `checkHandoff` below is that check, and `--self-test` plants a
 * broken row to prove it fires rather than assuming it would.
 *
 * Deliberately NOT added: `screenshot.png`. selfTest plants that exact filename
 * to prove the undeclared-file check still works, so listing it here would
 * silently gut a self-test expectation — and image bytes cannot be redacted on
 * the way out, which is why a handoff record carries the text observation
 * instead of a PNG.
 */
const KNOWN_FILES = ["events.jsonl", "capability.json", "manifest.json", "trace.jsonl", "transcript.jsonl", "handoff.jsonl"];

/** Discovery-only by construction: replay must work from the artifact, never a model transcript. */
const DISCOVERY_ONLY_FILES = ["trace.jsonl", "transcript.jsonl"];

const MANIFEST_FIELDS = ["runId", "phase", "startedAt", "endedAt", "target", "tenant", "model", "result", "versions"];

/**
 * Declared but optional — and the manifest is now held to the SAME closed-record
 * rule this script applies to why-arms and handoff records.
 *
 * It was the one record exempt from it, and every committed manifest already
 * carried an undeclared `capability` key: the rule "an undeclared field is one no
 * redactor was written for and no reviewer reads" was being argued in two places
 * and enforced in two of three. `capability` is declared here and its shape is
 * checked below.
 *
 * `artifactContentHash` ties a run to the exact artifact bytes it replayed.
 * Declared whether or not a writer emits it yet: naming a field that never
 * appears costs nothing, while leaving it undeclared would turn its arrival into
 * an offence.
 */
const MANIFEST_OPTIONAL_FIELDS = ["capability", "artifactContentHash"];

const PHASES = ["discovery", "replay", "handoff"];
const CONTROL_OWNERS = ["automation", "human", "released"];

const EVENT_FIELDS = ["seq", "at", "runId", "phase", "controlOwner", "event", "stepRef", "why"];

/**
 * The six arms of `Why`, with the type each field must carry. Checked by field
 * AND by type because the discriminant is the only thing separating a belief
 * (`model_decision`) from a checkable citation (`artifact_step`) — an arm with
 * the wrong payload is a citation that cannot be followed.
 */
const WHY_ARMS: Readonly<Record<string, Readonly<Record<string, "string" | "number" | "boolean">>>> = {
  model_decision: { stated: "string", model: "string", turn: "number" },
  artifact_step: { capability: "string", version: "string", stepRef: "string" },
  policy: { ruleId: "string", allowed: "boolean", dimension: "string" },
  handler: { ruleId: "string", attempt: "number" },
  outcome_signal: { code: "string", matched: "string" },
  operator: { operator: "string", disposition: "string" },
};

/**
 * A handoff record's shape (§3.6-d), checked by field AND by type for the reason
 * `WHY_ARMS` is.
 *
 * This file and the run's `phase:"handoff"` event lines are two records of ONE
 * control transfer. Two records that are never compared are two chances to be
 * wrong rather than two pieces of evidence, so the reconciliation at the bottom
 * of `checkHandoff` is the rule that matters most here — the field checks only
 * establish that there is something coherent to reconcile.
 *
 * `reconstructedActions` is a string ARRAY, and its name carries the honest
 * limitation: automation cannot observe a human's raw input, so this is what it
 * could reconstruct afterwards, never a keystroke log.
 */
type FieldType = "string" | "nullable-string" | "string[]";

const HANDOFF_FIELDS: Readonly<Record<string, FieldType>> = {
  runId: "string",
  capability: "string",
  goal: "string",
  stepRef: "string",
  reason: "string",
  requestedAt: "string",
  disposition: "string",
  reconstructedActions: "string[]",
  screen: "nullable-string",
  observedText: "string",
};

/** Knowable only once the turn has ended, so absent is legal; typed the same when present. */
const HANDOFF_OPTIONAL_FIELDS: Readonly<Record<string, FieldType>> = {
  resolvedAt: "string",
  operator: "string",
};

/** The three ways a human turn can end, mirroring `EscalationRecord.disposition`. */
const DISPOSITIONS = ["resolved", "abort", "timeout"];

/** Shapes, as a backstop for a leak the exact literals would miss — another tenant's card, a rotated key. */
const LEAK_SHAPES = [
  { what: "a card-number-shaped literal", re: /(?<![\w-])\d{13,19}(?![\w-])/g },
  { what: "an SSN-shaped literal", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { what: "a bearer token", re: /\bbearer\s+[A-Za-z0-9._~+/=-]{16,}/gi },
  { what: "an api-key assignment", re: /\b(?:api[_-]?key|access[_-]?token|secret)["' :=]+[A-Za-z0-9._~+/=-]{16,}/gi },
];

interface Problem {
  readonly where: string;
  readonly offence: string;
}

/**
 * Exact values to hunt for, sourced at runtime. `label` is what gets printed;
 * `value` never is.
 *
 * `kind` exists so the ground-truth floor in `main` can be PER CLASS. Counting
 * PANs and SSNs in one list meant a reseed that changed only the SSN rendering
 * would keep the floor satisfied while that whole class of ground truth silently
 * vanished — which is the failure mode the floor exists to prevent, one level in.
 */
type SecretKind = "PAN" | "SSN" | "key";

interface Secret {
  readonly label: string;
  readonly value: string;
  readonly kind: SecretKind;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Strict: round-tripping through Date rejects "2026-13-45" and also the merely
 * sloppy ("2026-9-12T5:00Z"), which a bare Date.parse would wave through.
 */
const isIsoInstant = (v: unknown): boolean => {
  if (typeof v !== "string" || Number.isNaN(Date.parse(v))) return false;
  return new Date(v).toISOString() === v;
};

const readText = (file: string): string | null => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

const filesUnder = (dir: string): string[] => {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...filesUnder(p));
    else out.push(p);
  }
  return out;
};

/**
 * The seeded PAN/SSN literals, read from the mock's own seed rather than copied.
 * A copy would drift silently on a reseed and the detector would keep passing.
 */
const seededLiterals = (): Secret[] => {
  const source = readText("mock/seed.ts");
  if (source === null) return [];
  const out: Secret[] = [];
  for (const m of source.matchAll(/pan:\s*"(\d{12,19})"/g)) {
    const v = m[1];
    if (v) out.push({ label: `seeded PAN ...${v.slice(-4)}`, value: v, kind: "PAN" });
  }
  for (const m of source.matchAll(/"(\d{3}-\d{2}-\d{4})"/g)) {
    const v = m[1];
    if (v) out.push({ label: `seeded SSN ...${v.slice(-4)}`, value: v, kind: "SSN" });
  }
  return out;
};

/**
 * The live model key — and whether this detector EXISTS on this machine.
 *
 * It reads `.env`, which is gitignored, so in any clone there is nothing to
 * source and the by-value key detector silently ceases to exist. The script used
 * to report "no secrets or PII found" either way, which reads as a clean scan
 * rather than as a scan that could not look. `active` is now carried out to the
 * summary so the reader is told which of the two they are looking at.
 *
 * Short values are ignored deliberately: an unset or placeholder key would
 * otherwise be a substring that matches half the tree and buries the real signal.
 */
interface KeyDetector {
  readonly secrets: readonly Secret[];
  readonly active: boolean;
  /** Why it is inactive. Empty when it is active. */
  readonly why: string;
}

const liveKeyDetector = (): KeyDetector => {
  const source = readText(".env");
  if (source === null) {
    return { secrets: [], active: false, why: ".env is not present — it is gitignored, so this is every clone" };
  }
  const out: Secret[] = [];
  for (const line of source.split("\n")) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1];
    const value = (m[2] ?? "").trim().replace(/^["']|["']$/g, "");
    if (name !== "MODEL_API_KEY" || value.length < 16) continue;
    out.push({ label: "the live MODEL_API_KEY from .env", value, kind: "key" });
  }
  if (out.length === 0) {
    return { secrets: [], active: false, why: ".env carries no MODEL_API_KEY of 16 or more characters" };
  }
  return { secrets: out, active: true, why: "" };
};

const checkJsonl = (file: string, text: string, problems: Problem[]): unknown[] => {
  const rows: unknown[] = [];
  if (text.length > 0 && !text.endsWith("\n")) {
    problems.push({ where: file, offence: "does not end with a newline, so the last line may be truncated" });
  }
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    try {
      rows.push(JSON.parse(line));
    } catch {
      problems.push({ where: `${file}:${i + 1}`, offence: "line is not valid JSON" });
    }
  });
  return rows;
};

const checkWhy = (where: string, why: unknown, problems: Problem[]): string | null => {
  if (!isRecord(why)) {
    problems.push({ where, offence: "why is not an object" });
    return null;
  }
  const as = why["as"];
  if (typeof as !== "string" || !(as in WHY_ARMS)) {
    problems.push({ where, offence: `why.as ${JSON.stringify(as)} is not one of the six legal arms (${Object.keys(WHY_ARMS).join(", ")})` });
    return null;
  }
  const arm = WHY_ARMS[as] ?? {};
  for (const [field, type] of Object.entries(arm)) {
    if (!(field in why)) {
      problems.push({ where, offence: `why arm "${as}" is missing required field "${field}"` });
    } else if (typeof why[field] !== type) {
      problems.push({ where, offence: `why.${field} should be ${type} on arm "${as}", got ${typeof why[field]}` });
    }
  }
  for (const field of Object.keys(why)) {
    if (field !== "as" && !(field in arm)) {
      problems.push({ where, offence: `why carries "${field}", which arm "${as}" does not declare` });
    }
  }
  return as;
};

/**
 * Returns how many lines carried `phase:"handoff"`, so a handoff.jsonl in the
 * same directory can be reconciled against the transitions the log actually
 * recorded rather than merely coexisting with them.
 */
const checkEvents = (
  file: string,
  text: string,
  manifestPhase: string,
  runId: string,
  problems: Problem[],
): number => {
  const rows = checkJsonl(file, text, problems);
  if (rows.length === 0) {
    problems.push({ where: file, offence: "contains no events, so the run left no trail of what it did" });
    return 0;
  }

  let handoffLines = 0;
  let previousAt = "";
  rows.forEach((row, i) => {
    const where = `${file}:${i + 1}`;
    if (!isRecord(row)) {
      problems.push({ where, offence: "event is not an object" });
      return;
    }

    for (const field of EVENT_FIELDS) {
      if (!(field in row)) problems.push({ where, offence: `an event line is missing required field "${field}"` });
    }

    // Gaplessness, read from the file. seq is 1-based and dense; anything else
    // means a lost line or an appended re-run.
    if (row["seq"] !== i + 1) {
      problems.push({ where, offence: `seq is ${JSON.stringify(row["seq"])} but should be ${i + 1} — the log has a gap or a duplicate, so it cannot be proven complete` });
    }

    if (!isIsoInstant(row["at"])) {
      problems.push({ where, offence: `an event line's at ${JSON.stringify(row["at"])} is not an ISO-8601 instant` });
    } else if (typeof row["at"] === "string") {
      if (previousAt !== "" && row["at"] < previousAt) {
        problems.push({ where, offence: `the event log is not in time order: ${row["at"]} precedes the previous line's ${previousAt}` });
      }
      previousAt = row["at"];
    }

    if (row["runId"] !== runId) {
      problems.push({ where, offence: `an event line's runId ${JSON.stringify(row["runId"])} does not match the manifest's "${runId}"` });
    }

    const phase = row["phase"];
    if (typeof phase !== "string" || !PHASES.includes(phase)) {
      problems.push({ where, offence: `phase ${JSON.stringify(phase)} is not one of ${PHASES.join(", ")}` });
    } else if (phase === "handoff") {
      // A handoff line inside either kind of run is legitimate — that IS the
      // control transfer, recorded on the run it interrupted rather than in a
      // run directory of its own, which the manifest's phase union forbids.
      handoffLines += 1;
    } else if (phase !== manifestPhase) {
      problems.push({ where, offence: `phase "${phase}" in a "${manifestPhase}" run` });
    }

    const owner = row["controlOwner"];
    if (typeof owner !== "string" || !CONTROL_OWNERS.includes(owner)) {
      problems.push({ where, offence: `controlOwner ${JSON.stringify(owner)} is not one of ${CONTROL_OWNERS.join(", ")}` });
    }

    if (!("stepRef" in row) || (row["stepRef"] !== null && typeof row["stepRef"] !== "string")) {
      problems.push({ where, offence: "stepRef must be present, as a string or null" });
    }

    const arm = checkWhy(where, row["why"], problems);

    // The one arm that is a BELIEF rather than a citation. If replay can assert
    // a model decision, the no-model-in-the-loop claim is false on its own
    // evidence — so this is a defect wherever it appears outside discovery.
    if (arm === "model_decision" && manifestPhase !== "discovery") {
      problems.push({ where, offence: `a model_decision event in a "${manifestPhase}" run — replay decides from the artifact, never from a model` });
    }
  });

  return handoffLines;
};

const typeMatches = (value: unknown, type: FieldType): boolean => {
  if (type === "string") return typeof value === "string";
  if (type === "nullable-string") return value === null || typeof value === "string";
  return Array.isArray(value) && value.every((v) => typeof v === "string");
};

/** Names what was actually there, so a type offence is actionable rather than merely negative. */
const describeType = (value: unknown): string =>
  value === null ? "null" : Array.isArray(value) ? "array" : typeof value;

/**
 * The handoff file, checked rather than trusted (§3.6-d).
 *
 * The checker accepted handoff evidence long before any writer could produce it:
 * `PHASES` has always included it and a handoff line inside a replay run has
 * always been permitted by name. What was missing was a reason to believe the
 * record. These rules supply it, and the last one is the point — a settled
 * handoff record whose run never logged a transition is a control transfer
 * asserted in one file and absent from the other.
 */
const checkHandoff = (
  file: string,
  rows: readonly unknown[],
  runId: string,
  handoffEventLines: number,
  problems: Problem[],
): void => {
  if (rows.length === 0) {
    problems.push({
      where: file,
      offence: "handoff.jsonl exists but holds no records — the file's presence claims this run escalated, and nothing inside it supports that claim",
    });
    return;
  }

  rows.forEach((row, i) => {
    const where = `${file}:${i + 1}`;
    if (!isRecord(row)) {
      problems.push({ where, offence: "handoff record is not an object" });
      return;
    }

    for (const [field, type] of Object.entries(HANDOFF_FIELDS)) {
      if (!(field in row)) {
        problems.push({ where, offence: `a handoff record is missing required field "${field}"` });
      } else if (!typeMatches(row[field], type)) {
        problems.push({ where, offence: `handoff field "${field}" should be ${type}, got ${describeType(row[field])}` });
      }
    }

    for (const [field, type] of Object.entries(HANDOFF_OPTIONAL_FIELDS)) {
      if (field in row && !typeMatches(row[field], type)) {
        problems.push({ where, offence: `handoff field "${field}" should be ${type}, got ${describeType(row[field])}` });
      }
    }

    // Unknown fields are rejected for the reason the `why` arms reject them: an
    // undeclared field is one no redactor was written for and no reviewer reads.
    for (const field of Object.keys(row)) {
      if (!(field in HANDOFF_FIELDS) && !(field in HANDOFF_OPTIONAL_FIELDS)) {
        problems.push({ where, offence: `carries "${field}", which a handoff record does not declare` });
      }
    }

    // Skipped when the type check already complained, so one defect yields one
    // offence rather than two saying the same thing.
    const disposition = row["disposition"];
    if (typeof disposition === "string" && !DISPOSITIONS.includes(disposition)) {
      problems.push({ where, offence: `disposition ${JSON.stringify(disposition)} is not one of ${DISPOSITIONS.join(", ")}` });
    }

    for (const field of ["requestedAt", "resolvedAt"]) {
      if (field in row && !isIsoInstant(row[field])) {
        problems.push({ where, offence: `a handoff record's ${field} ${JSON.stringify(row[field])} is not an ISO-8601 instant` });
      }
    }

    const requestedAt = row["requestedAt"];
    const resolvedAt = row["resolvedAt"];
    if (
      isIsoInstant(requestedAt) && isIsoInstant(resolvedAt) &&
      typeof requestedAt === "string" && typeof resolvedAt === "string" && resolvedAt < requestedAt
    ) {
      problems.push({ where, offence: `resolvedAt ${resolvedAt} precedes requestedAt ${requestedAt} — the turn ended before it was raised` });
    }

    if (row["runId"] !== runId) {
      problems.push({ where, offence: `a handoff record's runId ${JSON.stringify(row["runId"])} does not match the manifest's "${runId}"` });
    }
  });

  // The reconciliation, and deliberately ONE-WAY. A handoff EVENT line does not
  // require this file: a transition is logged at the moment it happens, and the
  // row is only settled when the turn ends, so a run can legitimately hold the
  // first without the second. The reverse cannot be legitimate.
  if (handoffEventLines === 0) {
    problems.push({
      where: file,
      offence: 'this run carries handoff.jsonl but no event line with phase "handoff" — the two records do not reconcile, so the control transfer is asserted in one file and absent from the other',
    });
  }
};

const checkManifest = (file: string, raw: unknown, dirName: string, problems: Problem[]): string | null => {
  if (!isRecord(raw)) {
    problems.push({ where: file, offence: "manifest is not an object" });
    return null;
  }

  for (const field of MANIFEST_FIELDS) {
    if (!(field in raw)) problems.push({ where: file, offence: `the manifest is missing required field "${field}"` });
  }

  // The closed-record rule, applied here for the first time. See
  // MANIFEST_OPTIONAL_FIELDS.
  for (const field of Object.keys(raw)) {
    if (!MANIFEST_FIELDS.includes(field) && !MANIFEST_OPTIONAL_FIELDS.includes(field)) {
      problems.push({ where: file, offence: `the manifest carries "${field}", which a manifest does not declare` });
    }
  }

  if ("capability" in raw) {
    const capability = raw["capability"];
    if (!isRecord(capability) || typeof capability["id"] !== "string" || typeof capability["version"] !== "string") {
      problems.push({ where: file, offence: "manifest capability must carry id and version as strings" });
    }
  }

  if ("artifactContentHash" in raw && (typeof raw["artifactContentHash"] !== "string" || raw["artifactContentHash"] === "")) {
    problems.push({ where: file, offence: "manifest artifactContentHash must be a non-empty string when present" });
  }

  if (raw["runId"] !== dirName) {
    problems.push({ where: file, offence: `runId ${JSON.stringify(raw["runId"])} does not match its directory name "${dirName}"` });
  }

  for (const field of ["startedAt", "endedAt"]) {
    if (!isIsoInstant(raw[field])) {
      problems.push({ where: file, offence: `the manifest's ${field} ${JSON.stringify(raw[field])} is not an ISO-8601 instant` });
    }
  }
  const started = raw["startedAt"];
  const ended = raw["endedAt"];
  if (isIsoInstant(started) && isIsoInstant(ended) && typeof started === "string" && typeof ended === "string" && ended < started) {
    problems.push({ where: file, offence: `endedAt ${ended} precedes startedAt ${started}` });
  }

  for (const field of ["target", "tenant", "result"]) {
    if (typeof raw[field] !== "string" || raw[field] === "") {
      problems.push({ where: file, offence: `${field} must be a non-empty string` });
    }
  }

  const versions = raw["versions"];
  if (!isRecord(versions) || typeof versions["node"] !== "string" || typeof versions["playwright"] !== "string") {
    problems.push({ where: file, offence: "versions must carry node and playwright as strings" });
  }

  const phase = raw["phase"];
  if (phase !== "discovery" && phase !== "replay") {
    problems.push({ where: file, offence: `phase ${JSON.stringify(phase)} must be "discovery" or "replay"` });
    return null;
  }

  const model = raw["model"];
  if (!isRecord(model) || typeof model["provider"] !== "string" || typeof model["calls"] !== "number") {
    problems.push({ where: file, offence: "model must carry provider (string) and calls (number)" });
    return phase;
  }

  const calls = model["calls"];
  if (!Number.isInteger(calls) || calls < 0) {
    problems.push({ where: file, offence: `model.calls ${calls} is not a non-negative integer` });
  }

  if (phase === "replay" && calls !== 0) {
    problems.push({ where: file, offence: `a replay run claims model.calls ${calls}; it must be exactly 0 — that claim is the whole point of the replay path` });
  }
  if (phase === "discovery" && calls === 0) {
    problems.push({ where: file, offence: "a discovery run claims model.calls 0, but discovery is LLM-driven by definition — either the run was not real or the count is wrong" });
  }

  return phase;
};

const checkRun = (dir: string, dirName: string, problems: Problem[]): string | null => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // A subdirectory used to exempt its whole contents from the filename
      // check, so `runs/<id>/shots/step1.png` passed as declared evidence.
      // Measured: the leak scan does still walk into it, but the "nobody
      // declared it" property did not hold one level down.
      problems.push({ where: path.join(dir, entry.name), offence: "unrecognised subdirectory in a run directory — evidence nobody declared is evidence nobody reviewed" });
    } else if (!KNOWN_FILES.includes(entry.name)) {
      problems.push({ where: path.join(dir, entry.name), offence: "unrecognised file in a run directory — evidence nobody declared is evidence nobody reviewed" });
    }
  }

  const manifestPath = path.join(dir, "manifest.json");
  const manifestText = readText(manifestPath);
  if (manifestText === null) {
    problems.push({ where: dir, offence: "no manifest.json — the run is unidentifiable" });
    return null;
  }
  let manifestRaw: unknown;
  try {
    manifestRaw = JSON.parse(manifestText);
  } catch {
    problems.push({ where: manifestPath, offence: "manifest.json is not valid JSON" });
    return null;
  }

  const phase = checkManifest(manifestPath, manifestRaw, dirName, problems);
  const runId = isRecord(manifestRaw) && typeof manifestRaw["runId"] === "string" ? manifestRaw["runId"] : dirName;

  let handoffEventLines = 0;
  const eventsPath = path.join(dir, "events.jsonl");
  const eventsText = readText(eventsPath);
  if (eventsText === null) {
    problems.push({ where: dir, offence: "no events.jsonl — §3.5 requires a structured log of what the agent did and why" });
  } else if (phase !== null) {
    handoffEventLines = checkEvents(eventsPath, eventsText, phase, runId, problems);
  }

  const capabilityPath = path.join(dir, "capability.json");
  const capabilityText = readText(capabilityPath);
  if (capabilityText !== null) {
    try {
      const parsed = safeParseCapability(JSON.parse(capabilityText));
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          problems.push({ where: capabilityPath, offence: `fails the capability schema at ${issue.path.join(".") || "(root)"}: ${issue.message}` });
        }
      }
    } catch {
      problems.push({ where: capabilityPath, offence: "capability.json is not valid JSON" });
    }
  }

  for (const name of DISCOVERY_ONLY_FILES) {
    const p = path.join(dir, name);
    const text = readText(p);
    if (text === null) continue;
    if (phase === "replay") {
      problems.push({ where: p, offence: `a replay run carries ${name}, which only a discovery run produces` });
    }
    checkJsonl(p, text, problems);
  }

  // Legal in EITHER kind of run: a discovery run can stall and need a person
  // just as a replay run can, so this is not added to DISCOVERY_ONLY_FILES.
  const handoffPath = path.join(dir, "handoff.jsonl");
  const handoffText = readText(handoffPath);
  if (handoffText !== null) {
    checkHandoff(handoffPath, checkJsonl(handoffPath, handoffText, problems), runId, handoffEventLines, problems);
  }

  // Cross-check the model-call claim against the run's own transcript. This is
  // what turns "calls: 0" from an unfalsifiable field into a checkable one.
  const transcriptText = readText(path.join(dir, "transcript.jsonl"));
  if (transcriptText !== null && phase === "discovery" && isRecord(manifestRaw)) {
    const model = manifestRaw["model"];
    const claimed = isRecord(model) && typeof model["calls"] === "number" ? model["calls"] : -1;
    const assistantTurns = transcriptText
      .split("\n")
      .filter((l) => l.trim() !== "")
      .filter((l) => {
        try {
          const row: unknown = JSON.parse(l);
          return isRecord(row) && row["role"] === "assistant";
        } catch {
          return false;
        }
      }).length;
    if (assistantTurns > claimed) {
      problems.push({ where: manifestPath, offence: `manifest claims model.calls ${claimed} but transcript.jsonl holds ${assistantTurns} assistant turn(s) — the claim is contradicted by the run's own evidence` });
    }
  }

  return phase;
};

const scanForSecrets = (root: string, secrets: readonly Secret[], problems: Problem[]): number => {
  const files = filesUnder(root);
  for (const file of files) {
    const text = readText(file);
    if (text === null) continue;
    for (const s of secrets) {
      // Never print the value; naming it is enough to act on.
      if (text.includes(s.value)) problems.push({ where: file, offence: `contains ${s.label}` });
    }
    for (const shape of LEAK_SHAPES) {
      const hits = [...text.matchAll(shape.re)];
      if (hits.length > 0) problems.push({ where: file, offence: `contains ${shape.what} (${hits.length} occurrence(s))` });
    }
  }
  return files.length;
};

interface Report {
  readonly problems: Problem[];
  readonly runs: number;
  readonly files: number;
  readonly phases: string[];
}

const checkEvidence = (runRoot: string, scanRoot: string, secrets: readonly Secret[]): Report => {
  const problems: Problem[] = [];
  const phases: string[] = [];

  let dirs: string[] = [];
  try {
    dirs = fs.readdirSync(runRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    problems.push({ where: runRoot, offence: "no run directory at all — /evidence/ is a required deliverable (§6)" });
  }

  for (const name of dirs) {
    const phase = checkRun(path.join(runRoot, name), name, problems);
    if (phase !== null) phases.push(phase);
  }

  const files = scanForSecrets(scanRoot, secrets, problems);
  return { problems, runs: dirs.length, files, phases };
};

/**
 * Builds a deliberately broken evidence tree and asserts that each planted
 * defect is caught BY THE CHECK THAT OWNS IT.
 *
 * Every needle below names the record it belongs to, and no needle is a
 * substring of another. That is the whole correction of 2026-09-13: with plain
 * shared substrings, deleting the manifest required-fields loop outright still
 * left every expectation satisfied by some other loop's message, and this
 * self-test reported all classes caught. The rule now is that one deleted check
 * leaves exactly one needle unmatched.
 */
const selfTest = (secrets: readonly Secret[]): boolean => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "verify-evidence-"));
  const expectations: { readonly needle: string; readonly proves: string }[] = [
    { needle: "the manifest is missing required field", proves: "manifest required fields" },
    { needle: "the manifest carries", proves: "the manifest is a CLOSED record" },
    { needle: "manifest capability must carry", proves: "the declared capability field's shape" },
    { needle: "does not match its directory name", proves: "manifest runId matches its directory" },
    { needle: "the manifest's startedAt", proves: "manifest timestamps" },
    { needle: "an event line is missing required field", proves: "event required fields" },
    { needle: "an event line's runId", proves: "event runId matches the manifest" },
    { needle: "the event log is not in time order", proves: "events are in time order" },
    { needle: "is not one of automation, human, released", proves: "controlOwner is a closed set" },
    { needle: "the log has a gap", proves: "gapless seq" },
    { needle: "not one of the six legal arms", proves: "legal why arms" },
    { needle: 'why arm "model_decision" is missing required field', proves: "per-arm required fields" },
    { needle: "a model_decision event in a", proves: "model_decision is discovery-only" },
    { needle: "must be exactly 0", proves: "replay claims zero model calls" },
    { needle: "line is not valid JSON", proves: "JSONL well-formedness" },
    { needle: "fails the capability schema", proves: "the real capability schema" },
    { needle: "unrecognised file", proves: "no undeclared evidence files" },
    { needle: "a handoff record is missing required field", proves: "handoff required fields" },
    { needle: 'handoff field "stepRef" should be string, got number', proves: "handoff field types" },
    { needle: "which a handoff record does not declare", proves: "handoff rejects unknown fields" },
    { needle: "is not one of resolved, abort, timeout", proves: "handoff disposition is a closed set" },
    { needle: "a handoff record's runId", proves: "handoff runId matches the manifest" },
    { needle: "no event line with phase", proves: "handoff.jsonl reconciles with the event log" },
  ];
  for (const s of secrets) expectations.push({ needle: `contains ${s.label}`, proves: `leak of ${s.label}` });

  try {
    const bad = path.join(tmp, "runs", "replay-broken");
    fs.mkdirSync(bad, { recursive: true });

    // A replay manifest broken six ways: it claims model calls, carries a runId
    // that matches neither its directory nor its own event lines, a malformed
    // startedAt, no tenant, a `capability` missing its version, and a `notes`
    // field no writer declares.
    fs.writeFileSync(path.join(bad, "manifest.json"), JSON.stringify({
      runId: "replay-WRONG",
      phase: "replay",
      startedAt: "2026-13-45T99:99:99Z",
      endedAt: "2026-09-12T18:00:00.000Z",
      target: "http://localhost:7101/",
      capability: { id: "msc.card.set_status" },
      model: { provider: "glm-4.7-flash", calls: 2 },
      result: "success",
      versions: { node: "20.17.0", playwright: "1.63.0" },
      notes: "a field nobody declared",
    }));

    // seq jumps 1 -> 3; one arm is illegal; one arm is missing a field; a
    // model_decision appears in a replay run; the third line has no
    // controlOwner and steps BACKWARDS in time; and one line is not JSON.
    const line = (o: unknown): string => `${JSON.stringify(o)}\n`;
    fs.writeFileSync(path.join(bad, "events.jsonl"),
      line({ seq: 1, at: "2026-09-12T18:00:00.000Z", runId: "replay-broken", phase: "replay", controlOwner: "automation", event: "step.acted", stepRef: "s01", why: { as: "vibes" } }) +
      line({ seq: 3, at: "2026-09-12T18:00:01.000Z", runId: "replay-broken", phase: "replay", controlOwner: "automation", event: "step.acted", stepRef: "s02", why: { as: "model_decision", stated: "because", model: "glm" } }) +
      line({ seq: 3, at: "2026-09-12T17:59:00.000Z", runId: "replay-broken", phase: "replay", event: "step.acted", stepRef: "s03", why: { as: "artifact_step", capability: "c", version: "1.0.0", stepRef: "s03" } }) +
      "{not json\n");

    fs.writeFileSync(path.join(bad, "capability.json"), JSON.stringify({ schemaVersion: 1 }));
    fs.writeFileSync(path.join(bad, "trace.jsonl"), "");
    fs.writeFileSync(path.join(bad, "screenshot.png"), "not really a png");

    // A handoff record broken four ways at once: `goal` absent, `stepRef` the
    // wrong type, `epoch` a field no writer declares — the exact smuggling route
    // the field check exists to close, since a per-run-varying value riding on a
    // record is how non-reproducible data reaches a graded deliverable — and a
    // disposition outside the three the contract allows. The run it sits in has
    // no phase:"handoff" event line either, so the reconciliation fires too.
    fs.writeFileSync(path.join(bad, "handoff.jsonl"), line({
      runId: "replay-broken",
      capability: "msc.card.set_status@1.0.0",
      stepRef: 4,
      reason: "policy rated the effective risk irreversible",
      requestedAt: "2026-09-12T18:00:00.000Z",
      disposition: "maybe",
      reconstructedActions: ["navigated to the card services screen"],
      screen: "CARD_SERVICES",
      observedText: "MBR0400 MEMBER DETAIL",
      epoch: 1,
    }));

    // Plant every secret the real scan hunts for, so the detector is proven to
    // catch the exact values rather than only the shapes.
    fs.writeFileSync(path.join(bad, "transcript.jsonl"),
      line({ role: "assistant", content: secrets.map((s) => s.value).join(" ") }));

    const report = checkEvidence(path.join(tmp, "runs"), tmp, secrets);
    const all = report.problems.map((p) => p.offence).join("\n");

    const unproven = expectations.filter((e) => !all.includes(e.needle));
    if (unproven.length > 0) {
      console.error("verify-evidence: SELF-TEST FAILED — planted defects that were not caught:");
      for (const u of unproven) console.error(`  ${u.proves} (no offence matched ${JSON.stringify(u.needle)})`);
      return false;
    }
    console.log(`verify-evidence: self-test passed (${expectations.length} planted defect classes, all caught).`);
    return true;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};

const main = (): void => {
  const seeded = seededLiterals();
  const key = liveKeyDetector();
  const secrets: readonly Secret[] = [...seeded, ...key.secrets];

  /**
   * Ground-truth floor, PER CLASS.
   *
   * If the seed literals could not be sourced, the leak scan would still report
   * a clean tree — the worst possible failure mode. Counting both classes in one
   * total left a quieter version of the same hole: a reseed that changed only
   * the SSN rendering would keep the total above zero while SSN ground truth
   * vanished entirely, and the scan would go on reporting clean.
   */
  const counts: Readonly<Record<"PAN" | "SSN", number>> = {
    PAN: seeded.filter((s) => s.kind === "PAN").length,
    SSN: seeded.filter((s) => s.kind === "SSN").length,
  };
  const missingClasses = (["PAN", "SSN"] as const).filter((k) => counts[k] === 0);
  if (missingClasses.length > 0) {
    console.error(
      `verify-evidence: could not source any ${missingClasses.join(" or ")} literal from mock/seed.ts ` +
        `(found ${counts.PAN} PAN, ${counts.SSN} SSN) — that class of leak would go undetected while the scan still reported clean, so this is a failure.`,
    );
    process.exit(1);
  }

  // Said BEFORE the result, so it is visible whether this run passes or fails.
  if (!key.active) {
    console.warn(
      `verify-evidence: NOTE — the live MODEL_API_KEY detector is INACTIVE (${key.why}). ` +
        "What follows is a scan for the seeded PII literals and the leak shapes only.",
    );
  }

  if (process.argv.includes("--self-test") && !selfTest(secrets)) process.exit(1);

  const { problems, runs, files, phases } = checkEvidence(RUN_ROOT, SCAN_ROOT, secrets);
  let failed = problems.length > 0;

  // A tree with no runs, or with only one kind of run, cannot demonstrate the
  // discovery -> artifact -> replay through-line the submission rests on.
  if (runs === 0) {
    console.error(`verify-evidence: no run directories under ${RUN_ROOT} — nothing was checked, so this proves nothing.`);
    failed = true;
  }
  if (runs > 0 && !phases.includes("discovery")) {
    console.error("verify-evidence: no discovery run in evidence — §4 requires at least one real LLM-driven run.");
    failed = true;
  }
  if (runs > 0 && !phases.includes("replay")) {
    console.error("verify-evidence: no replay run in evidence — §6 requires logs from a replay run, and without one the zero-model claim is untested by any file.");
    failed = true;
  }

  if (problems.length > 0) {
    console.error(`verify-evidence: FAILED — ${problems.length} problem(s) across ${runs} run(s) under ${RUN_ROOT}.`);
    for (const p of problems) {
      console.error(`  PROBLEM: ${p.offence}`);
      console.error(`    in ${p.where}`);
    }
  }

  if (failed) process.exit(1);

  // Deliberately NOT "no secrets or PII found": this scan can only report that
  // the literals it was GIVEN do not appear, and which literals it was given
  // depends on what it could source. Both are stated.
  console.log(`verify-evidence: OK — ${runs} run(s) under ${RUN_ROOT} complete and consistent, ${files} file(s) scanned, no seeded PII literal and no leak shape found.`);
  console.log(`  checked: manifest shape (a closed record), gapless seq, why arms, handoff records against their phase:"handoff" event lines, model-call claims vs transcript, capability schema, ${secrets.length} secret literal(s) — ${counts.PAN} PAN, ${counts.SSN} SSN, ${key.secrets.length} key — + ${LEAK_SHAPES.length} leak shapes`);
  console.log(
    `  live MODEL_API_KEY detector: ${
      key.active
        ? "ACTIVE (sourced from .env at runtime)"
        : `INACTIVE — ${key.why}. A committed key would be caught only by the api-key SHAPE above, never by value.`
    }`,
  );
};

main();
