# Report

An LLM drives a legacy back-office UI once to reach a goal. That run is recorded as a typed, versioned
**capability artifact**, which then replays deterministically with no LLM in the decision loop — the way a
production agent would call it.

Everything below is checkable with `npm run verify`: typecheck, tests, the no-LLM import walk, the evidence
scan, the determinism comparison, and the whole slice with no API key. `DECISIONS.md` holds the longer
reasoning and the measurements, including the decisions that turned out wrong.

A [100-second recording](https://github.com/user-attachments/assets/2cd1493d-b23f-476b-b83e-b6747fecfb67)
of the end-to-end flow is linked from `README.md`: discovery, the compiled artifact, a replay with no model
in the decision loop, and the application's own audit trail confirming the result it returned.

## Architecture

Three boundaries, each built so the guarantee holds even if someone forgets it.

**`Surface`** — how the system perceives and acts. Nothing in it mentions a browser: no `Page`, no
`Locator`. `src/surface/playwright.ts` is the only file importing Playwright, and it is private to one
chain. So nothing can act outside the allowlist, because nothing else holds a driver; and another adapter
implements the same eight methods.

**`ModelProvider`** — imports no model SDK. That lets `verify-no-llm` walk the import graph from both replay
entry points and fail if it reaches a model SDK, `src/model/`, `src/discover/` or `src/compile/`. It reads
static imports and `import()` with a literal specifier, and refuses any `import()` whose specifier is not
literal: a specifier the walker cannot evaluate is one it cannot clear.

**`Binding`** — translates symbols into one tenant's literals at exactly two points, when an artifact is read
and when one is written. Everything below deals only in what the markup contains.

Discovery and replay are separate programs sharing the artifact and the surface, not one program with a
flag. That is what makes "no model in replay" checkable by reading imports.

## Artifact schema

Zod is the schema, TypeScript types are inferred from it, and `parseCapability()` is the only way in. Three
layers, each with a different reader:

- **contract** — what a calling agent binds to: typed inputs, typed outputs, declared business outcomes, risk.
- **plan** — what a human reviews: ordered steps, target descriptors, recovery rules, the checkpoint.
- **provenance + verification** — how it came to exist, and whether it has replayed.

**Twelve rules refuse an unsafe artifact at load.** Among them: no `secret` input; no PII-shaped literal
anywhere in `plan` or `contract`; every acting step must assert a postcondition that differs from its own
precondition; no retrying recovery in a plan holding an irreversible step; every output produced by exactly
one `read` step; no snapshot reference as a durable target; a contract's risk must equal the maximum over
its steps; and every symbol named by a step or a predicate must be declared in `plan.targets`. Each rule has
a rejection test pinned to its own message, plus a table of artifacts that must still parse — so a schema
that rejected everything would fail the suite rather than look healthy.

One declared field is knowingly unenforced: `rowCount.grid` is exempt from the symbol rule, because the
evaluator counts rows page-wide and enforcing it would reject four committed files over a field that changes
no behaviour. The evaluator says so in its own output.

**Targets carry reasoning, not just selectors.** The order is structural anchor → frame-scoped field name →
role+name, inverted from the obvious order because it was measured: role+name matches nothing on this
surface, and the anchor survived a frame rename and a field rename that the field name did not. Coordinates
are absent; they are not durable. The model's stated reason is recorded as a *belief*, while the locator is
derived mechanically from the live page and checked to resolve before it is written.

The artifact is compiled from the executed **trace**, never the model transcript — and that is checkable,
because the replay import graph may not even mention the transcript file.

## Determinism & error handling

No LLM in replay, enforced by the import walk. Every replay run records zero model calls in its manifest
(`model.calls`).

**Waiting.** `settle()` races the conditions the artifact declared and returns the moment one holds. No
sleeps, no network-idle heuristics: an arbitrary wait passes on a fast machine and fails on a slow one, and
says nothing about the application. A source test asserts `settle` is the only module under `src/replay`
referencing a timer.

**The order of the checks keeps the three result classes apart:** recovery → business outcome →
postcondition → hard failure. Check the postcondition first and "NO RECORDS MATCH — MSG 0071" becomes
`postcondition_failed` — a crash where the caller needed an answer. A test supplies one observation
satisfying both, so only the ordering decides. The classes also live in three different places
(`contract.outcomes[]`, `plan.recovery[]`, hard failure by default), so nobody has to remember to keep them
apart. Recovery is applied at all three observation points: precondition, postcondition, and checkpoint.

**Typed outputs are coerced where captured.** An `integer` returns a JSON number or fails as a typed
`contract_violation`; a `boolean` returns true/false from the spellings a green-screen renders.

**Whether a retry is safe depends on the run, not the failing step.** A mutating step whose postcondition
never confirms returns `reconcile_required` with `sideEffectRisk: unknown`, and every failure exit depends on
one run-scoped fact: has this run issued a mutating action? The step may be harmless; the caller is asking
about the run.

**Drift is a signal, not an exception.** A target resolving through a non-primary strategy logs
`degraded: true`, and a symbol the binding cannot translate fails with an error naming it.

**Proof.** `verify:determinism` runs four scenarios twice each as `reset → run`, comparing artifact bytes,
manifest, event log, classification, exit code and the application's own state, after projecting away
timestamps and run ids. It starts its own copy of the app, and fails rather than printing OK when it
compared too little to prove anything.

## Heterogeneity & multi-tenant

**The surface seam.** A step says *fill the control anchored by the label `MEMBER_ID` on screen
`MEMBER_SEARCH`* — never a CSS selector, never a browser. A desktop or terminal adapter implements the same
eight methods over UIA, the OS accessibility tree or a 5250 screen buffer, and neither the schema nor the
replay engine changes. Perception already uses the accessibility tree rather than the DOM, which is what
desktop surfaces expose too. An adapter's one obligation is turning a control it can see into durable facts:
a label and an app-level field name.

**Multi-tenant reuse.** The plan names `MEMBER_ID` on `MEMBER_SEARCH`, never `MBRNO` on `MBR0300`. A 36-line
binding supplies one tenant's literals, so the same artifact serves many institutions running the same
vendor product, and a per-tenant override is a different binding rather than a re-recording. A binding must
be **reversible**: two symbols sharing one literal is refused at load, because otherwise recording would
guess, and a guess here breaks a different tenant months later.

**Drift detection** falls out of the same design: variation a binding can express is configuration, anything
it cannot is drift. The mock ships a second tenant that renames both frames and the member-id field and
prepends a grid column, so anything reading by position reads the wrong cell.

Honest limit: no second-tenant binding is committed, so cross-tenant reuse rests on the mechanism, not on a
committed run against it.

## Escalation & handoff

**Detecting when the agent is stuck.** The policy rates each action's effective risk. When that requires a
person — an irreversible action, or a screen rated above what the artifact claims — the gate answers
`requires: "human"` and the executor routes it to escalation instead of failing. A caller can then tell "a
person must approve this" from "this is forbidden, never retry", which call for opposite responses.

**Taking control.** The order is the mechanism: cede the lease, advancing an epoch so any action built before
the handoff is refused afterwards; lock the driver *before* painting the banner, since a banner that fails to
render must still leave a locked session; raise the request carrying goal, capability, current step, current
state and why it stopped; then reclaim if a person answered, or expire if nobody did.

**Same session, proven.** This property fails silently — a handoff that quietly opened a second browser would
render identical screens and pass naive assertions. The strongest of three mechanical checks: automation
types the member id, the human who never types it presses submit, and the results carry that member. A fresh
session would have returned "no records match". That is the application reporting the two actors shared one
document.

**Two enforcement points, and the third is not built.** The control lease refuses at the surface chokepoint,
and the driver refuses on its own flag, sharing no state with the lease, so a bug in one cannot produce two
actors writing at once. The app-side point — the application refusing a write while a human holds the
session — does not exist: the mock has a mutating route such a check could protect, but no notion of a
session. Three dispositions map to three distinct failure kinds: resolved, aborted, timed out. Collapsing
"nobody came" into "the person gave up" would tell a caller to stop retrying when the right move is to
attach an operator.

`evidence/runs/escalation-timeout` is that path as a committed file rather than only a test: a failed
`report_lost` replay that ceded to a person nobody answered, carrying `handoff.jsonl`,
`disposition: "timeout"` and a closing `controlOwner: "automation"`. It also holds the redacted text of the
screen the run stopped on — the richer signal on failure §3.5 asks for, as a text snapshot rather than an
image.

The operator UI is mocked, as the brief permits: one HTML page, no framework. The in-page banner renders, and
either door ends the turn, because both buttons resolve the same promise.

**The masked screenshot does less than it appears to.** It blacks out targets flagged `nameMayContainPii` and
refuses an image if a flagged target fails to resolve — but nothing sets that flag true, and setting it
would not help: the flag describes a *screen* while the capture consumes a list of *elements*, and the card
number renders in a grid cell no target resolves to. What is real: the bytes are served from memory and
never written under `/evidence/`, and the caption says **UNMASKED** rather than overclaiming.

## Safety

**Allowlist.** Configurable origins, routes and action types, evaluated at the one chokepoint every action
passes through. Control is checked *before* permission: while a person holds the session, automation must not
act even when the action is otherwise legal.

Be precise about what it gates: **where an action is issued from, not where it lands.** No verb in
`SurfaceAction` carries a destination, so a click that navigates off-allowlist is not refused as it is
issued — it is caught on the *next* action, gated on the new location. One action's worth of exposure is the
real bound. `deniedRoutes: ["/__admin"]` shares that limit. What actually stops a capability arming its own
faults is that no verb can POST to an arbitrary URL and no screen renders a control reaching `/__admin`.

**Risk.** Risk is separate from approval so the matrix can vary by deployment, and an artifact cannot talk its
own risk down: the contract must equal the maximum over its steps. Nor is risk invented — the compiler
refuses to compile a step whose risk it cannot establish from a per-application profile, rather than stamping
`read_only` on everything, which once gave a failed replay `retry_safe` on a card it had already actioned.

The irreversible path has something real to exercise: the app refuses a lost/stolen report without a
supervisor override, so `report_lost` escalates to a person. Two things combine to hold that — the capability
declares no override input, and the shipped policy rates `irreversible` as `confirm`. The schema forbids only
a `secret`-classified input, so a hand-authored artifact could declare an override as `confidential` and
parse. The guarantee is this capability's shape plus the policy, not a structural impossibility.

**Redaction is on by default**, applied to the model's context and to every evidence file as bytes are
written. SSNs, card numbers and credentials are masked; member id, name, balances and card last-4 are not,
because redacting the member id would break discovery and masking a card number whole would leave a card
capability unable to say which card it acted on. `verify:evidence` scans every evidence file for the seeded
PII literals and the live API key, sourced at runtime so the detector cannot go stale.

Its limits, measured: the SSN rule matches only the hyphenated form, since a bare nine-digit rule would mask
every member id here; credential masking by field name applies only when the value is a string; PIN and CVV
are absent from that list. The live-key detector reads `.env`, absent in a fresh clone, so the checker
reports itself inactive rather than printing a clean scan — "no secrets found" and "no secrets looked for"
must not look the same.

## Cuts

**Deliberately not built:** a fourth result state; a generic idempotency subsystem; dry-run mode; coordinate
targeting; a global egress guard; browser tracing in evidence; and all scaling infrastructure — containers,
VNC, co-browsing, queues, operator routing — which §7 says is not rewarded.

**Removed rather than left half-working:** the discovery `screenshot` tool. A model that can request an image
but whose loop cannot act on image bytes spends tokens narrating pictures to itself.

**Collected but not compiled:** the model's stated success condition. Turning prose into an assertion is a
judgement step, so the checkpoint asserts what the run mechanically established. The field has no consumer,
named here rather than dressed up as a feature.

**Hand-authorable but not discoverable:** static-text reads. A `read` against a label/value row replays
correctly, but only *actionable* roles are given refs, so the model never sees a static-text node to name.

**Stubbed at a clean seam:** the operator console UI, and the model during offline runs, where a cassette
replays a recorded transcript through the real loop and refuses if the screens no longer match.

**Known gaps:**

- **The recoverable class is not reliably demonstrable end to end.** A queued native dialog can still block
  the driver: `observe`, `locate`, `read` and `act` check for one first, `launch()` and `describe()` do not.
  Measured against the `broadcast` fault, one run completed and two never returned. `npm run mock:fault --
  --run broadcast` reports a loud mismatch rather than passing, because an intermittent pass is not a working
  mechanism.
- **Evidence survives any failure inside a run, but not one before it starts.** `replay()` runs inside the
  guarded region, so a throw there still writes events, manifest and artifact. Launching the browser and
  starting the operator console sit outside it, leaving a run directory with no manifest — which this
  project's own `verify:evidence` rejects.
- **A `read` step naming no target is skipped silently and counted complete, and an `assert` step emits no
  event**, so a run can report success having written an events log the evidence gate would reject.
- **A human turn bypasses the policy gate.** `humanAction()` reaches the driver directly, so the allowlist
  does not constrain a person. Defensible, since the person is the authority, but not what "one chokepoint"
  implies. Read paths are ungated too, so the one-action bound does not hold when the last step is a read.
- **An SSN without separators, and PIN/CVV by field name**; `plan.reconcile`, declarable but with no
  consumer; app-side session-aware refusal; and three of the five interstitial renders.

**What I would build next, in order:**

1. **Bound every page-touching driver call against a queued dialog**, so the recoverable class is
   demonstrable rather than merely implemented. The remaining failure is below the engine, in the driver.
2. **The parameterisation pass.** A discovered artifact records the literal the model typed; deciding which
   literals are really parameters is the one judgement step still done by hand, and it is what makes a
   recording reusable.
3. **A second tenant binding, committed with a run against it.** The mechanism exists and the mock has a
   second tenant; what is missing is the proof.
4. **Close the last two redactor holes** — an SSN without separators, and PIN/CVV.
