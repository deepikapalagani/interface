# Decisions log

Appended **at the moment each decision is made**, so `REPORT.md` is assembled rather than
authored under time pressure at the end. Two of the eight graded criteria are almost entirely
the write-up, and nine MUST requirements land in it, so this file is load-bearing.

Each entry: what was decided, why, and which `REPORT.md` heading it feeds.

---

## Stack

**TypeScript on Node 20.17, ESM, Playwright pinned 1.63.0, Zod for schemas.**
One language for the mock, the agent, the replay engine and the tooling, so a reviewer runs one
`npm install` and never sets up a second runtime. Zod gives one source of truth for the artifact
schema that also emits JSON Schema for the agent-facing contract.
→ *Architecture*

## Model provider — free, and behind a seam

**GLM-4.7-Flash via Z.ai's OpenAI-compatible endpoint, with Gemini Flash free tier as a drop-in
fallback.** §4 puts provider choice explicitly in the candidate's hands. The adapter seam means
switching is a base URL and a model name.

Measured 2026-09-12: tool calling works under both `auto` and `required` — well-formed call, valid
JSON arguments, correct target. Per turn: prompt 284 / completion 177–214 tokens, 3–4s.
`json_schema` + `strict` is **not** honoured (returns fenced markdown, ignores the schema), so the
compile step uses `response_format: {type:'json_object'}` plus Zod validation and retry. Roughly
2 in 8 calls return a 429; **retry-with-backoff is mandatory in the adapter**, not optional.

> **Correction, 2026-09-13.** The first sentence describes a design that was never built. `response_format`
> and `json_object` appear nowhere in the repo, and there is no model-driven compile step to apply them to:
> `src/compile/mechanical.ts` imports no provider and derives the artifact from `trace.jsonl` alone. That
> turned out to be the better design — compilation is deterministic and re-runnable (`npm run recompile`)
> precisely because no model is in it — but this entry predates the decision and was never revisited. The
> second sentence is accurate and still load-bearing: the 429 rate is real and the adapter's
> retry-with-backoff is pinned by `tests/openai-compat.test.ts`.

The design consequence worth stating: discovery can run on infrastructure an institution controls,
and replay uses no model at all, so nothing in a recorded capability depends on who authored it.
→ *Architecture*, *Safety*

## The three result classes live in three places

**Business outcomes in `contract.outcomes[]`, recoverable conditions in `plan.recovery[]`,
everything else a hard failure by default.** The glossary calls conflating these the most common
design mistake here, and criterion 3 grades how cleanly they separate. Three branches of a function
is a promise to be careful; three sections of a schema is a mechanism.

`ReplayResult` is a three-variant union — `success | business_outcome | failed`. Escalation is a
transition *inside* a run, recorded on the envelope, not a fourth status; `controlAtExit` tells the
caller who holds the session without widening the union.
→ *Determinism & error handling*

## Locator strategy is inverted, on evidence

**`table_anchor` first, frame-scoped `field_key` second, `role_name` third. No coordinates.**
Measured: on this surface `role_name` matches **0** elements, while the structural anchor and the
field name each match exactly 1. The anchor survived both a frame rename and a field rename; the
field name survived neither. Frame scoping is load-bearing — the same field name exists in two
frames. A non-primary strategy resolving logs `degraded: true`, which is the per-tenant drift
signal §3.7-d asks for.
→ *Determinism & error handling*, *Heterogeneity & multi-tenant*

## Dialogs: recorder installed before the first action

Measured: with **no** dialog listener Playwright auto-**dismisses** a native `confirm()`, so the
submit is cancelled while the click still reports success — a phantom success, which is worse than
a crash in a system whose central claim is a verified checkpoint. A queued-but-unhandled dialog
blocks the action instead, which is exactly how an undeclared dialog becomes a typed hard failure.
This is also the concrete case proving every acting step needs a postcondition.
→ *Determinism & error handling*

## Same-session handoff

**`addInitScript` banner + `exposeBinding` hand-back on one headed context.** Measured with a real
human turn: a cookie set before the turn survived it, one page throughout, the human navigated two
screens, the banner survived navigation inside a frameset, and automation acted again only after
reclaiming. No container, no VNC, no screencast.

> **Correction, 2026-09-13 — the banner clause is false of the shipped driver.** That probe was hand-driven;
> the code path that shipped does not do it. `PlaywrightSurface.notice()` paints via
> `frame.evaluate(paintBanner)` and registers the same function through `addInitScript`, and both fail
> inside the page with `ReferenceError: __name is not defined`: the project runs exclusively through tsx,
> and esbuild's keep-names transform rewrites the nested `const render = async () => …` inside
> `paintBanner` as a call to a module-scope `__name` helper that does not exist in the browser. A bare
> `.catch(() => {})` swallowed it, and its comment blamed mid-paint navigation. Reproduced by a reviewer
> who replaced only that catch with a logger: the ReferenceError printed from all three frames, in both
> the evaluate and the init-script path. What is false is the VISIBLE half only — the control transfer
> itself completes through the operator console on :7900, and the same-session property is still proven
> headlessly in `tests/handoff.integration.test.ts`.
>
> **Second correction, later the same day — it is fixed, and this banner's own closing sentence was the
> last thing asserting otherwise.** The painting function no longer relies on a nested arrow, so nothing
> is rewritten to `__name`, and the swallowing catch now logs. Measured directly through the public
> `Surface` API against a live mock, with no agent in the loop: before the handoff neither the banner
> text nor its button is present; during it `AUTOMATION IS PAUSED` is on screen and TWO
> `button:"HAND BACK"` nodes appear in the accessibility tree, one per paintable frame of the frameset;
> after hand-back both are gone. Worth recording how close this came to shipping backwards: the fix and
> the documentation were written by different components of the same pass, running in parallel, and the
> docs component described the defect its sibling was in the middle of repairing. For a few hours three
> reviewer-facing files asserted a fault the code no longer had — the mirror image of this repo's usual
> sin, and no better.

One correction from the measurement: the banner's target frame must be chosen **from Node** by
frame name or URL. At `addInitScript` time a frameset's column sizing is not yet applied, so a
width guard inside the page misfires.

Still owed at the time of writing: lease **enforcement** — that automation is *prevented* from acting
mid-handoff — as a separate mechanism, automatable headlessly.

> **Delivered.** `assertAutomation` runs at the single surface chokepoint before the policy check, so an
> action by the wrong actor fails rather than being labelled; the epoch fence refuses any action built
> before the transfer; and the driver refuses on its own flag, sharing no state with the lease, so a bug
> in one cannot produce two actors writing at once. `tests/gate.test.ts` and
> `tests/handoff.integration.test.ts` pin both halves, and `evidence/runs/escalation-timeout` is a
> committed run that ceded, timed out and handed control back.
→ *Escalation & handoff*

## Dangerous artifacts are unrepresentable

Eight Zod refinements, each with a rejection test pinned to its own message: no `secret` input, no
PII-shaped literal in place of a `{{param}}`, no acting step without a postcondition, no retry
recovery alongside an irreversible step, no output without exactly one producing step, no persisted
snapshot ref as a durable target, no contract understating its own risk, no step targeting an
undeclared symbol.

> **Correction, 2026-09-13 — there are now TWELVE, and four of the original eight asserted more than
> they enforced.** An adversarial audit broke seven of the eight lines of defence with a 35-case probe:
> 34 of 35 malicious documents parsed clean. The PII rule described itself as covering "anywhere in the
> plan" while inspecting exactly one field; the postcondition rule was a strict subset of a check Zod
> already ran, so it could never be the sole cause of a rejection; the retry rule tested the same
> condition twice, forbidding the harmless combination and admitting the dangerous ones; and the symbol
> rule looked only at `steps[].target`, so a typo inside a checkpoint atom went undeclared — and in an
> `absent` atom evaluated TRUE, making a capability's success condition structurally incapable of
> failing. All four are rewritten and the count is now twelve (`schema.ts`, numbered blocks 1-12).
> One exemption is deliberate and named rather than hidden: `rowCount.grid` is excluded from the symbol
> rule, because the evaluator ignores `grid` and counts page-wide, and requiring it would reject four
> frozen committed files over a field that changes no behaviour.

The tests assert *which* refinement fired, not merely that parsing failed — a table that only
checked `success === false` would pass against a schema that rejected everything.
→ *Artifact schema*, *Safety*

## Symbols, not tenant literals

The plan names `MEMBER_ID` on `MEMBER_SEARCH`, never `MBRNO` on `MBR0300`. A sibling binding file
resolves symbols per tenant, so one artifact serves many institutions running the same vendor
product. Anything a binding cannot express is drift by construction.
→ *Heterogeneity & multi-tenant*

## Frozen before any other code

**Screens (8):** `SEC0100` sign-on, `MNU0200` menu, `MBR0300` search, `MBR0310` results (never
auto-advances), `MBR0400` member detail, `CRD0500` card services, `CNF9000` confirmation, `AUD9500`
audit inquiry. **Renders reachable from anywhere (5):** `SEC0403` denial, `SEC0999` session
terminated, `SYS0500` abend, `SYS0800` broadcast, and a validation modal.

**Flagship capability:** `msc.card.set_status@1.0.0` — search → results → detail → card services →
confirmation, with `action: FREEZE | UNFREEZE | LOST_STOLEN`. Risk is a property of the parameter
*value*: freeze and unfreeze are reversible, lost/stolen is irreversible. The graded discovery run
uses FREEZE precisely because it is reversible and the fixture can be re-run while tuning.
Second, read-only capability: `msc.member.read_balances@1.0.0`, reusing screens 1–5.

