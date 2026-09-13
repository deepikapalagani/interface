# Report

A model discovers a flow through a legacy back-office UI once. That run is compiled into a typed,
versioned capability artifact. From then on the flow replays deterministically with no LLM in the
decision loop. Everything below serves that one sentence.

`DECISIONS.md` is the long version: every decision recorded as it was made, with the measurement behind
it, including the ones that turned out wrong.

**Everything claimed below is checkable in one command.** `npm run verify` runs the typecheck, 240 tests
across 24 files, the no-LLM import walk, the evidence scan, the determinism comparison, and the full
slice end to end with no API key. Every checker carries a `--self-test`, because a check that cannot fail
is worse than no check.

---

## Architecture

Three seams, each chosen so a claim holds *structurally* rather than by discipline.

**`Surface`** is how we perceive and act, and nothing in it mentions a browser — no `Page`, no
`Locator`, no `(page) => …` callback. `PlaywrightSurface` is the only module in the repo that imports
Playwright, and it is private to one chain. Two consequences fall out rather than being promised:
nothing can act outside the allowlist because nothing else holds a driver, and a desktop or 5250 adapter
implements the same eight methods.

**`ModelProvider`** imports no SDK at all. That is what lets `scripts/verify-no-llm.ts` walk the import
graph from both replay entry points and fail if it can reach a model SDK, `src/model/`, `src/discover/`
or `src/compile/`. The check plants a forbidden import under `--self-test` to prove it can fail.

**`Binding`** translates symbols to one tenant's literals at exactly two boundaries: when an artifact is
read, and when one is written. That was arrived at expensively — canonicalisation first went *below* the
layer that searches real markup, so `find()` hunted the page for a `MEMBER_ID` label that does not
exist. The fix deleted a layer rather than adding one.

The target is a mock in this repo: a framesetted 4GL-style banking app with no test ids, empty
accessible names, the same field name in two frames, and per-tenant column differences. Nothing touches
a real system.

---

## Artifact schema

Zod is the schema; the TypeScript types are inferred from it, never written twice, and
`parseCapability()` is the only door in. Three layers, each with a different reader: **contract** (what a
calling agent binds to), **plan** (what a human reviews), **provenance + verification** (how it came to
exist, and proof it replayed).

Two properties do most of the work.

**Dangerous artifacts are unrepresentable.** Eight refinements: no `secret` input, no PII-shaped literal
in place of a `{{param}}`, no acting step without a postcondition, no retry recovery beside an
irreversible step, no output without exactly one producer, no persisted snapshot ref as a target, no
contract understating its own risk, no step targeting an undeclared symbol. Each has a rejection test
pinned to its own message — a table that only checked `success === false` would pass against a schema
that rejected everything.

**Targets carry reasoning, not just selectors.** Strategy order is `table_anchor` → frame-scoped
`field_key` → `role_name`, inverted from the obvious order on measurement: `role_name` matches **zero**
elements on this surface, and the structural anchor survived both a frame rename and a field rename that
the field name did not. Coordinates are deliberately absent. The model's stated reason is recorded as a
*belief*; the locator is minted mechanically from the live DOM, and verified resolvable before it is
written.

The artifact is compiled from the executed **trace**, never the transcript — and that is checkable, not
asserted: the replay import graph may not even mention the transcript filename.

---

## Determinism & error handling

**No LLM in replay**, enforced by the import-graph walk above, and every replay manifest records
`modelCalls: 0`.

Two primitives, split along a line that matters: `settle()` answers *has something happened yet*, and
`classify()` answers *which of the three classes is it*. There are no sleeps and no network-idle
heuristics anywhere in the replay path — an arbitrary wait makes a run pass on a fast machine and fail on
a slow one, and neither is a statement about the application. `settle` is the only module permitted a
timer, and a source test now enforces that.

**Precedence is the mechanism:** recovery → business outcome → postcondition → hard failure. If the
postcondition were consulted first, "NO RECORDS MATCH — MSG 0071" would surface as `postcondition_failed`
— a crash where the caller needed an answer. A test supplies an observation satisfying *both*, so only
the ordering decides what the caller receives.

