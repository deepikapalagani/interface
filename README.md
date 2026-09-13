# Meridian capability runner

An LLM drives a legacy back-office UI once to accomplish a goal. That run is recorded as a typed,
versioned **capability artifact**. After that the flow replays **deterministically, with no LLM in the
decision loop** — which is how a production agent would invoke it.

The target is a mock legacy banking app that ships in this repo: framesets, table layouts, no test ids,
empty accessible names, the same field name in two frames, and per-tenant column differences. Nothing
here touches a real system.

## Setup

Node 20.17 or newer.

```bash
npm install
npx playwright install chromium
```

Playwright is pinned to 1.63.0 — the targeting design rests on measured, version-specific behaviour.

### Configuration

Only discovery needs a model. Replay never reads a key.

```bash
cp .env.example .env
```

```
MODEL_API_KEY=...
MODEL_BASE_URL=https://api.z.ai/api/paas/v4
MODEL_NAME=glm-4.7-flash
```

Any OpenAI-compatible endpoint works (Z.ai, Gemini free tier, Ollama, LM Studio) — switching provider is
a base URL and a model name. `.env` is gitignored.

## Run it without live services

No key, no model, one command:

```bash
npm run demo:offline
```

This runs the whole slice — discovery, the artifact compiled from it, that artifact replayed with no
model, then the three result classes — by replaying a recorded transcript through a cassette. Only the
model is substituted: the real loop drives a real browser against the real mock. The cassette fails if
the recorded screens no longer match what the app renders.

`npm run demo` is the same with a live model-driven discovery run.

## Demo path

Start the app in one terminal:

```bash
npm run mock          # http://localhost:7101/
```

**1. Run the agent on a goal**

```bash
npm run discover -- \
  --goal "Look up member 400200101" \
  --target http://localhost:7101/ \
  --binding tests/fixtures/fcu@4.2.json \
  --capability-id msc.member.lookup \
  --run-id my-discovery \
  --evidence evidence/runs
```

Writes `evidence/runs/my-discovery/`: the compiled `capability.json`, the `trace.jsonl` it was compiled
from, the raw `transcript.jsonl`, a structured `events.jsonl`, and `manifest.json`.

Without a key, add `--provider cassette --from evidence/runs/discovery-lookup-v3/transcript.jsonl`.

**2. Replay the artifact it just produced**

```bash
npm run replay -- \
  --capability evidence/runs/my-discovery/capability.json \
  --binding tests/fixtures/fcu@4.2.json \
  --target http://localhost:7101/ \
  --run-id my-replay \
  --evidence evidence/runs
```

Prints a typed result and exits 0 for success or an expected business outcome, 1 for a hard failure.
Every replay records `modelCalls: 0`.

## Replay with parameters

A discovered artifact records the literal the model typed and declares no inputs — deciding which
literals are really parameters is a separate judgement pass, and it is not built. The committed fixture
declares a typed input, so it shows all three result classes:

```bash
npm run replay -- --capability tests/fixtures/lookup@1.0.0.json \
  --binding tests/fixtures/fcu@4.2.json --target http://localhost:7101/ \
  --input member_id=400200101      # success                         exit 0
  # --input member_id=400299999    # business_outcome MEMBER_NOT_FOUND  exit 0 — not a failure
  # --input member_id=abc          # failed, input_schema_violation      exit 1 — still writes a log
```

## A capability that changes something

`set_status@1.0.0` walks search → results → detail → card services and submits the app's one mutating
transaction, returning the confirmation number the app issues:

```bash
npm run replay -- --capability tests/fixtures/set_status@1.0.0.json \
  --binding tests/fixtures/fcu@4.2.json --target http://localhost:7101/ \
  --input member_id=400200101 --input card_last4=4021 --input action=FREEZE
```

Its steps are `reversible`, which the shipped policy allows, so it runs unattended. Check it against the
app's own audit trail at <http://localhost:7101/screen/audit>, then `npm run mock:reset`.

`report_lost@1.0.0` is the same flow with an `irreversible` step. The shipped policy rates irreversible
actions `confirm`, so it escalates to a person instead of running. The artifact cannot route around
that: the schema forbids a `secret` input, so it is structurally unable to carry the supervisor override
the app demands.

## Fault injection

Faults are armed explicitly, fire once on a stated condition, then disarm. Nothing is probabilistic.

```bash
npm run mock:fault -- --list     # each fault, when it fires, what it proves
npm run mock:fault -- --arm abend_after_commit
npm run mock:fault -- --status
npm run mock:fault -- --clear
```

- `broadcast` — a dialog a declared recovery rule dismisses (a **recoverable condition**)
- `confirm_submit` — an **undeclared** dialog blocks the submit, so nothing commits
- `abend_after_commit` — the change lands, then the app fails before showing the confirmation:
  `reconcile_required` with `sideEffectRisk: unknown`

`POST /__admin/reset` clears any armed fault, and the admin routes are denied to automation by every
shipped policy, so a capability can never arm its own faults.

## Human handoff

A person takes over the same live session, finishes the step, and hands control back. Two terminals:

```bash
npm run operator      # console on http://localhost:7900/
```

```bash
npm run replay -- --headed --operator \
  --policy tests/fixtures/policy-escalate.json \
  --capability tests/fixtures/lookup@1.0.0.json \
  --binding tests/fixtures/fcu@4.2.json \
  --target http://localhost:7101/ --input member_id=400200101
```

The policy rates the screen riskier than the artifact claims, so the run raises an intervention, cedes
control and paints a banner into the live page. Do the step in the browser that is already open, then
press **HAND BACK**.

The operator UI is deliberately mocked — one HTML page, no framework. The control transfer underneath is
real, and `tests/handoff.integration.test.ts` proves the same-session property headlessly.

## Verify

```bash
npm run verify
```

| command | what it proves |
| --- | --- |
| `npm run typecheck` | strict TypeScript, clean |
| `npm run test` | 240 tests across 24 files |
| `npm run verify:no-llm` | walks the import graph from both replay entry points and fails if it can reach a model SDK, `src/model/`, `src/discover/` or `src/compile/` |
| `npm run verify:evidence` | every run under `/evidence/` is complete, consistent, and free of secrets or PII |
| `npm run verify:determinism` | replays 4 scenarios twice as `reset → run`, byte-comparing evidence after projecting away timestamps and run ids |
| `npm run demo:offline` | the whole slice, with no model |

Each checker has a `--self-test` that plants defects and asserts they are caught, so a check that
silently stopped working would fail rather than pass.

## What is in `/evidence/`

Five runs: two model-driven discoveries, and three replays covering success, an expected business
outcome, and a hard failure. Each has a manifest and a structured event log; discovery runs also keep
the trace the artifact was compiled from and the raw transcript.

## Not built

- **App-side session-aware refusal.** The app has a mutating route such a check could protect, but no
  notion of a session or holder. The two real enforcement points are the control lease and the driver.
- **`plan.reconcile`** is in the schema but has no consumer; `reconcile_required` is advice to the
  caller, and the audit screen is where a human establishes the truth.
- **`events.jsonl` redaction** — the model's context and the discovery evidence files are redacted; the
  event log is not.
- **Parameterising a discovered artifact** is manual.
- **Three of the five interstitial renders** — denial, session-terminated, and the validation modal.

`REPORT.md` covers the design. `DECISIONS.md` records each decision as it was made, with the
measurements behind it, including the ones that turned out wrong.