> **Correction, 2026-09-13.** Two claims above are false of what shipped, not one.
>
> The graded discovery run does **not** use FREEZE. Both committed discovery runs are
> `msc.member.lookup`, goal "Look up member 400200101" — `set_status` and its `FREEZE` parameter are
> exercised by replay, by the determinism corpus and by the fault harness, but never by a discovery run.
> The reasoning in the sentence is sound and still describes why `card-freeze` is the mutating scenario in
> the determinism corpus; it simply attached itself to the wrong run.
>
> And `msc.member.read_balances@1.0.0` was never built and appears nowhere in the
> repo — not as a fixture, not in evidence, not in a test. The read-only capability that exists is
> `msc.member.lookup@1.0.0` (`tests/fixtures/lookup@1.0.0.json`, and the compiled `capability.json` in
> every committed replay run). The frozen name is left in place because this log is chronological, but it
> names nothing a reviewer can run.

Freezing this list first is what stops components building demos on screens that do not exist.
→ *Architecture*

## The mock's clock is frozen, not ticking — a deviation from the plan

The plan specified a virtual clock "advancing a fixed tick per request". Building it that way and
testing it showed the tick defeats its own purpose: every rendered timestamp depends on how many
requests preceded it, so one extra `observe()` or a single retry shifts the clock on every later
screen and two otherwise identical runs produce byte-different evidence.

**Frozen instead**, with a monotonic sequence number on audit rows carrying the ordering that
actually needs to be monotonic. Simpler, and strictly more deterministic.

Worth recording how this surfaced: the failing check was itself badly built — it compared a page
fetched mid-run against one fetched immediately after a reset, which was never the determinism
property. The property is *reset → run* versus *reset → run*. A wrong test found a real design
flaw, but it was nearly dismissed as a broken assertion, which is the argument for pinning what a
check actually proves.
→ *Determinism & error handling*

## One chokepoint, and control is checked before permission

`GatedSurface` is a decorator implementing the same `Surface` interface and wrapping another. Its
`act()` runs `lease.assertAutomation()` → `policy.evaluate()` → `inner.act()`.

**That ordering is a decision, not an accident**, and it has its own test. While a person holds the
session, automation must not act *even when the action is entirely legal* — who is driving outranks
what is permitted. The test arranges a request that both rules would refuse and asserts the failure
is a control violation rather than a policy denial.

Because `PlaywrightSurface` is the only module importing Playwright and is private to this chain,
two claims hold structurally rather than by discipline: nothing can act outside the allowlist
because nothing else holds a driver (§3.4-b), and automation cannot act during a handoff because
the same function refuses (§3.6-e).

**Read paths delegate ungated, deliberately.** `observe`, `find`, `read` and `screenshot` change
nothing in the target, and blocking perception during a handoff would prevent the re-synchronisation
§3.6 requires *afterwards* — the run has to be able to see what the human did.

**`ActionContext` carries `url` and `screen`** rather than the gate re-perceiving them. The executor
has just evaluated the step's preconditions, so it already knows where it is; making the gate
observe again would spend a full perception round-trip per action to learn something in hand.

The enforcement test runs headless against a stub surface, so it lives in CI rather than in the one
manual demo. Its load-bearing assertion is not that the call threw — it is that **nothing reached
the target**. A gate that throws after acting is not a gate.
→ *Safety*, *Escalation & handoff*, *Architecture*

## The replay path: settle decides *when*, classify decides *what*

Two primitives, split along a line that matters. `settle()` races every declared condition and
returns the instant one holds — so it answers "has something happened yet?". `classify()` then
applies precedence to the same observation and answers "which of the three classes is it?".

Keeping them apart means neither has to know the other's concerns, and it collapses five
requirements onto one wait: preconditions, postconditions, the checkpoint, business-outcome
detection and recovery triggers are all the same call with different predicate sets.

**There are no sleeps and no network-idle heuristics anywhere in the replay path.** An arbitrary
wait makes a run pass on a fast machine and fail on a slow one, and neither is a statement about
the application. Every wait is bounded by a condition the artifact declared. `settle` is the only
module permitted to reference a timer, and a source test enforces that as the engine grows.
→ *Determinism & error handling*

## Precedence, and what a mutating step does when it cannot confirm itself

Classification order is **recovery → business outcome → postcondition → hard failure**, and the
order is the mechanism rather than a style choice. A declared obstruction is cleared first, because
judging what sits underneath a blocking dialog is reading a half-obscured screen. A declared
terminal answer wins next. Only then does the step's own postcondition get a look.

If the postcondition were consulted first, "NO RECORDS MATCH — MSG 0071" would surface as
`postcondition_failed` — a crash where the caller needed an answer. That is precisely the mistake
the glossary names, and there is a test whose observation satisfies *both* the declared outcome and
a postcondition failure, so only the ordering decides which the caller receives.

**A mutating step whose postcondition never holds is the dangerous case.** The submit may or may not
have landed, so the result carries `remediation: reconcile_required` and `sideEffectRisk: unknown`
rather than inviting a retry. Read-only steps in the same position return `retry_safe`. This is the
thin mechanism that replaced a generic idempotency subsystem.
→ *Determinism & error handling*, *Safety*

## An invocation establishes its own starting position

A capability declares the screen its first step expects, but nothing in the artifact says how to
*get* there. The first integration test shared one browser across runs, and the second run failed
its opening precondition because the first had left the session on the results screen.

That was the test's bug. It also named a real property: **a run must position itself rather than
inherit wherever the last one finished**, or replay is only deterministic when it happens to be
invoked in the right order. Each invocation now launches at the capability's entry point against
reset target state, which is also how a production worker would call one.

Still owed: a gated `goto` on the surface, for a capability that needs to navigate to a URL
mid-flight rather than by clicking a link. It has to pass the allowlist like any other action, so
it belongs on the `Surface` interface rather than beside it.
→ *Determinism & error handling*

## The checkpoint is asserted, not inferred

Every step passing its own postcondition is not the same as the capability having achieved what it
claims. The executor originally returned the last step's postcondition and the result labelled it
`checkpoint` — a success the system never actually checked, which is the same phantom-success shape
as the auto-dismissed dialog.

§3.2 requires a declared success condition and §3.3 requires replay to verify it, so
`plan.checkpoint` is now evaluated after the final step, with its own `checkpoint_failed` kind. The
`checkpoint` field in a successful result is therefore the thing that was genuinely asserted.
→ *Determinism & error handling*, *Artifact schema*

## A discovery run surfaces the errors it recovered from

The loop tolerates a failed tool call on purpose — a malformed argument or a stale ref should be
handed back to the model as a correction rather than ending a run that costs real money. But the
first round-trip test produced the worst possible shape: the run declared `goal_reached` and
recorded **zero** steps, because every acting call had failed and every failure had gone only into
the transcript.

`DiscoveryResult` now carries `errors`, and the run summary counts them. The diagnosis that took a
whole cycle to extract became a single line of output.

The general rule this is an instance of: **a component that recovers from failures must report what
it recovered from.** Silent recovery and success are indistinguishable from the outside, and the
difference is exactly what a reviewer needs to see.
→ *Determinism & error handling*, *Architecture*

## The surface speaks literals; the binding translates only at the edges

Symbols are an artifact concern, not a surface concern. The surface deals in what the DOM actually
contains — field `MBRNO`, label `"MEMBER ID"` — and the binding translates at exactly two
boundaries: `resolve()` when an artifact is read, the compiler when one is written.

This was arrived at the expensive way. Canonicalisation first went into `BoundSurface.describe()`,
which pushed symbols *below* the layer that searches real markup, so `find()` hunted the page for a
`MEMBER_ID` label that does not exist. The fix was to delete that layer, not to add another one
resolving symbols back again.

The one thing that does translate live is the screen id, because predicates compare screens *during*
a run. Everything else can wait for the boundary.

Two supporting rules: a binding must be reversible, so two symbols sharing one literal is refused at
parse time rather than making minting guess; and an unknown literal is passed through untranslated,
so it fails loudly at `resolve()` naming the missing symbol instead of being silently mangled.
→ *Architecture*, *Heterogeneity & multi-tenant*

## Discovery emits the structured log it was always supposed to

`EventSequencer` was constructed in the discovery CLI, flushed to `events.jsonl`, and never passed to
the loop — so a real run wrote a zero-line log and the `model_decision` arm of the event union had
never once been exercised. §3.5 asks for a structured record of *why* the system acted; a run that
records what it did while omitting what it decided answers half of that.

The loop now takes the sequencer and emits one `model_decision` per turn carrying the model's own
stated reason, attributed as a belief rather than as a fact the system verified.

The same run reported `model.calls: 0` in its manifest — hardcoded, and false: it made three. That
field carries the replay path's central claim, so a discovery manifest that falsely claims zero
devalues the replay manifest that truthfully does. The adapter now counts its own requests.

**A hardcoded provenance field is worse than an absent one**, because it is indistinguishable from a
measured one.

Reading the resulting log then caught the same fault one file over. The loop emitted a second line
per turn on the `artifact_step` arm — whose documented meaning is a *citation a reviewer can open*,
naming a capability and step — with `capability: "(discovery)"`, during a phase where no capability
file exists yet. A tool error was likewise filed as `handler`, which means a **declared** recovery
rule fired; discovery has no recovery table. Both were fabricated citations, and the `finish` line
was emitted twice.

Now exactly **one event per turn**, emitted *after* execution so a single line carries both halves
§3.5 asks for — the reason the model stated, and what was then observed — always on the
`model_decision` arm, the only one that is true during discovery.
→ *Evidence*, *Determinism & error handling*

## Why the compiled checkpoint does not assert a row count — yet

A compiled checkpoint asserts only the screen the run ended on, so a zero-row results screen
satisfies it and "no records found" would replay as success. The obvious fix is `rowCount gte 1`, and
the trace now records `rowsAfter` — counted by the replay evaluator's **own** function, exported for
the purpose, so a compile-time count and a replay-time count cannot drift apart by construction.