The three classes live in three different places — `contract.outcomes[]`, `plan.recovery[]`, and hard
failure by default — because three branches of a function is a promise to be careful and three sections
of a schema is a mechanism. A mutating step whose postcondition never holds returns
`remediation: reconcile_required` and `sideEffectRisk: unknown` rather than inviting a retry; that thin
rule replaced a generic idempotency subsystem.

That rule is now enforced **run-wide rather than per-step**, and finding out why is the most useful thing
the mutating route surfaced. Three exits — the run-budget timeout, the capability checkpoint, and the two
non-resolving ends of a human turn — answered "may I retry?" with the constant `retry_safe` / `none`.
Every one was correct only because the app had no mutating route, so nothing a replay did could commit.
A constant that is true for an accidental reason becomes a lie the day the reason goes away, and the
checkpoint was the sharp case: it never consulted risk at all, so a capability that genuinely froze a
card and then missed its confirmation told the caller to try again. They now key on whether this run
actually issued a mutating action, and — across a human turn, where automation cannot watch a person's
hands — on whether the surface moved. `tests/side-effect.test.ts` proves each site **both ways**, because
a rule that fires on everything is as broken as one that fires on nothing.

"Run-wide" means every exit, and getting there took a second pass: six *more* exits still answered with
the constant, including the one the flagship itself reaches — `s07` freezes the card, `s08` then fails to
read the confirmation back, and a step that issues no action was reporting the run as retryable. A step's
own innocence is real and irrelevant; the caller is asking about the run. Every failure exit now keys on
the same flag.

`npm run verify:determinism` runs each result class twice as **reset → run vs reset → run**, comparing
artifact bytes, manifest, event log, result classification, exit code and the app's own state after
projecting away timestamps and run ids. Eleven planted divergences were each rejected. It fails as
VACUOUS rather than printing OK on a thin corpus.

The property is stated that way because an earlier check compared a page fetched mid-run against one
fetched after a reset — never the determinism property. That wrong check found a real design flaw (a
per-request clock tick) and was nearly dismissed as a broken assertion.

---

## Heterogeneity & multi-tenant

The plan names `MEMBER_ID` on `MEMBER_SEARCH`, never `MBRNO` on `MBR0300`. A ~30-line binding file
supplies one tenant's literals, so one artifact serves many institutions running the same vendor
product. A binding must be **reversible** — two symbols sharing a literal is refused at parse time,
because minting would otherwise have to guess, and a guess inside a recorded artifact is a defect that
surfaces on some other tenant months later.

Anything a binding cannot express is **drift by construction**: an unknown symbol raises `UnboundSymbol`
naming the missing key, and a non-primary strategy resolving logs `degraded: true`. The mock ships a
second tenant that renames both frames and the member-id field and prepends a grid column, so anything
reading by position silently reads wrong.

Honest limit: no second-tenant binding fixture is committed, so multi-tenant reuse is demonstrated by
the mechanism and the mock, not by a committed cross-tenant run.

---

## Escalation & handoff

A person takes over **the same live session**, finishes the step, hands back, and the run resumes.

That property fails silently — a handoff that quietly opens a second browser renders identical screens
and every naive assertion still passes — so it is proven three mechanical ways. Automation types the
member id; the human, who never types it, presses submit; the results carry that member, where a fresh
session would have returned MSG 0071. Context and page counts are unchanged. Reads stay live mid-turn
while automation is locked out. The first is the strongest, because it is the *application* reporting
that two actors shared one document.

**Two independent enforcement points.** The `ControlLease` refuses at the single surface chokepoint —
control is checked *before* permission, because who is driving outranks what is permitted — and the
driver refuses on its own `humanTurn` flag, sharing no state with the lease, so a bug in one cannot
produce a double-actor write. The epoch fence rejects any action built before the transfer.

The operator console is deliberately mocked: one HTML page, no framework. The transfer underneath it is
production code, and `tests/handoff.integration.test.ts` proves it headlessly with a scripted operator
that drives the *real* driver — only who supplies the input is simulated, because a stand-in returning a
canned outcome would prove nothing about control transfer.

