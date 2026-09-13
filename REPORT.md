# Report

An LLM drives a legacy UI once to accomplish a goal. That run becomes a typed, versioned capability
artifact. After that it replays deterministically with no LLM in the decision loop.

Everything here is checkable with `npm run verify`: typecheck, 240 tests across 24 files, the no-LLM
import walk, the evidence scan, the determinism comparison, and the full slice with no API key.
`DECISIONS.md` has the longer reasoning and the measurements behind each choice.

## Architecture

Three seams, each chosen so a claim holds structurally rather than by discipline.

**`Surface`** — how we perceive and act. Nothing in it mentions a browser: no `Page`, no `Locator`, no
`(page) => …` callback. `src/surface/playwright.ts` is the only file that imports Playwright, and it is
private to one chain. Two things follow rather than being promised: nothing can act outside the allowlist
because nothing else holds a driver, and another adapter implements the same eight methods.

**`ModelProvider`** — imports no SDK, which is what lets `verify-no-llm` walk the import graph from both
replay entry points and fail if it can reach a model SDK, `src/model/`, `src/discover/` or `src/compile/`.

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

**Dangerous artifacts are unrepresentable.** Eight rules reject at parse time: a `secret` input; a
PII-shaped literal where a `{{param}}` belongs; an acting step with no postcondition; a retry rule beside
an irreversible step; an output without exactly one producing step; a stored snapshot reference used as a
target; a contract understating its own risk; a step targeting an undeclared symbol. Each has a rejection
test pinned to its own message, so a schema that rejected everything would not pass the suite.

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
capability, current step, current state with a masked screenshot, and why it stopped; then reclaim if a
person answered, or expire if nobody did.

**Same session, proven.** The property fails silently — a handoff that quietly opened a second browser
would render identical screens and pass naive assertions. The strongest of three mechanical checks:
automation types the member id, the human who never types it presses submit, and the results carry that
member. A fresh session would have returned "no records match". That is the application reporting the two
actors shared one document.

**Two independent enforcement points.** The control lease refuses at the surface chokepoint, and the
driver refuses on its own flag, sharing no state with the lease, so a bug in one cannot produce two actors
writing at once. Three dispositions map to three distinct failure kinds: resolved, aborted, timed out —
collapsing "nobody came" into "the person gave up" would tell a caller to stop retrying when the right
move is to attach an operator.

The operator UI is mocked, as the brief permits. The transfer underneath is production code, proven
headlessly by a scripted operator driving the real browser; only who supplies the input is simulated.
Escalation is kept structurally unreachable from the determinism corpus, so a person's timing never
enters a byte comparison.

## Safety

**Allowlist.** Configurable origins, routes and action types, evaluated at the one chokepoint every action
passes through. Control is checked *before* permission: while a person holds the session, automation must
not act even when the action is otherwise legal.

**Risk.** Risk is separate from approval so the matrix can vary by deployment, and an artifact can never
talk its own risk down — the contract must equal the maximum over its steps. The irreversible path has
something real to exercise: the app refuses a lost/stolen report without a supervisor override, and since
the schema forbids a `secret` input, the capability is structurally incapable of supplying one. A person
is required by the shape of the artifact, not by a configuration choice.

**Redaction is on by default**, applied to the model's context and to evidence as bytes are written. The
boundary is deliberate: SSNs, card numbers and credentials are masked; member id, name, balances and card
last-4 are not, because redacting the member id would break discovery and masking a card number whole
would leave a card capability unable to say which card it acted on. `verify:evidence` scans every evidence
file for the seeded PII literals and the live API key, sourced at runtime so the detector cannot go stale,
and reports offences by label without printing a value.

**Limits.** `events.jsonl` is not yet redacted. Credential masking by field name applies only when the
value is a string. The third, app-side enforcement point — the application refusing a write while a human
holds the session — is **not built**: there is a mutating route such a check could protect, but the app
has no notion of a session or a holder, and this write-up does not claim otherwise.

## Cuts

**Deliberately not built:** a fourth result state; a generic idempotency subsystem; dry-run mode;
coordinate-based targeting; a global egress guard; browser tracing in committed evidence; and all scaling
infrastructure — containers, VNC, co-browsing, queues, operator routing — which §7 says is not rewarded.

**Stubbed at a clean seam:** the operator console UI, and the model during offline runs, where a cassette
replays a recorded transcript through the real loop and refuses if the screens no longer match.

**Known gaps:** `events.jsonl` redaction; `plan.reconcile`, declarable but with no consumer; app-side
session-aware refusal; three of the five interstitial renders; and the replay CLI writing no evidence if
the run itself throws, which needs a vocabulary decision first — an unexpected exception is not a citation
of anything.

**What I would build next, in order:**

1. **The parameterisation pass.** A discovered artifact records the literal the model typed. Deciding
   which literals are really parameters is the one judgement step still done by hand, and it is what makes
   a recording reusable rather than a one-off.
2. **A second tenant binding, committed with a run against it** — the mechanism exists and the mock has a
   second tenant; what is missing is the proof.
3. **App-side refusal during a human turn**, so the guarantee survives a bug in both other enforcement
   points.
4. **Redacting the event log**, closing the last boundary where a read value could reach disk unmasked.