It is deliberately not emitted yet, because on its own it is the *same* §3.3 mistake mirrored. With
no MEMBER_NOT_FOUND in `contract.outcomes`, asserting `rowCount gte 1` converts a legitimate business
outcome into a hard failure rather than into a phantom success. `classify` tests outcomes *before*
the checkpoint, so the assertion is correct only once the outcome sits beside it — and both describe
the application rather than one run, so both arrive from the app profile together.

`gte 1` rather than `eq n` when it does land: what a checkpoint must separate is found from not
found, and an exact count would weld the capability to one result size.

**Measured afterwards, and it changed the conclusion.** `dataRowCount` was probed against all three
states: search form **2**, results with one match **1**, results with *zero* matches **2** — not 0,
because an observation spans the whole frameset and the empty render is itself a form. So
`rowCount gte 1` would have passed on "NO RECORDS MATCH": the atom intended to prevent a phantom
success would have permitted exactly one. The deferral was right for a second reason not known when
it was made, which is the argument for measuring a fix before trusting the reasoning behind it.

Three defects surfaced while establishing this, all predating the change:
- `predicate.ts` evaluates `rowCount` across the whole observation and **ignores `atom.grid`**, which
  the schema requires every such atom to carry. Its own comment claimed `eq 0` carries
  MEMBER_NOT_FOUND; the measurement above shows that is false as implemented, and the comment now
  records the numbers instead of the intention.
- The committed `lookup@1.0.0` checkpoint asserts `rowCount eq 1`, so on this surface a not-found
  replays as `checkpoint_failed` — a hard failure where the caller needed a business outcome. The
  mirrored §3.3 mistake, live in a fixture.

  > **Corrected 2026-09-13: it does not, and the committed evidence is what settles it.** `classify()`
  > tests `contract.outcomes[]` *before* the checkpoint is ever evaluated, and `lookup@1.0.0` declares
  > MEMBER_NOT_FOUND, so the not-found run never reaches the checkpoint at all —
  > `evidence/runs/replay-lookup-not-found/manifest.json` records `"result": "business_outcome"`, exit 0.
  > The `rowCount eq 1` clause is still wrong on its own terms, and would misfire the moment that outcome
  > were removed; what makes it unreachable is the precedence rule this log argues for two sections
  > earlier. The defect was real — it was the reasoning about its consequence that was wrong.
- Refinement 8 validates only `step.target`. Symbols named *inside* predicate atoms are never checked
  against `plan.targets` — that same fixture's checkpoint names a `RESULTS_GRID` which is **not**
  among its declared targets, and it parses cleanly today only because the evaluator never resolves
  `grid`. Two defects each hiding the other.
→ *Determinism & error handling*, *Artifact schema*

## The verifiers, and what they actually prove

`npm run verify` referenced five scripts that did not exist; only `verify-no-llm` was real. Two now
exist beside it, each with a `--self-test` that plants defects and asserts they are caught, because the
standing rule here is that **a check which cannot fail is worse than no check**.

**`verify-determinism` gives a substantive answer, not just a green tick.** Replay is deterministic
across all three result classes: `capability.json` bytes, the manifest, the event log, the result
classification, the process exit code and the app's own before/after state all reproduce exactly across
`reset -> run` versus `reset -> run`. Eleven planted divergences were each rejected with an accurate
message. It refuses to skip when the mock is unreachable — skipping is how a check becomes vacuous —
and it fails as VACUOUS rather than printing OK if fewer than four event lines were compared. Today it
clears that floor by exactly zero margin, which is recorded rather than tuned away.

> **Both numbers corrected 2026-09-13, by running it.** There are **three** planted divergences, not
> eleven: a changed event name and a changed result status, which must be REJECTED, and changed
> timestamps and run ids, which must be IGNORED — the third is the one that proves the projection is not
> simply dropping everything inconvenient. And the corpus does not clear the event-line floor by zero
> margin: the measured run compares **25** event lines (found 4, not-found 5, bad-input 1, card-freeze
> 15) against `MIN_EVENT_LINES = 4`. The "zero margin" claim predates both the card-freeze scenario and
> the evidence fixes that gave failing runs a log at all. Four scenarios, each run twice, exit 0.

**`verify-evidence` exits 1 today, correctly**, on a real gap: no replay evidence is committed, so §6's
"logs from a replay run" is unsupported by any file. The rule was deliberately not weakened to "if a
replay run exists", which would make it vacuous.

> **Superseded later the same day.** Replay evidence for all three result classes is now committed and
> this checker exits 0 across 5 runs and 19 files — 6 runs and 23 files as of 2026-09-13, once
> `escalation-timeout` was committed. The gap it named was real, and refusing to weaken the
> rule is what kept it visible until it was closed.

Its measured limits are recorded rather than implied, because an overstated checker is the failure mode
this whole exercise is guarding against:
- the MODEL_API_KEY detector silently ceases to exist when `.env` is absent — i.e. in any clone, since
  `.env` is gitignored — while the script still reports OK;
- the transcript cross-check is one-sided and evaded by simply not committing a transcript;
- a broken manifest masks the remaining checks for that run (never a false pass — the run still fails);
- the `--self-test`'s per-check proof was overstated by 2x: sabotaging eighteen checks one at a time left
  nine self-tests still passing, because the expected-offence substrings cross-satisfy one another.

One genuine exit-0 false pass was found and fixed: a subdirectory bypassed the "only declared filenames
may appear" rule entirely, because the loop filtered on `isFile()`.

**`evidence/runs/discovery-lookup` was moved out of the deliverable** (moved, not deleted — this is not
a git repository, so deletion has no undo). Its manifest claimed `model.calls: 0` while its own
transcript held three assistant turns, and it carried no `events.jsonl`. It is superseded by
`discovery-lookup-v3`, which has both. A graded evidence tree must not ship a run whose manifest is
provably contradicted by the run's own files.
→ *Determinism & error handling*, *Evidence*, *Safety*

## The mock is smaller than the plan frozen against it

> **Superseded the same day. Banner added 2026-09-13** — this section had none, while both of its
> neighbours did, so a linear reader met its present tense as current fact. Every claim below was true
> when written and is false of the shipped mock: CRD0500 and CNF9000 both exist (`mock/screens.ts`
> `cardServices`, `confirmation`), `/screen/cards` is routed, `POST /screen/card-action` is a real
> mutating route (`mock/main.ts`), `applyCardAction` appends to `state.audit` on every attempt against a
> real membership (`mock/actions.ts`), `/screen/audit` renders all nine fields of every row, and
> `msc.card.set_status@1.0.0` — called "unbuildable" below — is built, committed, replayed in CI and
> exercised by all three faults. Read what follows as "before that build", and see "The app can change
> something, and three exits were only correct because it could not" further down.

Measured against the frozen list above: `mock/screens.ts` exports nine renderers, and **six of the eight
screens exist**. CRD0500 card services and CNF9000 confirmation were never written, and **all five**
"reachable from anywhere" renders — denial, session terminated, abend, broadcast, validation modal — are
absent. This is unbuilt scope, not unrouted scope.

The detail screen links to `/screen/cards`, which `main.ts` does not route, so the CARD SERVICES link is
dead and falls through to the 404 render.

**More consequentially, the mock has no mutating route at all.** Every application path is a pure read.
The only writes to state are `POST /__admin/reset` and `nextConfirmation`, whose sole caller
`issueConfirmation` is exported "for tests" and is never called by anything; nothing ever appends to
`state.audit`. So the file's own header property — "AN AUDIT TRAIL OF ITS OWN… which is how a phantom
success gets caught" — is **false as implemented**: the independent record that automation evidence was
to be reconciled against is permanently empty, and `/screen/audit` renders nothing.

Three consequences worth stating plainly rather than discovering later:
- §3.4's separation of risky/irreversible actions currently has **nothing to exercise**, because no
  action can change anything.
- The flagship `msc.card.set_status@1.0.0` is **unbuildable** against this server as frozen.
- The seeded PAN is commented in `seed.ts` as "the redaction target", but no screen renders it, so PAN
  redaction cannot be tested end to end. The SSN can be: `/screen/detail` is routed and renders it, which
  is the one reachable leak path.

The determinism checker's app-state comparison is therefore live code pointed at a constant. It is kept,
because it will bite the moment a mutating route exists, and its summary line says what it does not
prove.
→ *Safety*, *Architecture*, *Cuts*

## §3.6 today is one real mechanism and four declared ones

> **Superseded by "§3.6 built" below, later the same day.** Kept because this log is chronological and
> because the census in it is what made the build's acceptance criterion concrete: every mechanism named
> here as dead now has a production caller. Read the present tense below as "before that build".

`ControlLease` is not a status field, and the half that is wired is the half that matters most:
`assertAutomation` runs at the single surface chokepoint, before the policy check, so an action by the
wrong actor **fails** rather than being labelled. Nothing can act outside it, because nothing else holds
a driver.

The rest is declared but unwired. Caller census measured 2026-09-12, across `src`, `tests` and `scripts`:

- **`expire()` — no caller anywhere.** Its own comment says an expired escalation means "nobody resolved
  anything, and the run must fail with its own failure kind rather than silently continuing". With no
  caller, an escalation cannot time out at all.
- **`isCurrent()` — no caller anywhere.** The epoch fence the header calls "what makes a stale holder
  harmless — an action captured before a handoff cannot be replayed into the session afterwards" is
  never consulted, so stale actions are not in fact fenced.
- **`.transitions` — no caller anywhere.** The journal described as "the §3.6-d audit of control itself"
  is written and never read, so control transfers never reach any evidence file.
- **`cede()` / `reclaim()` — called only from `tests/gate.test.ts`.** No production path escalates, and
  `src/operator/main.ts` does not exist.

