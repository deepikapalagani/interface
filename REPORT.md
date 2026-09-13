# Report

An LLM drives a legacy UI once to accomplish a goal. That run becomes a typed, versioned capability
artifact. After that it replays deterministically with no LLM in the decision loop.

Everything here is checkable with `npm run verify`: typecheck, the test suite, the no-LLM import walk,
the evidence scan, the determinism comparison, and the full slice with no API key. Each of the three
checkers runs its own `--self-test` inside that command, so a check that silently stopped working fails
rather than passes. `DECISIONS.md` has the longer reasoning and the measurements behind each choice,
including the ones that turned out wrong.

## Architecture

Three seams, each chosen so a claim holds structurally rather than by discipline.

**`Surface`** — how we perceive and act. Nothing in it mentions a browser: no `Page`, no `Locator`, no
`(page) => …` callback. `src/surface/playwright.ts` is the only file that imports Playwright, and it is
private to one chain. Two things follow rather than being promised: nothing can act outside the allowlist
because nothing else holds a driver, and another adapter implements the same eight methods.

**`ModelProvider`** — imports no SDK, which is what lets `verify-no-llm` walk the import graph from both
replay entry points and fail if it can reach a model SDK, `src/model/`, `src/discover/` or `src/compile/`.
That walk reads three import forms: static `import`/`from`, dynamic `import()` with a literal specifier,
and `import()` whose specifier is *not* a literal — which is refused outright, because a specifier the
walker cannot evaluate is one it cannot clear. It read only the static form until a reviewer planted
`await import("@anthropic-ai/sdk")` in the replay path and the gate passed with exit 0. In an ESM
codebase that is the natural way to add a model call, so the hole sat exactly where the guarantee lives.

**`Binding`** — translates symbols into one tenant's literals at exactly two boundaries: when an artifact
is read, and when one is written. Everything below deals only in what the markup actually contains.
Pushing symbols lower breaks it, measured the hard way: an early version translated inside the layer that
searches markup, so the locator hunted the page for a label that does not exist.

Discovery and replay are separate programs sharing the artifact and the surface, not one program with a
flag — which is what makes "no model in replay" checkable by reading imports.

## Artifact schema

Zod is the schema, TypeScript types are inferred from it rather than written twice, and
`parseCapability()` is the only way in. Three layers, each with a different reader:

- **contract** — what a calling agent binds to: typed inputs, typed outputs, declared business outcomes,
  risk.
- **plan** — what a human reviews: ordered steps, target descriptors, recovery rules, the checkpoint.
- **provenance + verification** — how it came to exist, and whether it has replayed.

**Twelve rules reject at parse time.** No `secret` input; no PII-shaped literal anywhere in `plan` or
`contract`; every acting step asserts a postcondition, and one that *differs* from its own precondition;
no retrying recovery in a plan holding an irreversible step; every output produced by exactly one step,
and that step a `read`; no stored snapshot reference as a durable target; a contract that cannot
understate its own risk; every symbol named as a target declared in `plan.targets` — whether a step names
it or a predicate atom does; plus uniqueness and well-formedness rules over refs and names. Each has a
rejection test pinned to its own message, so a schema that rejected everything would not pass the suite.

Four of these were rewritten after an audit found them asserting more than they enforced: the PII rule
inspected a single field while describing itself as "anywhere in the plan"; the postcondition rule was a
strict subset of a check Zod already ran; the retry rule tested the same condition twice; and the symbol
rule looked only at `steps[].target`, so a typo inside a checkpoint atom made a capability's success
condition unresolvable — or, in an `absent` atom, structurally incapable of failing.

**One declared field is knowingly left unenforced, and saying so is better than implying otherwise.**
`rowCount.grid` is exempt from the symbol rule. The evaluator ignores `grid` and counts rows page-wide,
so requiring the symbol to be declared would reject artifacts over a field that changes no behaviour —
and it would reject four frozen files: the committed `lookup@1.0.0` fixture and the `capability.json` in
three committed evidence runs all cite a `RESULTS_GRID` declared in neither their `plan.targets` nor the
binding. Those are graded evidence and are not being rewritten, so the field is exempt and the evaluator
now states in its own `observed` string that the count was page-wide.

**Targets carry reasoning, not just selectors.** Order is structural anchor → frame-scoped field name →
role+name, inverted from the obvious order because it was measured: role+name matches zero elements on
this surface, and the anchor survived both a frame rename and a field rename that the field name did not.
Coordinates are absent — they are not durable. The model's stated reason is recorded as a *belief*; the
locator is derived mechanically from the live page and verified to resolve before it is written.

The artifact is compiled from the executed **trace**, never the model transcript, and that is checkable:
the replay import graph may not even mention the transcript file.

