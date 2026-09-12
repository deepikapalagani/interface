/**
 * `npm run discover` — one LLM-driven run against a live surface.
 *
 * §4 calls this "the heart of the project", and the part that cannot be
 * described instead of done. It drives the app with a model, records what was
 * executed as a trace, compiles that trace into a capability artifact, and
 * writes the whole lot to /evidence/.
 *
 * Two providers, chosen with --provider:
 *   zai       a real model over any OpenAI-compatible endpoint (the default)
 *   cassette  replays a recorded transcript through this same loop, so a
 *             reviewer with no API key still exercises the real harness
 *
 * Usage:
 *   npm run discover -- --goal "Look up member 400200101" \
 *                       --target http://localhost:7101/ \
 *                       --binding tests/fixtures/fcu@4.2.json \
 *                       --capability-id msc.member.lookup
 */
import { readFileSync } from "node:fs";
import { Binding } from "../capability/bind.js";
import { safeParseCapability } from "../capability/schema.js";
import { compileMechanical } from "../compile/mechanical.js";
import { ControlLease } from "../control/lease.js";
import { DiscoveryEvidenceWriter } from "../evidence/discovery-log.js";
import { EventSequencer } from "../evidence/events.js";
import { EvidenceWriter } from "../evidence/log.js";
import { CassetteProvider } from "../model/cassette.js";
import { OpenAICompatProvider } from "../model/openai-compat.js";
import type { ModelProvider, Turn } from "../model/provider.js";
import { PolicyDocument } from "../policy/policy.js";
import { BoundSurface } from "../surface/bound.js";
import { GatedSurface } from "../surface/gated.js";
import { PlaywrightSurface } from "../surface/playwright.js";
import { runDiscovery } from "./loop.js";

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (value === undefined) {
    if (fallback !== undefined) return fallback;
    console.error(`discover: missing required --${name}`);
    process.exit(2);
  }
  return value;
};

/** Six lines instead of a dependency. */
const env = (): Record<string, string> => {
  try {
    return Object.fromEntries(
      readFileSync(".env", "utf8")
        .split("\n")
        .filter((l) => l.includes("=") && !l.trim().startsWith("#"))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
    );
  } catch {
    return {};
  }
};

const buildProvider = (): ModelProvider => {
  const kind = arg("provider", "zai");

  if (kind === "cassette") {
    const from = arg("from");
    const turns = readFileSync(from, "utf8")
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as Turn);
    console.log(`discover: replaying ${turns.length} recorded turn(s) from ${from} — no model, no cost`);
    return new CassetteProvider(turns, "cassette");
  }

  const e = env();
  const key = e["MODEL_API_KEY"] ?? process.env["MODEL_API_KEY"] ?? "";
  if (!key) {
    console.error("discover: no MODEL_API_KEY in .env or the environment.");
    console.error("  Put a free key in .env, or run with --provider cassette --from <transcript.jsonl>.");
    process.exit(2);
  }
  return new OpenAICompatProvider({
    id: e["MODEL_NAME"] ?? "model",
    baseUrl: e["MODEL_BASE_URL"] ?? "https://api.z.ai/api/paas/v4",
    apiKey: key,
    model: e["MODEL_NAME"] ?? "glm-4.7-flash",
  });
};