**The second enforcement point does not exist.** `lease.ts` claims to be "one of two independent
enforcement points. The other lives in the mock itself, which refuses mutating requests while a human
holds the session." The mock has no notion of a holder, a human or a session; it never returns 403 or
409; its only non-200 is the 404 fallthrough. The two `actor` references in `mock/` are the audit row's
type and the audit table's column header — both belonging to the audit trail that is never written. With
no mutating route, there is nothing for a second enforcement point to enforce.

This is the same defect class as the mock's audit-trail claim: a header asserting a mechanism the code
does not implement. Both are now corrected in the record rather than in prose.

The honest reading: control is **enforced**, and everything that makes a handoff a *flow* — raising it,
timing it out, fencing stale actions, recording who did what — is not built. §3.6 is the fourth-heaviest
criterion, so this is the next build rather than a cut.
→ *Escalation & handoff*, *Safety*, *Architecture*

## Four safety and evidence defects, each fixed and then attacked

Found by writing the checkers rather than by reading the code, and each fix was handed to a separate
reviewer told to refute it by REPRODUCING the defect, not by reading the diff. All four survived.

1. **Redaction was declared but not implemented.** `SerializeOptions.redact` defaulted to identity and
   no call site overrode it; `LogEvent.redacted` had no producer. Evidence was clean only because no run
   had yet reached MBR0400, the one screen that renders an SSN. `src/safety/redact.ts` now owns the
   policy and the DEFAULT is safe, because the defect was a hook nobody called rather than a missing
   regex. The boundary is deliberate: SSN, PAN and credentials are masked; member id, name, balances and
   card last-4 are not, because redacting the member id would break discovery and masking a PAN whole
   would leave `msc.card.set_status` unable to say which of two cards it froze — safety that breaks the
   thing it protects.
2. **A `business_outcome` replay emitted no `outcome_signal`.** Two exits constructed the same outcome
   and the postcondition-settle one — the path the only replayable capability actually takes — forgot
   the citation. Fixed structurally: one helper, so there is no second exit to forget.
3. **A replay rejected by input validation wrote no log at all** — precisely the error-state run §6 asks
   for. Fixed at the source, not the sink: the writer still refuses to emit an empty file or invent a
   `why`, because a writer that fabricates a citation is worse than a missing one.
4. **The PII refinement's `\b\d{13,19}\b` matched provider tool-call ids.** Replaced with a guarded
   form. Corrected in the write-up: those 24 hits were measured over transcripts, which this refinement
   never sees, so the misfire was **latent** at the schema boundary. The real gain is that three
   detectors now share one shape.

**The reviewers found two holes the authors had understated**, both silent-failure class:
`readFileSync(".env")` resolved against the process CWD, so live-key masking lapsed for any process not
launched from the repo root; and the `artifact_step` citation did not resolve for a caller-invented
argument (`--input ssn=…` emitted `contract.inputs.ssn`, a pointer into a file that has no such clause) —
the one thing that arm promises it never is.

**A disputed claim, settled by measurement.** Two reviewers flagged the Luhn note as inherited rather
than measured, and suspected it false. Only this session could read `evidence/runs`, so it was measured
there: 7 distinct 13-19 digit runs, 5 Luhn-invalid and **2 Luhn-VALID**, against four seeded PANs that
are all Luhn-invalid. The claim holds, and a Luhn gate really would suppress every genuine leak while
keeping a false positive. Recorded with the numbers rather than left as an assertion.

**Replay evidence is now committed**, all three result classes — success, business outcome, and a
bad-input failure that finally leaves a readable log. `verify-evidence` went from exit 1 to **exit 0**
across 5 runs and 19 files (6 and 23 as of 2026-09-13).

Still open, recorded rather than quietly carried: `events.jsonl` is not redacted and `LogEvent.redacted`
still has no producer (`replay/predicate.ts` renders a read value into `observed`, so a capability that
read an SSN field would log it — unreachable on today's corpus); `redactDeep` masks a credential-named
key only when the value is a string, and PIN/CVV are absent from the field list; and the replay CLI
writes no evidence at all if `replay()` itself throws, which needs a vocabulary decision first — an
unexpected exception is not a citation of anything.

> **Re-measured 2026-09-13, and the boundary has moved by exactly one file.** `handoff.jsonl` IS now
> redacted on the way out (`EvidenceWriter.handoff` maps `redactDeep` over every record), and the
> discovery writer redacts the trace and the transcript. `events.jsonl` is **still not redacted**:
> `EvidenceWriter.event` writes `JSON.stringify(e)` straight through. So the gap named above is still
> open, is still the one boundary where a value read off a screen could reach disk unmasked, and is
> reported as such in README and REPORT rather than being quietly dropped from the list.

> **That re-measurement was wrong, and this is the correction — 2026-09-13, adversarial verification.**
> `EvidenceWriter.event` does NOT write `JSON.stringify(e)` straight through: it computes
> `JSON.stringify(redactDeep(e))`, writes that, and stamps `redacted: true` only when masking changed the
> line (`src/evidence/log.ts`). Measured by calling the real writer with `"CARD NO 4111111111114021 SSN
> 900-55-0101"` in an event's `observed` field: the appended line reads `************4021` and
> `***-**-0101` with `redacted: true`. `src/safety/redact.ts`'s own call-site list already named
> `events.jsonl`, so the source and this log disagreed and the log was the stale half. README and REPORT
> asserted the gap in four places and have been corrected to the narrower one that is genuinely open: the
> SSN rule matches only the hyphenated shape, and a credential-named key is masked only when its value is
> a string. `LogEvent.redacted` also has a producer now — the line above.
→ *Safety*, *Evidence*, *Determinism & error handling*

## §3.6 built: raise, cede, the same live session, hand back, resume

The four mechanisms that were declared and dead now have production callers, which was the whole
acceptance criterion — a handoff build that left its own machinery uncalled would have reproduced the
exact defect it existed to fix. Measured on the settled tree: `expire()` 0 -> 4, `isCurrent()` 0 -> 1,
`.transitions` 0 -> 5, and `cede`/`reclaim` from test-only to 3/2.

**Two independent enforcement points, and the false claim is gone.** `lease.ts` used to assert a second
point living "in the mock itself, which refuses mutating requests while a human holds the session" — 
measurably untrue. The real second point is now the DRIVER's own `humanTurn` flag: `act()` refuses while
it is set, `humanAction()` refuses while it is not, and it shares no state with the lease, so a bug in
one cannot produce a double-actor write. Armed BEFORE the banner is painted, because a banner that fails
to render must still leave a locked session.

**Same session, proven three mechanical ways** rather than asserted, because a handoff that quietly
opens a second browser renders identical screens and every naive assertion still passes: automation
types the member id and the human — who never types it — presses submit, so the results carry that
member (a fresh session would have returned MSG 0071, and it is the APPLICATION reporting this, not the
test); context and page counts are unchanged across the turn; and reads stay live mid-turn while
automation is locked out. The scripted operator drives the REAL driver — only who supplies the input is
simulated, because a stand-in returning a canned outcome would prove nothing about control transfer.

**Determinism is preserved by keeping the escalation path unreachable from the corpus**, not by special
casing: the shipped policy carries `screenRules: []`, so the three scenarios `verify-determinism` ran at
the time — four since `card-freeze` was added — 
cannot reach the raise site, and the demo escalates through a policy FILE instead. All five gates stayed
green: 163 tests across 21 files.

Two bugs found by running it, both of which passed review by being hidden:
- `awaitHandback` armed its resolver AFTER an `await`, so anything signalling on the very next line was
  told nothing was waiting. It passed in the hand-back case only because a human action and a poll
  happened to sit between the two — the same bug, green by timing. A dropped hand-back is
  indistinguishable from a button that does not work.
- `launch()` used `waitUntil: "domcontentloaded"` against a FRAMESET. Measured: three frames already
  exist at that moment but none has committed — every one reports an empty `name()` and a blank url — so
  a target hop naming `content`, even with a url pattern as fallback, matched nothing. Every other suite
  hid it by calling `observe()` first, whose aria snapshot awaits long enough. `load` is a condition, not
  a sleep, so the no-timers rule still holds.

**A contract drifted because nothing declared it.** The console and the orchestrator each defined their
own `InterventionRequest`, and the console's comment promised adoption would be "a one-line import swap
and no field moves" — wrong on both counts. Nothing caught it until a third file assigned one to the
other. The orchestrator's type wins on merit (it derives `requestedAt`/`deadlineAt` from the control
journal, so a deadline shown to an operator cannot disagree with the audit of control), and the console
now declares `implements EscalationTransport` so the next drift fails in the owning file.

What still needs a person, and is therefore not asserted anywhere: that the banner RENDERS legibly and
that a finger on HAND BACK feels right. That is exactly the operator-UI half §3.6 permits to be mocked;
everything underneath it is tested headlessly in CI.
→ *Escalation & handoff*, *Safety*, *Determinism & error handling*

## The offline path's honesty check could never pass

`CassetteProvider` exists so §6's "run without live services" is real: it replays a recorded run's
assistant turns while the actual loop drives the actual browser, so only the model is substituted. Its
own header calls the divergence check "the thing that keeps it honest" — if the surface has changed, the
cassette must fail loudly rather than replay a conversation that no longer describes reality.

**That check had never once run against a real recording, and could not have passed if it had.** A
recorded transcript IS the pruned history: the loop collapses every tool result but the newest into
`(${tool} ok) ${summary}`, which is what keeps a 30-turn run near 136K input tokens instead of 686K. The
extractor only understood the full `SCREEN:` rendering and otherwise fell back to a 40-character slice,
so it compared a summary string against an extracted screen id and always disagreed. Measured: replaying
the committed `discovery-lookup-v3` transcript failed at turn 1 with
`(type_text ok) MEMBER_SEARCH — 4 control(s)` against `MEMBER_SEARCH` — a divergence reported on a run
that had not diverged at all.

**The fixtures are why it looked healthy.** `tests/cassette.test.ts` used the full rendering on both
sides — the one shape a real run never records. Five green tests over a check that could not work.

