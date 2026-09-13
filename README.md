# Meridian capability runner

https://github.com/deepikapalagani/interface/issues/1#issue-5442784540

An LLM drives a legacy back-office UI once to accomplish a goal. That run is recorded as a typed,
versioned **capability artifact**. After that the flow replays **deterministically, with no LLM in the
decision loop** — which is how a production agent would invoke it.

The target is a mock legacy banking app that ships in this repo: framesets, table layouts, no test ids,
empty accessible names, the same field name in two frames, and per-tenant column differences. Nothing
here touches a real system.

## Demo

https://github.com/user-attachments/assets/2cd1493d-b23f-476b-b83e-b6747fecfb67

100 seconds, no narration. An LLM drives the legacy console once and that run becomes a typed capability
artifact; the artifact then replays with **no model in the decision loop**, freezes a card, and returns the
confirmation number the application's own audit trail independently records. It closes on the same
capability answering three inputs three different ways — a match, a "no such member" that exits **0**
because it is an answer rather than a crash, and a bad input that fails.

## Fastest path

Two commands, no API key and no live model, running the whole slice end to end:

```bash
npm install && npx playwright install chromium
npm run demo:offline
```

That drives a real browser against the mock app in this repo: a recorded discovery transcript replayed
through the real agent loop, the artifact compiled from it, that artifact replayed with no model in the
decision loop, and all three result classes checked. Everything below is detail.

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

## A note on `--evidence`

Every command below passes `--evidence "$(mktemp -d)"`. That is not decoration.

`--evidence` defaults to `evidence/runs`, which is the graded deliverable, and the default run id is a
constant; `EvidenceWriter.event` **appends**. So running a documented command twice with the default
would silently double `events.jsonl` in a committed run directory and turn `npm run verify` red in a way
that looks like a defect in the system rather than in the instructions. Point runs at a temp directory,
and pass `--evidence evidence/runs` only when you mean to add a run to the deliverable.

## Demo path

Start the app in one terminal:

```bash
npm run mock          # http://localhost:7101/
```

`npm run mock:b` starts a second tenant on :7102 — the same vendor product with both frames renamed, the
member-id field renamed, and an extra leading column in the results grid, so anything reading that grid by
position reads the wrong cell. It is what the binding layer is checked against. No committed run replays
against it; see `REPORT.md` → Heterogeneity for that honest limit.

**1. Run the agent on a goal**

```bash
EV=$(mktemp -d)          # keep the path — step 2 reads the artifact back out of it

npm run discover -- \
  --goal "Look up member 400200101" \
  --target http://localhost:7101/ \
  --binding tests/fixtures/fcu@4.2.json \
  --capability-id msc.member.lookup \
  --run-id my-discovery \
  --evidence "$EV"
```

Writes `$EV/my-discovery/`: the compiled `capability.json`, the `trace.jsonl` it was compiled
from, the raw `transcript.jsonl`, a structured `events.jsonl`, and `manifest.json`.

Without a key, add `--provider cassette --from evidence/runs/discovery-lookup-v3/transcript.jsonl`.

**If the compile is refused**

The compiler stops rather than guess — a literal the binding cannot name, a screen the risk profile does
not rate, or a checkpoint symbol it would have to fabricate. Each refusal names what to add. Add it, then
re-compile from the trace the run already wrote, with no second model call:

```bash
npm run recompile -- \
  --run "$EV/my-discovery" \
  --binding tests/fixtures/fcu@4.2.json \
  --goal "Look up member 400200101" \
  --out "$EV/my-discovery/capability.json"
```

Exit 0 wrote the artifact; 1 it compiled but failed schema validation; 2 called wrong; 3 refused again.
A discovery run costs a model call and several minutes, a binding gap costs one line — without this, a
refused compile threw away the run instead of the line.

One wart, stated rather than hidden: the two *committed* discovery traces predate the fix that records
target literals instead of symbols, so re-compiling those two refuses. A freshly recorded trace compiles.

**2. Replay the artifact it just produced**

```bash
npm run replay -- \
  --capability "$EV/my-discovery/capability.json" \
  --binding tests/fixtures/fcu@4.2.json \
  --target http://localhost:7101/ \
  --run-id my-replay \
  --evidence "$EV"
```

Prints a typed result and exits 0 for success or an expected business outcome, 1 for a hard failure.
Every replay records zero model calls in its manifest, under `model.calls`.

## Replay with parameters