**The escalation is now reachable through the shipped policy, not only through a policy file.**
`msc.card.report_lost@1.0.0` declares an `irreversible` step; the shipped `riskHandling` maps
irreversible to `confirm`; the gate refuses it with `requires: human`. The artifact cannot route around
that, and the reason is structural rather than procedural: schema refinement 1 forbids a `secret` input,
so no capability can carry the supervisor override the app demands for that action. The person is
required by the shape of the artifact, not by a configuration choice — safety and escalation interlock
through the front door.

Escalation is kept structurally unreachable from the determinism corpus (the shipped policy carries no
screen rules) rather than special-cased, so a non-reproducible human never enters a byte-comparison. The
audit of control itself — every cede, reclaim and expiry — reaches `/evidence/` on the `operator` arm.

---

## Safety

A configurable allowlist of origins, routes and action types, evaluated at the one chokepoint every
action passes through. Risk is separated from approval so the matrix can vary by tier, and an artifact
can never talk its own risk *down*: the contract must equal the maximum over its steps.

**Redaction is default-on.** It was previously a hook with an identity default that no call site
overrode, plus a `redacted` flag no producer ever set — the system looked redaction-aware while masking
nothing, and was clean only because no run had yet reached the one screen that renders an SSN. The
boundary is deliberate: SSN, PAN and credentials are masked; member id, name, balances and card last-4
are not, because redacting the member id breaks discovery and masking a PAN whole would leave a card
capability unable to say *which* card it acted on — safety that breaks the thing it protects.

`npm run verify:evidence` scans every file under `/evidence/` for the seeded PAN/SSN literals and the
live API key, sourced at runtime so the detector cannot go stale, plus four shape patterns. It reports
offences by label and never prints a value.

**The irreversible path now has something to exercise.** The app's one mutating transaction refuses
`LOST_STOLEN` without a supervisor override code, and refinement 1 forbids a `secret` input — so
`msc.card.report_lost@1.0.0` is *structurally* incapable of supplying it. The run escalates, a person
types it into the live session, and the app attributes the resulting audit row to `HUMAN`. That
attribution is honest about what it is: the app records the **authority a request carried**, never who
was at the keyboard, because only a supervisor holds that code.

Redaction is exercised rather than merely configured. The card screen renders the seeded PAN unmasked —
that is the point of it, and it is why no capability target ever resolves to that cell. Until that screen
existed the seeded literal reached no screen at all, so the leak scan had nothing it could have caught.

Named gaps rather than discovered ones: `events.jsonl` is not yet redacted; `redactDeep` masks a
credential-named key only when its value is a string; and the third, app-side enforcement point — the
application refusing a write while a human holds the session — is **not built**. There is now a mutating
route for such a point to protect, but the mock has no notion of a session or a holder, so it refuses
nothing on those grounds and this write-up does not claim it does.

---

## Cuts

A fourth result state. A generic idempotency subsystem. Dry-run/shadow mode. The `viewport_box`
strategy. A second classification system beside `DataClass`. A global egress guard. Playwright tracing
in committed evidence. All scaling infrastructure — containers, VNC, co-browsing, queues, operator
routing — which §7 says is not rewarded.

Unbuilt scope, stated plainly. The mock now has **eight of the eight** frozen screens and **two of the
five** "reachable from anywhere" renders — the broadcast, delivered as a dialog rather than as a screen,
and the abend. The other three are not built: SEC0403 denial, SEC0999 session terminated, and the
validation modal, whose job is served instead by the app's own inline message line, the same shape as
MSG 0071 and what the capabilities actually assert against. The broadcast's form is a measurement, not a
shortcut: a screen-shaped interstitial is **unrecoverable by this engine**, because `wait_and_retry` and
`reload_screen` issue no action and `observe()` sends no request, so the retries burn in milliseconds
against a screen that cannot change. A dialog is the recoverable condition the engine can actually act
on.

Also unbuilt, each named rather than discovered: app-side session-aware refusal; `plan.reconcile`, which
is declarable but has no consumer; `FailureKind "outcome_unknown"`, which has no producer; `events.jsonl`
redaction; parameterising a discovered artifact, because deciding which literals are really parameters is
a judgement pass, not a mechanical one; and the replay CLI writes no evidence if `replay()` itself
throws, which needs a vocabulary decision first — an unexpected exception is not a citation of anything.