Fixed by widening what the extractor can READ, never what the guard will ACCEPT, and both halves are now
pinned: one test replays the pruned form, and one proves a genuinely different screen is still refused.
With that, the committed transcript replays end to end with no key — `goal_reached`, 0 completion tokens,
a valid compiled artifact — which is what makes `npm run demo:offline` a real demonstration rather than a
claim.

The general lesson, and the reason this is in the log rather than just in a commit: **a test fixture that
cannot occur in production tests nothing.** The shape a system actually produces is the shape its checks
have to be fed.
→ *Determinism & error handling*, *Evidence*, *Architecture*

## The demo, and one blocked event loop that looked like six broken features

`scripts/demo.ts` was the last missing link in `npm run verify`, and it runs the whole slice in one
command: discovery, the artifact compiled from its trace, that artifact replayed with no model, and then
the three result classes shown distinct. `npm run demo:offline` does all of it with **no key and no
model**, by replaying a committed transcript through the cassette — so a reviewer with nothing
configured still exercises the real loop, the real browser, the real compiler and the real replay
engine. Only the model is substituted, and the cassette refuses to keep going if the recorded screens
stop matching what the surface produces.

It hosts the mock IN-PROCESS on an ephemeral port, so it can never collide with a server the reviewer
already has running. That choice caused the one bug worth recording: the first version drove the CLIs
with `spawnSync`, which **blocks the Node event loop**, so the in-process mock could not answer the very
children navigating to it. Every subprocess died with `page.goto: Timeout 30000ms exceeded` and the demo
reported six failed checks — a uniform failure that reads as six broken features and is really one
blocked loop. `scripts/verify-determinism.ts` may use `spawnSync` safely precisely because its mock is a
separate process on :7101; this one is not. Worth stating because the symptom points everywhere except
at the cause.

**The demo deliberately replays two different artifacts, and says so on screen.** The discovered one goes
first, because that round trip is the headline claim. It cannot demonstrate the three result classes:
the mechanical compiler records the literal the model typed and declares no inputs, since deciding which
literals are really parameters is a separate judgement pass that is not built. So the three-class
demonstration uses the committed `lookup@1.0.0` fixture, which declares a typed `member_id`. Quietly
swapping artifacts there would have overclaimed exactly the capability that is missing.
→ *Architecture*, *Determinism & error handling*, *Cuts*

## How the mutating flow was verified, after the review that never ran

Worth recording because it changes what the green ticks above are worth. The build was orchestrated as
parallel agents, and the adversarial pass over the card capability and the gates **was interrupted before
it produced anything** — its transcript ends `[Request interrupted by user]` and it never resumed. The
component that touched a GATE (`scripts/verify-determinism.ts`) and added two capability fixtures is
therefore the one component whose independent review is missing from that process.

So it was verified by hand instead, and the checks are recorded here rather than assumed:

- **The gate's own diff was read before trusting its green.** It changed from hardcoding
  `http://localhost:7101/` to spawning its own mock from the working tree on an ephemeral port. That is
  strictly tighter, and it fixes a real hole: after any change to `mock/`, the old version reported green
  against whatever stale process happened to still be listening on that port — a determinism check whose
  greenness meant less the more the code moved. The same trap was walked into by hand ten minutes
  earlier, which is how it was noticed.
- **Both fixtures were parsed through the real schema**, not eyeballed. `set_status@1.0.0` is
  `reversible` with a `confirm_intent` commit step; `report_lost@1.0.0` is `irreversible` with
  `human_step_up`; both declare **zero** secret inputs, which is what makes "it cannot carry the override"
  structural rather than conventional.
- **The new tests were sabotage-tested for vacuity**, because a test suite that cannot fail is worse than
  none. Deleting `card.status = wanted` — so the app reports APPLIED, issues a confirmation and writes an
  audit row while nothing actually changes, the exact phantom success this system exists to catch — turns
  2 tests red. Suppressing the audit append turns 4 red. `mock/actions.ts` was restored byte-identically
  after each, sha-verified.
- **Redaction was measured end to end for the first time.** Until CRD0500 existed no screen rendered a
  card number, so the §3.4 claim had never been exercised. The leak was first proven REACHABLE — the live
  screen serves `4111111111114021` unmasked, as a real servicing screen would — and only then proven
  masked: a real card replay's evidence contains zero occurrences of that PAN or of the seeded SSN.
  Proving the leak reachable first is what stops a clean scan from being a vacuous one.

The general point, and the reason this is in the log: **a green gate inherits the credibility of whoever
checked it.** Three of four components here were reviewed by an independent adversary; the fourth was
reviewed by the same session that commissioned it, which is weaker, and saying so is cheaper than having
a reviewer discover it.
→ *Determinism & error handling*, *Safety*, *Evidence*

## Cuts so far

A fourth result state; a generic idempotency subsystem; dry-run/shadow mode; the `viewport_box`
strategy; per-action actor headers; a second classification system alongside `DataClass`; a global
egress guard; Playwright tracing in committed evidence; and all scaling infrastructure — containers,
VNC, co-browsing, queues, operator routing. §7 says none of it is rewarded.
→ *Cuts*

## The app can change something, and three exits were only correct because it could not

Every application route was a pure read. That single fact was quietly load-bearing in more places than
anyone had counted, and removing it is one change rather than three because §3.4's risky-action
separation, §3.6's escalation and the flagship capability were all blocked behind it.

**One mutating transaction, and GET is refused for it.** `POST /screen/card-action` is the only route
that changes anything; `GET` on the same path answers **405**, not a state change. That is deliberate: a
mutating effect must not be reachable by a URL alone, or a URL copied out of an evidence log could
re-trigger it. It also retires the old claim that the mock's only non-200 is the 404 fallthrough.

**The audit trail is an INDEPENDENT record, and one rule keeps it deterministic: only mutating attempts
append, never reads.** Replay's traffic is navigation-only today, but `settle()` polls on a wall clock
and can re-observe, so a read-logging audit would make the app's state a function of machine speed —
and the determinism check compares exactly that. DENIED rows are written too: without them "nothing
happened" and "we refused you" are indistinguishable in the independent record, and a refusal is a pure
function of state and inputs, so it is perfectly deterministic. The value of independence is that
neither record is derived from the other — the automation's `events.jsonl` says what the run did, the
app says what was done to it, so agreement is evidence and disagreement is a defect.

**`srv.seq` was deleted rather than repurposed.** Its comment said "audit ordering only", but it
incremented on *every* request — including the determinism checker's own two `/__admin/state` probes and
every extra `observe()`-driven navigation — so anything derived from it diverges between two identical
runs *by construction*. Ordering comes from the audit array's own index instead. Nothing read it.

**Three measurements that changed the design, each of which cost a rewrite:**

- **Strategy keys cannot be parameterised.** `substitute()` applies to `step.value` only; a target's
  `strategies[].key` is a plain string the binding resolves. So a capability cannot select a row "by the
  card number the caller passed" — the flow has to *type* the discriminator into a field instead.
- **There is no `selectOption` verb.** `SurfaceAction` is a closed set — navigate, click, fill, press,
  and the two dialog verbs. Widening it to drive a `<select>` would mean a new verb in the schema, the
  gate's policy vocabulary and every adapter, so the card screen uses text fields the existing `fill`
  already drives. The closed set did its job: it made the cost of a new primitive visible.
- **`wait_and_retry` and `reload_screen` perform no action.** The executor merely re-enters the step
  loop, and `observe()` issues no HTTP request, so a full-screen interstitial is never re-fetched and
  the retries burn in milliseconds against a screen that cannot change. **A screen-shaped interstitial
  is therefore unrecoverable by this engine.** The frozen plan's SYS0800 broadcast *screen* became a
  broadcast **dialog**, which is a recoverable condition the engine can actually act on via the
  `dismiss_dialog` already in the shipped `allowedActions`.

**Risk is declared per step, not per input value — which forces two artifacts.** FREEZE and UNFREEZE are
reversible; LOST_STOLEN is not. One artifact cannot hold both, because `steps[].risk` is static and
refinement 7 makes the contract equal the maximum over its steps. So `msc.card.set_status@1.0.0` is
reversible and runs unattended, and `msc.card.report_lost@1.0.0` is irreversible and escalates. The
split is a feature: refinement 1 forbids a `secret` input, so `report_lost` is *structurally* unable to
carry the supervisor override the app demands, and a person is required by the shape of the artifact
rather than by a policy file.

**And three exits in `runSteps` were lying by accident.** The run-budget timeout, the capability
checkpoint and the two non-resolving ends of a human turn all reported `retry_safe` / `none`. Each was
true only because no route could mutate. The checkpoint was the worst: it never consulted risk at all,
so a capability that genuinely froze a card and then missed its confirmation invited the caller to
double-commit — the §3.3 conflation the result contract exists to prevent, pointed at the caller instead
of at the app. They now key on a run-scoped `committed` flag, set only *after* `surface.act` returns
(an action the gate refused never ran) and on a human turn over a mutating step; the handoff exits also
key on whether the surface **moved**, which is the only measurement available when automation cannot
watch a person's hands. ABORT keeps `do_not_retry` — the operator said stop — but can no longer claim
nothing changed. `tests/side-effect.test.ts` proves all three **both ways**, because a rule that fires
on everything is as broken as one that fires on nothing.

**What is still NOT built, and must not be implied:** app-side session-aware refusal. The mock has a
mutating route for such a point to protect, but no notion of a session or a holder. It records the
AUTHORITY a request carried — a row is `HUMAN` iff a supervisor override was supplied — which is an
assumption about the deployment, not an enforcement. `src/control/lease.ts` once claimed the mock
"refuses mutating requests while a human holds the session"; that was measurably false, was removed, and
is not being written back.

