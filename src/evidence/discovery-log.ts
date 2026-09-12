/**
 * The two evidence files only a DISCOVERY run produces.
 *
 * Split out from `EvidenceWriter` deliberately. Replay has no trace and no
 * transcript, so it should not depend on a module that knows how to write them —
 * and `verify-no-llm.ts` is what noticed: walking the CLI's import graph reached
 * a file mentioning `transcript.jsonl`, which is exactly the coupling §2 item 3
 * warns about, even though nothing was reading it.
 *
 * The alternative was to loosen the checker so the match stopped firing. That
 * would have spent the one mechanism protecting the submission's most weighted
 * claim in order to keep a convenience, so the architecture moved instead.
 *
 * BOTH FILES ARE REDACTED ON THE WAY OUT (§3.4-e), and that is not belt-and-
 * braces layered on the model-facing serialiser. The serialiser governs only
 * what the model is SHOWN. These two files also hold what the model SAID, the
 * provider's raw payload for every turn, and the literals the run typed — so a
 * model that reads `SSN 900-55-0101` off MBR0400 and quotes it back in its own
 * prose lands it in the record by a path the serialiser never touches. This is
 * the last boundary before bytes hit disk, which is why the policy is applied
 * here rather than trusted to have happened upstream.
 *
 * Applied to a COPY, deliberately: the discovery CLI hands the same trace array
 * to this writer and to the compiler, so redacting in place would put a masked
 * literal into the artifact and the capability would replay by typing asterisks
 * into the application.
 */
import { redactDeep, redactTypedValue } from "../safety/redact.js";
import { EvidenceWriter } from "./log.js";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A typed literal is redacted by the FIELD it was typed into, because a passcode
 * is an ordinary word and no shape rule can see one.
 *
 * The narrowing is defensive rather than a contract change — `trace()` still
 * takes `unknown`, and an entry not carrying this shape is redacted by shape
 * alone, so the writer stays ignorant of the trace's type.
 */
const redactTraceEntry = (entry: unknown): unknown => {
  if (!isRecord(entry) || typeof entry["value"] !== "string") return redactDeep(entry);

  const target = entry["target"];
  const fieldIdentity = isRecord(target) && typeof target["id"] === "string" ? target["id"] : null;
  const redacted = redactDeep(entry);
  return isRecord(redacted) ? { ...redacted, value: redactTypedValue(fieldIdentity, entry["value"]) } : redacted;
};

export class DiscoveryEvidenceWriter {
  constructor(private readonly base: EvidenceWriter) {}

  get directory(): string {
    return this.base.directory;
  }

  /** The typed steps the run executed — the compiler's only input. */
  trace(entries: readonly unknown[]): void {
    this.base.writeLines("trace.jsonl", entries.map(redactTraceEntry));
  }

  /**
   * The raw conversation, for a reviewer to read.
   *
   * Evidence only. Nothing in the system reads it back: the artifact is compiled
   * from the trace, which is what makes "decoupled from the raw model transcript"
   * checkable rather than asserted.
   */
  transcript(turns: readonly unknown[]): void {
    this.base.writeLines("transcript.jsonl", turns.map(redactDeep));
  }
}