## Determinism & error handling

No LLM in replay, enforced by the import walk; every replay manifest records `modelCalls: 0`.

**Waiting.** `settle()` races the conditions the artifact declared and returns the moment one holds. No
sleeps, no network-idle heuristics: an arbitrary wait passes on a fast machine and fails on a slow one,
and neither says anything about the application. A source test enforces that `settle` is the only module
referencing a timer.

**Precedence is the mechanism:** recovery → business outcome → postcondition → hard failure. If the
postcondition were checked first, "NO RECORDS MATCH — MSG 0071" would surface as `postcondition_failed` —
a crash where the caller needed an answer. A test supplies an observation satisfying both, so only the
ordering decides the result. The three classes live in three different places — `contract.outcomes[]`,
`plan.recovery[]`, and hard failure by default — because three branches of a function is a promise to be
careful, while three sections of a schema is a mechanism.

**A class checked in one place is only as real as the places it is not checked.** `plan.recovery[]` was
applied only where a recoverable condition was classified at a step's *precondition*; the same
classification at a postcondition was converted into `postcondition_failed` with no rule applied and an
`expected` naming a condition the step had never asked for. The shipped `broadcast` fault lands on
exactly that path, so the recoverable class failed precisely where it was demonstrated. Recovery is now
one helper called at all three observation points — precondition, postcondition, and the capability
checkpoint. The engine half of that gap is closed; the driver half is not, and the fault that exercises
it still does not pass reliably — see Known gaps.

**Typed outputs are now actually typed, and this changes a returned value's JSON type.** `Output.type`
had no consumer anywhere: the executor wrote the raw string it read off the screen while the result
contract claimed the values were "already validated against its schema". A declared output is now coerced
where it is captured — an `integer` returns a JSON **number** or fails as a typed `contract_violation`, a
`boolean` returns `true`/`false` from the spellings a green-screen renders, and a `string` is unchanged.
A caller binding an `integer` output used to receive digits as a string and now receives a number.

**Side effects are a run-level question.** A mutating step whose postcondition never confirms returns
`reconcile_required` with `sideEffectRisk: unknown` rather than inviting a retry, and every failure exit
keys on a run-scoped flag recording whether this run has issued a mutating action. Those exits originally
answered "may I retry?" with a constant, correct only while the app had no mutating route — including the
exit the card capability reaches, where the submit commits and the following read fails. A step's own
innocence is real and irrelevant; the caller is asking about the run.

**UI drift** is a signal, not an exception: a target resolving through a non-primary strategy logs
`degraded: true`, and a symbol the binding cannot express raises `UnboundSymbol` naming the missing key.
The run fails loudly rather than silently adapting.

**Proof.** `verify:determinism` runs four scenarios twice each as `reset → run`, comparing artifact bytes,
manifest, event log, result classification, exit code and the app's own state, after projecting away
timestamps and run ids. It spawns its own copy of the app rather than trusting whatever is listening on a
known port, and fails as vacuous rather than printing OK if too little was compared.

## Heterogeneity & multi-tenant

**The surface seam.** The recorded flow and the way we perceive and act are separate by construction. A
step says *fill the control anchored by the label `MEMBER_ID` on screen `MEMBER_SEARCH`* — never "CSS
selector", never "browser". A desktop or terminal adapter implements the same eight methods over UIA, the
OS accessibility tree, or a 5250 screen buffer, and neither the schema nor the replay engine changes.
Perception already uses the accessibility tree rather than the DOM, which is what desktop surfaces expose
too. The one thing an adapter must supply is a way to turn a control it can see into durable facts — a
label and an app-level field name — which is what target minting consumes.

**Multi-tenant reuse.** The plan names `MEMBER_ID` on `MEMBER_SEARCH`, never `MBRNO` on `MBR0300`. A
36-line binding file supplies one tenant's literals, so the same artifact serves many institutions running
the same vendor product, and a per-tenant override is a different binding rather than a re-recording. A
binding must be **reversible**: two symbols sharing a literal is refused at parse time, because otherwise
recording would have to guess, and a guess inside an artifact is a defect that surfaces on some other
tenant months later.

**Drift detection** falls out of the same design — variation a binding can express is configuration, and
anything it cannot is drift. The mock ships a second tenant that renames both frames and the member-id
field and prepends a grid column, so anything reading by position reads the wrong cell.

Honest limit: no second-tenant binding file is committed, so cross-tenant reuse rests on the mechanism and
the second tenant in the mock, not on a committed run against it.

## Escalation & handoff