**Correction, same day: it was three exits fixed and nine, not three, that were wrong.** An adversarial
pass over `runSteps` censused *every* `fail()` exit against the new flag. Six more still answered
`sideEffectRisk: "none"` — the precondition hard failure, the unresolvable target, the read that yields
nothing, the no-operator-channel return, the policy denial, and the non-human arm of the recoverable
postcondition. The last of those was computing `mustReconcile` on one line and using it in only one arm
of the very next ternary. The read exit is the one that matters most, because it is the shape the
flagship actually has: `msc.card.set_status@1.0.0` ends `s07` click (reversible — the submit that freezes
the card) then `s08` read (the confirmation number). Each of those five steps commits nothing *itself*,
which is exactly why each looked defensible in isolation — but "may I retry?" is a question about the
RUN, and a per-step answer to it is the same §3.3 conflation one level up. All six now key on the
run-scoped flag; it is strictly one-directional, so it can only upgrade `retry_safe` to
`reconcile_required`, never the reverse. The lesson worth keeping: a flag introduced to fix three named
sites needs a census of every site that could have used it, or the fix is only as wide as the brief.
→ *Determinism & error handling*, *Safety*, *Escalation & handoff*, *Cuts*

## The verification pass: what the checkers were not checking (2026-09-13)

An adversarial review found this repo's besetting sin to be **comments asserting guarantees the code does
not implement**. The checkers turned out to be the worst instance, because a checker that overstates is
the one defect that hides all the others.

**`verify-no-llm` was blind to dynamic imports, and its self-test could not reveal it.** The single regex
`/(?:from|import)\s*["']([^"']+)["']/` requires a quote immediately after `import`, so the parenthesis in
`await import("@anthropic-ai/sdk")` defeated it, and a specifier held in a variable was invisible.
Measured: a reviewer planted both forms in the replay path and the gate printed "self-test passed" and
"OK — 21 modules reachable … none of them a model", exit 0. The self-test planted a STATIC import — the
one form the walker already understood — so it was structurally incapable of exposing the hole. This is
the sole structural enforcement of the claim README and REPORT both sell. It now reads three forms and
REFUSES a non-literal specifier rather than skipping it, and the self-test plants all three. Proven by
sabotage: deleting the dynamic-import read makes the self-test fail naming only that plant, exit 1.