const main = async (): Promise<void> => {
  const goal = arg("goal");
  const target = arg("target", "http://localhost:7101/");
  const binding = Binding.parse(JSON.parse(readFileSync(arg("binding"), "utf8")));
  const capabilityId = arg("capability-id", "msc.capability");
  const version = arg("version", "1.0.0");
  const runId = arg("run-id", `discovery-${capabilityId}`);
  const evidenceRoot = arg("evidence", "evidence/runs");

  const policy = PolicyDocument.parse({
    version: "1.0.0",
    allowedOrigins: [new URL(target).origin],
    // The admin plane, so a run cannot arm faults or reset the app underneath itself.
    deniedRoutes: ["/__admin"],
    allowedActions: ["navigate", "click", "fill", "press", "dismiss_dialog"],
    screenRules: [],
    riskHandling: { read_only: "allow", reversible: "allow", irreversible: "confirm" },
    caps: { maxSteps: 40, maxRunSeconds: 300 },
  });

  const provider = buildProvider();
  const startedAt = new Date().toISOString();
  const lease = new ControlLease(() => new Date().toISOString());
  const log = new EventSequencer({
    runId,
    phase: "discovery",
    now: () => new Date().toISOString(),
    controlOwner: () => lease.holder,
  });

  const driver = await PlaywrightSurface.launch(target, { headed: process.argv.includes("--headed") });

  // Written whatever happens. A run that dies at turn 25 of 30 — a rate limit, a
  // crash — must still leave everything up to that point on disk, or the most
  // expensive runs produce the least evidence. Measured the hard way: four
  // consecutive 429s ended a run and wrote nothing at all.
  const base = new EvidenceWriter(evidenceRoot, runId);
  const discoveryEvidence = new DiscoveryEvidenceWriter(base);
  const flush = (): void => {
    base.events(log.all);
  };

  try {
    const surface = new GatedSurface(new BoundSurface(driver, binding), policy, lease);

    const result = await runDiscovery(goal, {
      provider,
      surface,
      actor: () => lease.holder,
      epoch: () => lease.epoch,
      // Without this the sequencer is constructed, flushed, and empty: discovery
      // would write a zero-line events.jsonl while the `model_decision` arm of
      // the event schema had never once been exercised.
      log,
      onTurn: (n, note) => console.log(`  [${n}] ${note}`),
    });

    console.log(`\ndiscover: ${result.summary}`);
    for (const e of result.errors) console.log(`  recovered from: ${e}`);

    flush();
    discoveryEvidence.trace(result.trace);
    discoveryEvidence.transcript(result.transcript);

    // Compile from the TRACE, never the transcript.
    const draft = compileMechanical({
      trace: result.trace,
      goal,
      capabilityId,
      version,
      app: "MERIDIAN MSC",
      model: provider.id,
      appProfileVersion: "meridian-msc@4.2",
      discoveredAt: startedAt,
      finishCheckpoint: result.detail,
      binding,
    });

    const parsed = safeParseCapability(draft);
    if (parsed.success) {
      base.artifact(parsed.data);
      console.log(`discover: compiled ${capabilityId}@${version} from ${result.trace.length} executed step(s)`);
    } else {
      // A compile that produces something the schema rejects is a real finding,
      // not a warning: the artifact would have been unusable.
      console.error("discover: the compiled artifact FAILED validation:");
      for (const i of parsed.error.issues) console.error(`  ${i.path.join(".")}: ${i.message}`);
    }

    base.manifest({
      runId,
      phase: "discovery",
      startedAt,
      endedAt: new Date().toISOString(),
      target,
      tenant: binding.tenant,
      capability: { id: capabilityId, version },
      // Counted by the adapter, not assumed here. A discovery manifest that
      // falsely reports zero calls devalues the replay manifest that truthfully
      // reports zero — and that one number is the submission's central claim.
      model: { provider: provider.id, calls: provider.calls ?? 0 },
      result: result.stopped,
      versions: { node: process.versions.node, playwright: "1.63.0" },
    });

    console.log(`evidence: ${base.directory}`);
    process.exit(result.stopped === "goal_reached" && parsed.success ? 0 : 1);
  } catch (e) {
    // Partial evidence beats none: whatever the run managed before it died is
    // still the record of what happened, and is usually how you find out why.
    flush();
    base.manifest({
      runId,
      phase: "discovery",
      startedAt,
      endedAt: new Date().toISOString(),
      target,
      tenant: binding.tenant,
      // Counted by the adapter, not assumed here. A discovery manifest that
      // falsely reports zero calls devalues the replay manifest that truthfully
      // reports zero — and that one number is the submission's central claim.
      model: { provider: provider.id, calls: provider.calls ?? 0 },
      result: `aborted: ${e instanceof Error ? e.message : String(e)}`,
      versions: { node: process.versions.node, playwright: "1.63.0" },
    });
    console.error(`\ndiscover: run aborted — partial evidence in ${base.directory}`);
    throw e;
  } finally {
    await driver.close();
  }
};

main().catch((e: unknown) => {
  console.error("discover: unhandled error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