**Detecting stuck.** The policy rates each action's effective risk. When that requires a person — an
irreversible action, or a screen the policy rates above what the artifact claims — the gate refuses with
`requires: human` and the executor routes it to escalation instead of failing. Previously this was
flattened into `policy_denied`, so a caller could not tell "a person must approve this" from "this is
forbidden, never retry".

**Taking control.** The ordering is the mechanism: cede the lease, which advances an epoch so any action
built before the handoff is refused afterwards; arm the driver's lock *before* painting the banner, since
a banner that fails to render must still leave a locked session; raise the request carrying goal,
capability, current step, current state and why it stopped; then reclaim if a person answered, or expire
if nobody did.

**What the masked screenshot actually does.** The capture blacks out the targets a capability flags as
`nameMayContainPii`, and refuses to produce an image at all if a flagged target fails to resolve. That
flag was hardcoded `false` on every minted target, so the filter was always empty while the operator
console captioned the result "masked at capture" regardless — a dead control reading as a working one.
Discovery now sets the flag from a PII-shape test over the screen a target was minted on, and the caption
reports the real number of blacked-out regions or says plainly **UNMASKED — this capability declared no
PII-bearing target**. The mitigation that was always real: those bytes are served from memory to the
operator and are never written under `/evidence/`.

**Same session, proven.** The property fails silently — a handoff that quietly opened a second browser
would render identical screens and pass naive assertions. The strongest of three mechanical checks:
automation types the member id, the human who never types it presses submit, and the results carry that
member. A fresh session would have returned "no records match". That is the application reporting the two
actors shared one document.

**Two enforcement points, and the third is not built.** The control lease refuses at the surface
chokepoint, and the driver refuses on its own `humanTurn` flag, sharing no state with the lease, so a bug
in one cannot produce two actors writing at once. The app-side point — the application itself refusing a
write while a human holds the session — does **not** exist: the mock has a mutating route such a check
could protect but no notion of a session or a holder. It records the *authority* a request carried (a row
is `HUMAN` iff a supervisor override was supplied), which is an assumption about the deployment rather
than an enforcement. Three dispositions map to three distinct failure kinds: resolved, aborted, timed
out — collapsing "nobody came" into "the person gave up" would tell a caller to stop retrying when the
right move is to attach an operator.

The operator UI is mocked, as the brief permits: one HTML page, no framework. The in-page banner does
render — measured through the public `Surface` API, `AUTOMATION IS PAUSED` and a `HAND BACK` button
appear in every paintable frame on cede and are gone after hand-back — and either door ends the turn,
because the banner's button and the console's button resolve the same promise. It did not render until
this pass: tsx's transpiler rewrote the painting function to call a helper absent from the page, and a
bare catch swallowed the `ReferenceError`, which is a good argument against catching an error you have
not identified. Escalation is kept structurally unreachable from the determinism corpus, so a person's
timing never enters a byte comparison.

## Safety

**Allowlist.** Configurable origins, routes and action types, evaluated at the one chokepoint every action
passes through. Control is checked *before* permission: while a person holds the session, automation must
not act even when the action is otherwise legal.

Be precise about what it gates: **where an action is issued from, not where it lands.** No verb in
`SurfaceAction` carries a destination — `click` and `navigate` both name a control, and where that control
takes the session is the application's business. So a click that navigates off-allowlist is not refused as
it is issued; it is caught on the *next* action, which is gated on the new location. One action's worth of
exposure is the real bound. `deniedRoutes: ["/__admin"]` carries the same limit: it is a declared intent
matched against the current page. What actually stops a capability arming its own faults is that no verb
can POST to an arbitrary URL and no screen renders a control reaching `/__admin`.

**Risk.** Risk is separate from approval so the matrix can vary by deployment, and an artifact can never
talk its own risk down — the contract must equal the maximum over its steps. Risk is also no longer
invented: the compiler refuses to compile a step whose risk it cannot establish from the screen and the
action, rather than stamping `read_only` on everything — which is what a discovery run that clicks a
committing submit used to produce, giving a failed replay `retry_safe` on a card it had already actioned.
The irreversible path has something real to exercise: the app refuses a lost/stolen report without a
supervisor override, and since the schema forbids a `secret` input, the capability is structurally
incapable of supplying one. A person is required by the shape of the artifact, not by a configuration
choice.

**Redaction is on by default**, applied to the model's context, to the discovery evidence files, and to
`events.jsonl` and `handoff.jsonl` as bytes are written. The boundary is deliberate: SSNs, card numbers and credentials are
masked; member id, name, balances and card last-4 are not, because redacting the member id would break
discovery and masking a card number whole would leave a card capability unable to say which card it acted
on. `verify:evidence` scans every evidence file for the seeded PII literals and the live API key, sourced
at runtime so the detector cannot go stale, and reports offences by label without printing a value.