**`verify-evidence`'s per-check proof was cross-satisfied.** Its expected-offence needles were plain
substrings, so `"missing required field"` was answered equally by the manifest loop, the event loop, the
why-arm loop and the handoff loop — a reviewer deleted the ENTIRE manifest required-fields loop and still
got "23 planted defect classes, all caught", exit 0. (DECISIONS already recorded this as "overstated by
2x"; the script header and README were the stale half and are now reconciled.) Every offence now carries
a prefix naming the record it came from and every needle includes that prefix. Re-run the same sabotage:
exit 1, naming exactly one check. A second sabotage on a different check names exactly that one.
31 planted classes now, and three checks that were never planted at all — event required fields, event
time order, and the closed-record rule — are planted too.

**Three further holes in the same script, each a silent-failure shape.** The manifest was the one record
exempt from the unknown-key rule the script argues for elsewhere, while every committed manifest already
carried an undeclared `capability` key: it is now a closed record declaring `capability` and
`artifactContentHash` (the latter declared before it has a writer, because declaring a name that never
appears costs nothing and leaving it undeclared would make its arrival an offence). The live-key detector
returns nothing when `.env` is absent — i.e. in every clone — while the summary still read "no secrets or
PII found"; the script now says INACTIVE in its own output. And the PII ground-truth floor counted PANs
and SSNs in one total, so a reseed touching only the SSN rendering would keep the floor satisfied while
that class of ground truth vanished; the floor is per class now, which is what the header always claimed.

**`npm run verify` did not run any of the self-tests.** Six scripts were chained and `--self-test` was
passed to none, while README placed the self-test sentence directly under the verify table. The three
`verify:*` scripts now carry it, which costs nothing measurable — the determinism self-test plants its
divergences into the corpus that run already produced.

**The fault catalogue was the most reviewer-visible falsehood in the repo, and triplication was the
defect.** `scripts/fault.ts`, `README.md` and `mock/seed.ts` each carried their own copy of what
`broadcast` does and all three promised "success — the declared dismiss_dialog rule clears the alert and
the run continues", while the engine returned `postcondition_failed` with `recoveries: []` — something
`tests/card.integration.test.ts` had already recorded in a comment as unreachable. Fixed by removing the
copies rather than updating them: `mock/seed.ts` now describes only what the APP does (a mock fixture has
no business asserting engine behaviour), README points at `--list`, and `scripts/fault.ts` is the single
source — made SELF-CHECKING, so `--run <name>` arms the fault, replays, and compares the result AND the
app's own audit trail against what it declares, exiting non-zero on any mismatch and naming the mechanism
the expectation rested on.

Measured with that, against a mock on a high port, evidence into `mktemp -d`:

- `abend_after_commit` — **PASS**: `failed / postcondition_failed`, `reconcile_required`, `unknown`, and
  one APPLIED row in the app's trail. The dangerous direction, behaving as designed.
- `confirm_submit` — **PASS**, against an expectation rewritten twice in one day as the engine moved
  under it. It returns `failed / undeclared_dialog`, `reconcile_required`, `unknown`, audit EMPTY. Earlier
  the same morning it did not: `replay()` threw `locator.click: Timeout 30000ms exceeded.` and the CLI
  exited 1 having written no run directory, so `undeclared_dialog` was a FailureKind nothing could
  produce. `reconcile_required` beside an empty trail is deliberate — the engine issued a click at a step
  that can commit and cannot see that the dialog cancelled it, so it refuses to promise nothing happened.
- `broadcast` — **MISMATCH, deliberately left as one, and the headline finding is only HALF closed.**
  Measured four times across this pass, in order: `failed / postcondition_failed` with `recoveries: []`
  (the original defect); no return within 420s once the recovery loop had landed but the driver still
  blocked; one clean **success** with one APPLIED row; then no return within 240s and again within 420s,
  the last on a freshly started mock with nothing else running. The engine half is genuinely fixed —
  `applyRecovery` is one helper called at all three observation points, precondition, postcondition and
  the capability checkpoint. The driver half is not: a queued native dialog can still block a
  page-touching call. **One pass in four is not a working mechanism**, so the expectation stays declared
  as `success` and the command stays red.

  The method matters more than the result here. This expectation was written as a deliberate mismatch,
  turned green on one re-measurement, and was then proven intermittent by re-running it instead of
  stopping at the answer that was convenient. Three prose copies of this claim had been asserting the
  PASS for days while the engine returned the opposite; a single self-checking copy caught the real state
  in an afternoon — including the part that a single green run would have hidden.

**A measured trap worth recording, because the symptom points at the wrong thing.** `fault.ts` first used
`fetch` for its admin calls and failed with a bare "fetch failed" on the `/__admin/state` call made right
after the replay subprocess returned — which reads as a stopped server. `spawnSync` blocks this process's
event loop for the whole replay, so it cannot notice the mock closing an idle keep-alive connection and
the next call reuses a dead socket. `verify-determinism` hit the identical thing as `read ECONNRESET` and
solved it with `agent: false`; this now does the same rather than retrying past it.

**Two numbers in this log were wrong and are corrected above:** the determinism self-test plants three
divergences, not eleven (two must be rejected, one must be IGNORED — that third is what proves the
projection is not dropping everything inconvenient), and the corpus compares 25 event lines against a
floor of 4, not "zero margin".

**Decisions taken in this pass, recorded because they are trade-offs rather than fixes:**

1. **`rowCount.grid` is exempt from the schema's symbol rule.** Every other symbol named in a predicate
   atom must be declared in `plan.targets`; `grid` may not be. The evaluator ignores it and counts rows
   page-wide, so enforcing it would reject artifacts over a field that changes no behaviour — and would
   reject four frozen files, the committed `lookup@1.0.0` fixture and three committed evidence
   `capability.json`s, all of which cite a `RESULTS_GRID` that is declared nowhere. Those are graded
   evidence. Exempting the field and saying so beats enforcing a rule the corpus cannot satisfy, and the
   evaluator now says in its own `observed` string that the count was page-wide.
2. **A verification stamp may claim success without a timestamp.** `replayedAt` is optional beside
   `replayResult: "success"`, but a capability claiming success MUST record `modelCalls`. The asymmetry
   is deliberate: the call count is the claim that matters and is checkable against the manifest, whereas
   a timestamp nobody verifies is another hardcoded provenance field — the failure mode this log already
   names as worse than an absent one. Nothing yet writes `"success"`, which stays an open gap rather than
   a field that pretends.

   > **Corrected 2026-09-13, adversarial verification.** The last sentence was already false when it was
   > written: `src/replay/main.ts` defines `stampVerification()` and calls it at the point it writes the
   > artifact (`evidence.artifact(stampVerification(capability, result))`), so a successful replay stamps
   > `replayResult: "success"` and `modelCalls: 0` into the `capability.json` that run emits. The stamp has
   > a producer; only the committed evidence, which predates it, still reads `not_yet_verified`. The rest
   > of the decision — `replayedAt` omitted, `modelCalls` required beside a success claim — stands.
3. **The compiler refuses to compile a step whose risk it cannot establish**, instead of stamping
   `read_only` on everything. `read_only` is the least conservative label in the enum, and a discovery run
   that clicked a committing submit used to compile to it — so a failed replay answered `retry_safe` on a
   card it had already actioned. A compile that stops is recoverable; an artifact that lies about its risk
   is not.
→ *Safety*, *Evidence*, *Determinism & error handling*, *Artifact schema*, *Cuts*

## The unsupervised pass: a targeting bug a live run caught, and one promise still half made (2026-09-13)

Run without anyone watching, on a standing instruction to fix, test, review and document. Recorded in
detail because a pass nobody observed is the one that most needs a written trail.

**A live discovery run caught a targeting bug no test in this repo could have.** `factsOf` decides what
names a control. It took the text of the cell to the control's left — right for a label/field grid, wrong
for this one. The results grid renders `… | OPEN | <a>SELECT</a>`, so the rule anchored the member-detail
link on `OPEN`: not a label, but the STATUS column's **data**. A capability minted from that run would
have targeted the link by a word that changes when the member's status changes — the worst failure mode
this system has, because it is silent and it replays green until the day the data differs. Fixed at
`src/surface/playwright.ts:601-619` by separating a control that names itself (an `a` or `button` with its
own short text) from one named by its neighbouring cell. Written as plain `const`s rather than a helper,
deliberately: this function's source is serialised into the page, where esbuild's keep-names transform
rewrites a named nested function to reference `__name` — which does not exist in that context. That is the
identical mechanism that broke the handoff banner, and it would have thrown the identical swallowed
`ReferenceError`.

The lesson is about coverage, not about grids. Every test here drives the same seeded mock, where `OPEN` is
the status of the member the fixtures look up. The bug needed a *live* run to surface because only a live
run had a reason to mint a fresh target rather than replay a frozen one.

**A command now exists for a remedy three error messages name — and they still do not name it.**
`mechanical.ts` refuses a compile three ways, and each refusal tells the operator to "add it and re-compile
from trace.jsonl". Measured: `compileMechanical` had exactly one caller, no npm script matched `compile`,
and `discover` took no `--from-trace` flag, so the remedy named in every refusal could not be run.
`scripts/recompile.ts` closes that — it re-runs the same compilation from a run's own `trace.jsonl`, with
no model involved, validates through `safeParseCapability` before writing, and reads provenance from the
run's manifest rather than stamping today's clock. It matters beyond convenience: a discovery run costs a
model call and several minutes, a binding gap costs one line, and without this a refused compile threw away
the run instead of the line.

Half closed, and the open half was found by checking my own claim rather than by any test. The three
refusals at `risk-profile.ts:81`, `mechanical.ts:95` and `mechanical.ts:341` still say "re-compile from
trace.jsonl" without naming `npm run recompile`, and the string `recompile` appears in no markdown file in
this repo. An operator who hits a refusal now learns *what* to do and not *how* — a thinner version of the
defect the script was written to remove. Two further gaps, stated rather than fixed: it is the only script
with no test, and `tests/compile-mechanical.test.ts:167` pins the `RiskNotEstablished` class but not the
message, so the wording is unprotected.

**And a correction to my own description of it.** I stated this script's exit contract three times as
"2 called wrong, 3 compiler refused, 0 wrote the artifact". It has four exits — `1` is *compiled but failed
schema validation* (`scripts/recompile.ts:115`), which was in none of those descriptions. Nothing shipped
is false, because no document in the repo states the contract at all; the falsehood was only ever in my own
account of the work, and it was one edit away from being written into this log as established fact. Worth
recording precisely because it is the failure this repo keeps having, arriving by its least visible route:
not a stale comment, but a confident summary of code that nobody re-read.

**One run closed the last evidence gap in both §3.5 and §3.6.** `evidence/runs/escalation-timeout` replays
`report_lost@1.0.0`, whose committing step is `irreversible`; the shipped policy rates irreversible
`confirm`, so the gate refuses it to a person, and with nobody at the console the turn expires. It is the
only committed run that is a *failure* carrying `handoff.jsonl`, `disposition: "timeout"`, a closing
`controlOwner: "automation"`, and the `operator` and `policy` why-arms.

> **Corrected within hours of being written.** The sentence above first said `controlAtExit: "automation"`.
> That field is real, but it lives on the `ResultEnvelope` printed to stdout and appears in **zero** files
> under `/evidence/` — I took it from README's description of the run rather than from the run. Two
> reviewers found it independently. The equivalent fact that *is* on disk is the closing `controlOwner`. It is also where §3.5's "richer
signal on failure" lives, as a **text** snapshot rather than an image: the handoff record carries the
redacted `observedText` of the screen the run stopped on. That is a choice, not a shortfall —
`verify-evidence` holds a run directory to a closed set of filenames, and `screenshot.png` is excluded from
that set on purpose so the checker's own self-test can plant the name and prove the unrecognised-file rule
fires. The brief allows a screenshot, a DOM snapshot or a trace; this is the second.

**Two entries in this log were corrected in place, in opposite directions.** The handoff-banner correction
had itself gone stale: it closed with "re-measured at the close of this pass: still unfixed", which was
false by the time anyone read it — the banner renders, measured through the public `Surface` API against a
live mock. And the control-lease entry still listed enforcement as "due in M4" months after
`assertAutomation`, the epoch fence and the driver's independent flag all shipped. Both now carry dated
second corrections rather than rewritten history.

**Final state over the settled tree**, measured in one battery: `tsc --noEmit` clean; **321 tests across 26
files**, all passing; `verify-no-llm`, `verify-evidence` and `verify-determinism` all green *including*
their own `--self-test` passes, which plant defects and assert each is caught; `demo:offline` OK on 8
checks; and the chained `npm run verify` exit 0. The secrets check was re-run against the public repo: the
49-character key in `.env` appears in **zero** tracked files, **zero** untracked-but-committable files, and
**zero** commits in the history.

One thing this pass has not yet done, and the reason it is not claimed above: the six-area adversarial
review of the settled tree was still running when this entry was written. Its findings are not in this log.
→ *Artifact schema*, *Heterogeneity & multi-tenant*, *Evidence*, *Escalation & handoff*, *Safety*, *Cuts*

## Six adversarial reviews, and the fix that broke the flagship flow (2026-09-13)

Six reviewers were run over the settled tree, one per area — schema and contract, replay, discovery and
compile, safety and control, surface and mock, docs and evidence — each told to read every line in its
area, to verify before reporting, and to say what it checked that was FINE. They were read-only and knew
nothing of each other. Where two of them measured the same defect independently, that is recorded below,
because independent agreement is the only cheap substitute for a second pair of eyes.

**The headline finding was a defect nobody had written down, and two reviewers found it separately with
near-identical probes.** `plan.recovery`'s two non-acting verbs did not merely fail to work — they made
runs WORSE. `settle()` returns the instant any raced expectation holds, and `expectationsFor` raced every
recovery rule, including the ones the engine answers by doing nothing. So `wait_and_retry`, declared
against a transient load, ENDED the wait the moment the load appeared. Measured, same plan, same surface,
load clearing after 1200ms: **~1229ms and completed with no rule declared; ~1ms and `postcondition_failed`
with `wait_and_retry` x3 declared.** Declaring §3.3-f's own named example of a recoverable condition was
strictly worse than declaring nothing. Fixed by racing only the verbs that act — a dialog BLOCKS the page,
so noticing it promptly is the point, while a wait needs more time, not less — and `classify` already
evaluates every rule independently, so nothing was lost by leaving them out of the race. Pinned now by
`tests/recovery-wait.test.ts`, which proves both directions and the bounded-failure case.

**A fix I made earlier the same night broke the flagship mutating flow, and only a live review caught
it.** The `factsOf` anchor rule had been changed so a link names itself, fixing the results grid where
`… | OPEN | <a>SELECT</a>` had anchored the detail link on the STATUS column's DATA. On the member-detail
screen the row is `<td>CARD SERVICES</td><td><a>OPEN</a></td>` — the link's own text is a bare verb and
the tenant's label is the cell to its left. So the new rule minted `table_anchor("OPEN")`, the compiler
refused it, and a real discovery run of the card capability would have died at compile AFTER the model
call was paid for.

Three things about that are worth keeping:

1. **Both readings of the rule were shipped, and each was wrong on one screen.** The rows are nearly
   identical HTML. The discriminator that resolves them is ROW WIDTH, and it is not a heuristic about two
   screens: it tracks which cell carries the TENANT-BOUND LABEL, the only thing a binding can name. A
   two-cell row is the legacy label/value pair (`labels.CARD_SERVICES_LINK` on the left); a wider row is a
   data grid whose header is the fixed literal `ACTION` while the tenant's label rides on the control
   (`labels.OPEN_MEMBER`).
2. **All 321 tests stayed green through the break.** Nothing mints against the detail screen and the
   committed discovery evidence stops at the results grid, so the suite could not see it. That is a
   coverage hole, not bad luck, and `tests/anchor-naming.test.ts` now pins the rule on BOTH screens at once
   so neither reading can be restored without the other failing.
3. **The fix was verified by measurement and the previous one was too.** Being measured is not the same as
   being right; a measurement only covers the case it was taken on.

**What else the reviews confirmed and what was done.** Four findings were verified against the code before
being acted on, because this repo has twice been damaged by "correcting" a true statement into a false one:

- `controlAtExit` is named by README, REPORT and this log as carried by the escalation run, and appears in
  **zero** files under `/evidence/` — it is a stdout-only envelope field. All three now name the closing
  `controlOwner`, which is genuinely on disk. I had propagated that error into this log hours earlier by
  reading the README instead of the run.
- REPORT contradicted itself nineteen lines apart: one paragraph said the committed handoff run closes the
  §3.6 gap, and the roadmap below still listed "a committed handoff run" as future work. I nearly dismissed
  this as a paraphrase because my `grep` missed the sentence — it wraps across a line break. The reviewer
  was right and my tooling was wrong.
- The `--self-test` claim in README was too strong. The self-tests prove the checks they PLANT; around ten
  live checks in `verify-evidence` have no plant, including the transcript cross-examination of
  `model.calls` — it runs only on a discovery run while the planted run is a replay, so deleting it
  outright leaves the self-test green. README now says exactly that.
- `.env.example` shipped a `MODEL_PROVIDER` variable nothing reads, advertising `anthropic` as a value.
  There is no anthropic adapter and Anthropic's API is not OpenAI-compatible, so setting it would have
  changed nothing except a reader's belief while the key still went to `MODEL_BASE_URL`. Removed.

Also fixed: the PII refinement skipped any string beginning with `{{`, so `"{{member_id}} 4111111111111111"`
parsed clean while the same literal one character later was rejected — an exemption that could never
prevent a false positive and did nothing but open a one-character bypass. An `enum` input could omit
`enumValues` and accept anything, which is what `report_lost`'s "the enum is the guard" safety claim rested
on; enum and `enumValues` now imply each other in both directions. `parseBinding` — the checked parse that
forbids two symbols sharing a literal — had zero production callers and now backs all three. The
`endHumanTurn` return leg sat outside the guarded region, so an operator pressing HAND BACK on a torn-down
context stranded the lease on `human` with no matching return; it now restores and journals like the
arming leg, which the surrounding comment had claimed all along.

**Deliberately not fixed tonight, and this list is the point of writing any of this down.** Each is real,
each is measured by a reviewer, and each was judged too large or too risky for an unsupervised pass:

- **The discovery loop's dead-end detector counts reads and fills**, which do not change the screen digest,
  so four extractions from one screen abort the run as "the application is not responding" — a false
  statement, and §3.2 requires typed extracted data. The shipped card flow survives by one step.
- **A model turn carrying two tool calls orphans the second**, producing a wire-invalid next request that
  an OpenAI-compatible endpoint rejects with a 400, which the adapter does not retry. `loop.ts` documents
  the exact invariant it breaks.
- **The cassette pairs assistant turns to tool results positionally**, so a recorded turn with no tool call
  skews every later comparison and raises a FALSE divergence, accusing the app of drift it does not have.
  The committed transcripts happen to be clean, so `demo:offline` is unaffected today.

> **All three FIXED, 2026-09-13, and the list above is left standing because the paragraph introducing it
> sells it as a complete and honest inventory — deleting entries would quietly rewrite what was claimed.**
> Each was investigated and then adversarially re-checked by a second reviewer, and every one of the three
> verdicts came back "apply with changes" rather than "apply as proposed", which is the argument for the
> second pass.
>
> **The dead-end detector** now feeds from `MOVES_SCREEN` (`click`, `dialog`) rather than from the outcome
> kind. Measured both ways: five reads on one unchanged screen stopped at `no_progress` with
> `surface.act()` called ZERO times while the verdict said "the model is acting"; after the fix the same
> script completes with all five values captured. What it gives up, stated because the reviewer caught the
> original write-up softening it: a model looping only reads or fills now runs to the 40-step ceiling
> instead of stopping at four — roughly ten times the turns, still bounded by `maxSteps`, `maxSeconds` and
> `maxTokens`.
>
> **The orphaned tool call** is fixed in the ADAPTER, not the loop, and the reason is the interesting part.
> The proposed fix — answer the extra calls with synthetic "NOT RUN" tool results — is wire-valid, and it
> would have re-broken the cassette fixed in the same pass: it puts two tool turns under one assistant
> turn, and the cassette pairs one to one. Measured: `cassette diverged at turn 1: the recorded run saw
> "NOT RUN: you called more than one tool i…"`. Two fixes that each work alone and break together.
> `reconcileToolCalls` drops declared-but-unanswered calls on the way out instead, so the history, the
> transcript and the cassette keep exactly the shape they had; the loop separately records the dropped
> calls in `errors` and a `model.extra_tool_calls` event, so nothing disappears in silence.
>
> **The cassette skew** is now structural: one ordered walk pairing each assistant turn with the turn that
> follows it, only when that turn is a `tool` turn. No comparison coverage is lost — every recorded result
> is still compared exactly once — and the earlier draft's hedge that drift would be "noticed one turn
> later" was wrong and is not repeated.
>
> Eight regression tests across three files, because each of these survived a full green suite: the shapes
> that trigger them appear in no fixture. `npm run verify` green end to end — 335 tests across 29 files.
>
> (That sentence said "five" when first written, which was wrong — 327 → 332 added two cassette tests and
> three progress tests, then 335 added three adapter tests. A miscount in the banner announcing these fixes,
> which is the defect class the banner is about. Counted, not recalled, this time.)
- **`recompile` refuses on both committed traces** — they predate the literals-not-symbols fix. The command
  works on a fresh trace; README now says so rather than leaving a reviewer to discover it.
- **A targetless `read` step is silently skipped and counted complete**, and an `assert` step emits no
  event at all, so a "successful" run can produce an empty `events.jsonl` that this repo's own evidence
  gate rejects.
- **The masked screenshot cannot mask the thing that matters.** `nameMayContainPii` is `false` in all 40
  occurrences and `true` in none; and were it true it would not help, because the flag describes a SCREEN
  while the capture consumes it as a list of ELEMENTS, and the PAN renders in a grid cell no target
  resolves to. REPORT now states both limits instead of calling it repaired.
- **`humanAction()` bypasses the policy gate entirely**, and read paths are ungated, so the "one action's
  worth of exposure" bound does not hold for a trailing read.
- **`describe()` and `launch()` are unbounded against a queued dialog** — measured at 30s timeouts, 3/3
  deterministic. This is the mechanism behind `--run broadcast` being intermittent.
- **`session_expired`, `outcome_unknown` and `SideEffectRisk: "committed"` have no producers**, in the file
  that documents deleting `ControlOwner: "released"` for that exact reason. Marked rather than removed:
  deleting a union member changes exhaustiveness checking across the executor and the evidence gate, and
  that is a considered change, not a 4am one.
- **REPORT is ~3,600 words against a brief asking 1–3 pages.** A decision was already taken to leave it at
  ~2,000; it has since grown by two thirds, so the earlier decision no longer covers it. Flagged rather
  than reversed unilaterally.
**Measured at the close of the pass, over the tree as committed.** `npm run verify` exit 0 end to end:
`tsc --noEmit` clean; **327 tests across 28 files** (321 and 26 before this pass — `recovery-wait` and
`anchor-naming` are the two new files, and both exist because a defect reached production through a gap
they now close); `verify-no-llm` catching all three planted import forms; `verify-evidence` catching all
31 planted defect classes and reporting 6 runs / 23 files with no seeded PII literal and no leak shape;
`verify-determinism` rejecting both planted divergences and correctly ignoring the volatile-only one; and
`demo:offline` passing its 9 checks. The two schema refinements added here rejected nothing that already
exists, which is the house rule for telling a tightened rule from a broken one.
→ *Determinism & error handling*, *Heterogeneity & multi-tenant*, *Safety*, *Escalation & handoff*, *Evidence*, *Cuts*

## Three findings that lived only in REPORT (2026-09-13)

Written down because REPORT is being cut to the length the brief asks for, and a check of what the cut
would destroy found three passages this log had never recorded. Two of them are corrections made LAST
NIGHT, put into the reviewer-facing document and not into the log that exists to hold exactly this. A
decision log you only write to when you remember is a decision log with holes in it, and the holes are
invisible until something forces an inventory.

**1. `Output.type` had no consumer, and fixing it changed a returned value's JSON type.** The executor
wrote the raw string it read off the screen, while the result contract's own docstring claimed the values
were "already validated against its schema" — so a declared type was decoration. A declared output is now
coerced where it is captured: an `integer` returns a JSON **number** or fails as a typed
`contract_violation`; a `boolean` returns `true`/`false` from the spellings a green-screen actually renders;
a `string` is unchanged. This is a BREAKING change for a caller, stated plainly because it is the sort that
otherwise surfaces as a type error in someone else's code: an agent binding an `integer` output used to
receive digits as a string and now receives a number.

**2. The evidence-on-failure gap was recorded as the wrong half, and the true half is worse.** REPORT
listed "the replay CLI writing no evidence if `replay()` itself throws" as a known gap. That is false:
`replay()` is called INSIDE the guarded region, so the `finally` runs, events have already streamed through
the sink, and `capability.json` plus a `manifest.json` carrying `result: "aborted"` are written. The real
gap is adjacent and was undocumented — `PlaywrightSurface.launch` and `OperatorConsole.start` sit OUTSIDE
that region, while the run directory is created before them. So a failure to launch leaves a directory with
no manifest, which this project's own `verify:evidence` rejects as an incomplete run. `replay/main.ts`
carries a banner reading "EVIDENCE IS WRITTEN WHATEVER HAPPENED", and it is false in exactly the one case
the README had failed to name. Found by a reviewer, not by us.

**0. Escalation used to be flattened into `policy_denied`, and this log never recorded it.** Found the same
way as the three below — by checking, before cutting REPORT, what the cut would destroy. Repeated greps
here for `flatten`, `policy_denied`, `requires: human` and `escalation instead` return nothing, so REPORT
was the only record. The defect: when the policy rated an action as needing a person, the gate answered the
same way it answers a forbidden action, so a caller could not tell **"a human must approve this"** from
**"this is never permitted, do not retry"** — two facts that call for opposite responses, collapsed into
one. The gate now returns `requires: "human"` and the executor routes it to escalation rather than to a
failure. Worth keeping because it is the same defect class as conflating a business outcome with a crash,
one level up: a result union that cannot express a distinction the caller has to act on.

**3. Static-text reads: the conclusion was right and the stated reason was wrong.** REPORT said discovery
"has no tool that mints such a target". It has one — `discover/executor.ts` mints from `describe(ref)` and
proves the target by calling `surface.read()`, which has a static-text fallback for exactly this shape.
What actually blocks it sits one layer earlier, in what the model is shown: `surface/serialize.ts` emits a
ref only for ACTIONABLE roles, so a static-text node never reaches the model as something it could name.
The distinction matters for anyone planning the work — the fix is three lines in the serializer's role
list, not a new tool — and a correct conclusion resting on a wrong reason is the same defect class as a
false claim, just harder to catch, because nobody re-checks a sentence they already agree with.
→ *Artifact schema*, *Determinism & error handling*, *Evidence*, *Cuts*