A discovered artifact records the literal the model typed and declares no inputs — deciding which
literals are really parameters is a separate judgement pass, and it is not built. The committed fixture
declares a typed input, so it shows all three result classes:

```bash
npm run replay -- --capability tests/fixtures/lookup@1.0.0.json \
  --binding tests/fixtures/fcu@4.2.json --target http://localhost:7101/ \
  --evidence "$(mktemp -d)" \
  --input member_id=400200101      # success                            exit 0
  # --input member_id=400299999    # business_outcome MEMBER_NOT_FOUND  exit 0 — not a failure
  # --input member_id=abc          # failed, input_schema_violation      exit 1 — still writes a log
```

## A capability that changes something

`set_status@1.0.0` walks search → results → detail → card services and submits the app's one mutating
transaction, returning the confirmation number the app issues:

```bash
npm run replay -- --capability tests/fixtures/set_status@1.0.0.json \
  --binding tests/fixtures/fcu@4.2.json --target http://localhost:7101/ \
  --evidence "$(mktemp -d)" \
  --input member_id=400200101 --input card_last4=4021 --input action=FREEZE
```

Its committing step is `reversible`, which the shipped policy allows, so it runs unattended. Check it
against the app's own audit trail at <http://localhost:7101/screen/audit>, then `npm run mock:reset`.

`report_lost@1.0.0` is the same flow with an `irreversible` step. The shipped policy rates irreversible
actions `confirm`, so it escalates to a person instead of running. Two things hold that: the capability
declares no override input, and the policy rates the step. Be precise about the schema's part — it forbids
only a `secret`-classified input, so a hand-authored artifact could declare an override as `confidential`
and parse. The guarantee is this capability's shape plus the policy, not a structural impossibility.

## Fault injection

Faults are armed explicitly, fire once on a stated condition, then disarm. Nothing is probabilistic.

```bash
npm run mock:fault -- --list                    # each fault: when it fires, and what replay should return
npm run mock:fault -- --arm abend_after_commit  # arm it and print the command to run by hand
npm run mock:fault -- --run abend_after_commit  # arm it, replay it, and CHECK the outcome
npm run mock:fault -- --status
npm run mock:fault -- --clear
```

What each fault does to the app, and what a replay against it is expected to return, is stated in
**one** place — `scripts/fault.ts` — and `--run` compares a real replay against it, in the result *and*
in the app's own audit trail. It exits non-zero on any mismatch and names the mechanism the expectation
rested on. One source, deliberately: when the README and the mock each kept their own copy of what a
fault should do, all three drifted apart and agreed on the wrong answer.

`--run confirm_submit` and `--run abend_after_commit` pass. **`--run broadcast` currently fails, and that
is deliberate**: its declared expectation is the designed behaviour, and the run does not reliably reach
it — a queued native dialog can still block the driver. Measured three times: one success, two runs that
never returned. The alternative was to declare the hang as the expectation, which would print PASS while
the recoverable class does not work. See `REPORT.md` → Cuts → Known gaps.

`POST /__admin/reset` clears any armed fault. A capability cannot arm its own faults, but be precise
about why: the enforcement is that the surface has no verb that can issue a POST to an arbitrary URL at
all (`navigate`, `click`, `fill`, `press` and the two dialog verbs are the whole set), and the mock
renders no control that reaches `/__admin`. The shipped policy does carry `deniedRoutes: ["/__admin"]`,
but that rule is evaluated against the page an action *starts* from rather than where it lands, so it is
a declared intent rather than the thing doing the work. See `REPORT.md` → Safety.

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
  --target http://localhost:7101/ --evidence "$(mktemp -d)" \
  --input member_id=400200101