**Limits, each measured rather than assumed.** The event log is no longer one of them: `EvidenceWriter.event`
runs every line through `redactDeep` as it appends it and stamps `redacted: true` only when masking changed
the bytes — measured directly, a read of the card screen writes `************4021` and `***-**-0101`. What
remains open is shape-bound rather than a whole file: the SSN rule matches only the hyphenated form, because
a bare nine-digit rule would mask every member id on this surface. The live-key detector reads `.env`,
which is gitignored, so in a fresh clone it does not exist at all; the checker now says so in its own
output instead of reporting a clean scan, because "no secrets found" and "no secrets looked for" must not
print the same way. Its PII ground truth is sourced from the mock's seed at runtime and floored **per
class**, so a reseed that changed only the SSN rendering can no longer leave that class silently
unchecked. Credential masking by field name applies only when the value is a string, and PIN/CVV are
absent from the field list. The third, app-side enforcement point is **not built** — see Escalation
above.

## Cuts

**Deliberately not built:** a fourth result state; a generic idempotency subsystem; dry-run mode;
coordinate-based targeting; a global egress guard; browser tracing in committed evidence; and all scaling
infrastructure — containers, VNC, co-browsing, queues, operator routing — which §7 says is not rewarded.

**Removed rather than left half-working:** the discovery `screenshot` tool. A model that can request a
screenshot but whose loop cannot act on image bytes spends tokens narrating pictures to itself; the
accessibility-tree observation is the perception path that actually drives the run.

**Collected but deliberately not compiled:** the model's stated success condition. The `finish` tool takes
it as prose, and turning prose into an assertion is a judgement step, so the compiled checkpoint asserts
what the run mechanically established instead. The field has no consumer — named here rather than dressed
up as a feature.

**Hand-authorable but not discoverable:** static-text reads. A `read` step against a label/value row is
expressible in the schema and replays correctly — the card capability's confirmation number is one — but
discovery has no tool that mints such a target, so an artifact needing one is written by hand.

**Stubbed at a clean seam:** the operator console UI, and the model during offline runs, where a cassette
replays a recorded transcript through the real loop and refuses if the screens no longer match.

**Known gaps:**

- **The recoverable class is not reliably demonstrable end to end.** The engine side is fixed — recovery
  is applied wherever a recoverable condition is classified, not only at preconditions — but a queued
  native dialog can still block the driver's page-touching calls. Measured three times against the
  `broadcast` fault on this tree: one run completed with `success` and one APPLIED row, two did not
  return within 240s and 420s, the second on a freshly started mock with nothing else running.
  `npm run mock:fault -- --run broadcast` therefore reports a loud mismatch rather than passing, and its
  expectation deliberately states the designed behaviour: an intermittent pass is not a working
  mechanism, and a fault demo that went green on a hang would be worse than none. The other two faults
  pass exactly as declared, including `undeclared_dialog`, which until this pass no code path could
  produce.
- **An SSN rendered without separators, and PIN/CVV by field name**; `plan.reconcile`, declarable but with
  no consumer; app-side session-aware refusal; three of the five interstitial renders; and the replay CLI
  writing no evidence if `replay()` itself throws.

Two gaps listed here previously are now closed, by one run. `escalation-timeout` under `/evidence/` is a
failed `report_lost` replay that ceded to a person nobody answered: it carries `handoff.jsonl`,
`disposition: "timeout"`, and the `operator` and `policy` why-arms, so §3.6 is exercised by a committed
file rather than only by a test. The same record carries the redacted `observedText` of the screen the
run stopped on, which is §3.5's richer signal — as a **text snapshot rather than an image**, because
`verify:evidence` holds a run directory to a closed filename set that deliberately excludes
`screenshot.png` so its own self-test can plant that name and prove the rule fires. The brief permits a
screenshot, a DOM snapshot or a trace; this is the second.

**What I would build next, in order:**

1. **Bound every page-touching driver call against a queued dialog**, so the recoverable class is
   demonstrable and not merely implemented. The engine now applies recovery everywhere it classifies one;
   the remaining failure is below it, in the driver.
2. **The parameterisation pass.** A discovered artifact records the literal the model typed. Deciding
   which literals are really parameters is the one judgement step still done by hand, and it is what makes
   a recording reusable rather than a one-off.
3. **A second tenant binding, committed with a run against it** — the mechanism exists and the mock has a
   second tenant; what is missing is the proof.
4. **A committed handoff run**, so §3.6 rests on a file in `/evidence/` and not only on a test.
5. **Closing the last two holes in the redactor** — an SSN rendered without separators, and PIN/CVV, which
   are absent from the credential field list. The event log itself is already redacted on the way out.
