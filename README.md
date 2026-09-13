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

### 3. Replay the capability that actually changes something

`msc.card.set_status@1.0.0` walks search → results → detail → card services and submits the app's one
mutating transaction, returning the confirmation number the app issues:

```bash
npm run replay -- --capability tests/fixtures/set_status@1.0.0.json --binding tests/fixtures/fcu@4.2.json \
  --target http://localhost:7101/ \
  --input member_id=400200101 --input card_last4=4021 --input action=FREEZE
```

Its steps are `reversible`, which the shipped policy allows, so it runs unattended. Confirm it against
the app's own independent record at <http://localhost:7101/screen/audit>, and reset with
`npm run mock:reset`.

`msc.card.report_lost@1.0.0` is the same flow with an **irreversible** step. The shipped policy rates
irreversible `confirm`, so it escalates to a person rather than running — see **Human handoff** below.
The artifact cannot route around that: the schema forbids a `secret` input, so it is structurally unable
to carry the supervisor override the app demands.

---

## Fault injection

Faults are armed explicitly and fire on a stated condition, then disarm themselves. Nothing is
probabilistic — a lucky replay must never be able to pass.

```bash
npm run mock:fault -- --list                     # each fault, when it fires, what it proves
npm run mock:fault -- --arm abend_after_commit   # also prints the replay command and expected result
npm run mock:fault -- --status
npm run mock:fault -- --clear
```

The three: `broadcast` (a native dialog a declared rule dismisses — a **recoverable** condition),
`confirm_submit` (an **undeclared** dialog blocks the submit, so nothing commits — and the audit trail
staying empty is the independent proof), and `abend_after_commit` (the change lands, the confirmation is
issued, and the app abends instead of rendering it — `reconcile_required` / `sideEffectRisk: unknown`,
with `/screen/audit` the only place the truth exists).

`POST /__admin/reset` clears any armed fault, so a fault demo must arm *after* its own reset. The admin
plane is denied to the automation by every shipped policy, so a capability can never arm its own faults.

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
| `npm run test` | 240 tests across 24 files |
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

Named here rather than discovered later.

- **App-side session-aware refusal.** The mock now has a mutating route for such an enforcement point to
  protect, but no notion of a session or a holder. It records the *authority* a request carried — a row
  is `HUMAN` iff a supervisor override was supplied — which is an assumption about the deployment, not
  an enforcement. The two real enforcement points are the control lease and the driver's own turn lock.
- **Two of the five "reachable from anywhere" renders.** The broadcast (as a dialog) and the abend are
  built. SEC0403 denial and SEC0999 session terminated are not. The validation **modal** is not either:
  its job is done by the app's own inline message line, the same shape as MSG 0071, which is what the
  capabilities assert against.
- **`plan.reconcile`** is declarable in the schema but has no consumer; nothing re-checks state
  automatically. `reconcile_required` is advice to the caller, and `/screen/audit` is where a human
  establishes the truth.
- **`FailureKind "outcome_unknown"`** is declared with no producer.
- **`events.jsonl` redaction** — the model context and the discovery evidence files are redacted; the
  event log is not yet.
- **Parameterising a discovered artifact** remains a manual step.

`DECISIONS.md` records every decision as it was made, with the measurements behind it — including the
ones that turned out wrong. `REPORT.md` is the short version.