```

The policy rates the screen riskier than the artifact claims, so the run raises an intervention and cedes
control. Do the step in the browser that is already open, then hand control back **from the console on
:7900**.

The in-page banner renders, and so does its **HAND BACK** button — either door ends the turn, because
both resolve the same promise the run is blocked on. Measured against a live mock through the public
`Surface` API: before the handoff neither the banner text nor the button is present; during it,
`AUTOMATION IS PAUSED` is on screen and two `HAND BACK` buttons appear in the accessibility tree (one per
paintable frame of the frameset); after hand-back both are gone. `tests/handoff.integration.test.ts`
proves the same-session property headlessly.

## Verify

```bash
npm run verify
```

| command | what it proves |
| --- | --- |
| `npm run typecheck` | strict TypeScript, clean |
| `npm run test` | 335 tests across 29 files |
| `npm run verify:no-llm` | walks the import graph from both replay entry points and fails if it can reach a model SDK, `src/model/`, `src/discover/` or `src/compile/`. Reads static imports, `import()` with a literal specifier, and refuses any `import()` whose specifier is not a literal |
| `npm run verify:evidence` | every run under `/evidence/` is complete, internally consistent, and free of the seeded PII literals and the leak shapes |
| `npm run verify:determinism` | replays 4 scenarios twice as `reset → run`, byte-comparing evidence after projecting away timestamps and run ids |
| `npm run demo:offline` | the whole slice, with no model |

Each of the three checkers runs its own `--self-test` as part of these commands — they plant defects and
assert each **planted** defect is caught by the check that owns it, so a check that silently stopped
working fails rather than passes.

The limit is that word. Around ten live checks in `verify:evidence` have no plant behind them, the most
consequential being the transcript cross-examination of `model.calls` — the check that turns `calls: 0`
from an unfalsifiable field into a checkable one. It runs only on a discovery run, and the planted run is
a replay, so deleting it outright still leaves the self-test green. The self-tests prove the checks they
plant; they do not prove the checker entire.

One limit worth stating: `verify:evidence` hunts for the seeded PAN/SSN literals (read from
`mock/seed.ts` at runtime) and for the live `MODEL_API_KEY` (read from `.env`). `.env` is gitignored, so
in a fresh clone that last detector is **inactive** — the script says so in its own output rather than
reporting a clean scan. A key committed into evidence would then be caught only by the generic api-key
*shape*, never by value.

## What is in `/evidence/`

Six runs: two model-driven discoveries; three replays covering success, an expected business outcome
and a hard failure; and one escalation. Each has a manifest and a structured event log; discovery runs
also keep the trace the artifact was compiled from and the raw transcript.

`escalation-timeout` is the §3.6 run. `report_lost@1.0.0` declares an irreversible step, the shipped
policy rates irreversible `confirm`, so the gate refuses it to a person — and with nobody at the console
the turn expires. It is a *failed* run that carries `handoff.jsonl`, `disposition: "timeout"`, a closing
`controlOwner: "automation"`, and the `operator` and `policy` why-arms that no other committed run has.

It is also where §3.5's "at least one richer signal on failure" lives. The signal is a **text snapshot,
not an image**: the handoff record carries the redacted `observedText` of the screen the run stopped on.
That is a deliberate choice rather than a shortfall — `verify:evidence` holds a run directory to a closed
set of filenames, and `screenshot.png` is excluded from it on purpose so the checker's own self-test can
plant that name and prove the "unrecognised file" rule fires. The brief allows a screenshot, a DOM
snapshot or a trace; this is the second.

## Not built

- **App-side session-aware refusal.** The app has a mutating route such a check could protect, but no
  notion of a session or holder. The two real enforcement points are the control lease and the driver.
- **`plan.reconcile`** is in the schema but has no consumer; `reconcile_required` is advice to the
  caller, and the audit screen is where a human establishes the truth.
- **Redaction of an SSN rendered without separators**, and of PIN/CVV by field name. `events.jsonl` *is*
  redacted — measured: `EvidenceWriter.event` runs every line through `redactDeep` before appending and
  stamps `redacted: true` only when masking changed the bytes. What is left open is narrower: the SSN rule
  matches only the hyphenated shape, because a bare nine-digit rule would mask every member id on this
  surface, and a credential-named key is masked only when its value is a string.
- **Parameterising a discovered artifact** is manual.
- **Three of the five interstitial renders** — denial, session-terminated, and the validation modal.
- **A queued native dialog is not bounded at every driver entry point.** `observe`, `locate`, `read` and
  `act` check for one first; `launch`'s initial navigation and `describe` do not. That is the mechanism
  behind the `broadcast` fault being intermittent rather than reliable — see `npm run mock:fault -- --list`.
- **The policy gate does not constrain a human turn.** `humanAction()` reaches the driver directly, and
  read paths are ungated, so the allowlist's "one action's worth of exposure" bound does not hold while a
  person is driving, or when a capability's last step is a `read`. Defensible — the person is the
  authority — but it is not what "one chokepoint" implies. See `REPORT.md` → Cuts.

`REPORT.md` covers the design. `DECISIONS.md` records each decision as it was made, with the
measurements behind it, including the ones that turned out wrong.
