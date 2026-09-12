# Meridian capability runner

A model discovers a flow through a legacy back-office UI once. That run is compiled into a typed,
versioned **capability artifact**. From then on the flow is replayed **deterministically, with no LLM in
the decision loop** — which is how a production agent invokes it.

The target is a deliberately hostile stand-in for the real thing: a framesetted 4GL-style banking app
with no test ids, empty accessible names, the same field name in two frames, and a results grid whose
columns differ per tenant. It ships in this repo, so nothing here touches a real system.

---

## Setup

Node 20.17 or newer.

```bash
npm install
npx playwright install chromium
```

Playwright is pinned to exactly **1.63.0**. The targeting design rests on measured, version-specific
API behaviour, so treat an upgrade as something that has to re-run the probes.

### Configuration

Only discovery needs a model. Copy the template and fill in one key:

```bash
cp .env.example .env
```

```
MODEL_PROVIDER=zai
MODEL_API_KEY=...
MODEL_BASE_URL=https://api.z.ai/api/paas/v4
MODEL_NAME=glm-4.7-flash
```

Any OpenAI-compatible endpoint works — Z.ai, a Gemini free tier, Ollama, LM Studio — because the whole
system talks to one adapter. Switching provider is a base URL and a model name. `.env` is gitignored.

**Replay never reads a key**, and that is enforced rather than promised: see `npm run verify:no-llm`.

---

## Run it without any live services

No key, no model, no cost, one command:

```bash
npm run demo:offline
```

This runs the entire slice — discovery, the artifact compiled from its trace, that artifact replayed
with no model, then the three result classes shown distinct — by replaying a committed transcript
through a cassette. Only the model is substituted; the real loop drives a real browser against the real
mock, and the cassette **fails loudly** if the recorded screens stop matching what the surface produces.

`npm run demo` is the same thing with a live model-driven discovery run.

---

## The two commands that matter

Start the app in one terminal:

```bash
npm run mock          # MERIDIAN MSC, tenant "fcu", http://localhost:7101/
```

### 1. Run the agent on a goal

```bash
npm run discover -- \
  --goal "Look up member 400200101" \
  --target http://localhost:7101/ \
  --binding tests/fixtures/fcu@4.2.json \
  --capability-id msc.member.lookup \
  --run-id my-discovery \
  --evidence evidence/runs
```

Writes to `evidence/runs/my-discovery/`: the compiled `capability.json`, the `trace.jsonl` it was
compiled from, the raw `transcript.jsonl`, a structured `events.jsonl`, and a `manifest.json`.

To do this with no key, add `--provider cassette --from evidence/runs/discovery-lookup-v3/transcript.jsonl`.

### 2. Replay the artifact it just produced

```bash
npm run replay -- \
  --capability evidence/runs/my-discovery/capability.json \
  --binding tests/fixtures/fcu@4.2.json \
  --target http://localhost:7101/ \
  --run-id my-replay \
  --evidence evidence/runs
```

Prints the typed result and exits **0** for a success or an expected business outcome, **1** for a hard
failure. Every run records `modelCalls: 0`.

The committed fixture `tests/fixtures/lookup@1.0.0.json` declares a typed input, so it can show all
three result classes:

```bash
npm run replay -- --capability tests/fixtures/lookup@1.0.0.json --binding tests/fixtures/fcu@4.2.json \
  --target http://localhost:7101/ --input member_id=400200101   # success           (exit 0)
  # --input member_id=400299999  -> business_outcome MEMBER_NOT_FOUND (exit 0, NOT a failure)
  # --input member_id=abc        -> failed, input_schema_violation    (exit 1, still leaves a log)
```

The discovered artifact records the literal the model typed and declares no inputs — deciding which
literals are really parameters is a separate judgement pass that is **not built**. That is why the
parameterised demonstration uses the fixture.

---

## Human handoff (§3.6)

A person takes over the **same live session**, finishes the step, hands control back, and the run
resumes. Two terminals:

```bash
npm run operator      # the console on http://localhost:7900/
```

```bash
npm run replay -- --headed --operator \
  --policy tests/fixtures/policy-escalate.json \
  --capability tests/fixtures/lookup@1.0.0.json \
  --binding tests/fixtures/fcu@4.2.json \
  --target http://localhost:7101/ \
  --input member_id=400200101
```

The policy rates the screen riskier than the artifact claims, so the run raises an intervention, cedes
control, and paints a banner into the live page. Do the step in the browser that is already open, then
press **HAND BACK**.

The operator UI is deliberately mocked — one HTML page, no framework. The transfer underneath it is
real: the lease, the driver's own turn lock, the epoch fence, the gate and the control journal are all
production code, and `tests/handoff.integration.test.ts` proves the same-session property headlessly.

---

## Verify every claim

```bash
npm run verify
```

Six links, all currently green:

| command | what it proves |
| --- | --- |
| `npm run typecheck` | strict TypeScript, clean |
| `npm run test` | 165 tests across 21 files |
| `npm run verify:no-llm` | walks the import graph from both replay entry points and **fails** if it can reach a model SDK, `src/model/`, `src/discover/` or `src/compile/`. `--self-test` plants a forbidden import to prove the check can fail |
| `npm run verify:evidence` | every run under `/evidence/` is complete, internally consistent, and free of secrets or PII. `--self-test` plants 18 classes of defect |
| `npm run verify:determinism` | replays each result class twice as `reset → run`, byte-comparing evidence after projecting away timestamps and run ids |
| `npm run demo:offline` | the whole slice, with no model |

Every checker carries a `--self-test`, because a check that cannot fail is worse than no check.

---

## What is in `/evidence/`

Five committed runs: two model-driven discoveries and three replays covering success, business outcome
and a hard failure. Each holds a manifest, a structured event log, and — for discovery — the trace the
artifact was compiled from and the raw transcript.

---

## Deliberately not built

Named here rather than discovered later. The mock has no mutating route, so nothing exercises the
irreversible-action path; the flagship `msc.card.set_status` capability and fault injection
(`npm run mock:fault`) are unbuilt; `events.jsonl` is not yet redacted, though the model context and the
discovery evidence files are; and parameterising a discovered artifact remains a manual step.

`DECISIONS.md` records every decision as it was made, with the measurements behind it — including the
ones that turned out wrong. `REPORT.md` is the short version.
