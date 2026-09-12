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

One correction from the measurement: the banner's target frame must be chosen **from Node** by
frame name or URL. At `addInitScript` time a frameset's column sizing is not yet applied, so a
width guard inside the page misfires.

Still owed: lease **enforcement** — that automation is *prevented* from acting mid-handoff — is a
separate mechanism, automatable headlessly, due in M4.
→ *Escalation & handoff*

## Dangerous artifacts are unrepresentable

Eight Zod refinements, each with a rejection test pinned to its own message: no `secret` input, no
PII-shaped literal in place of a `{{param}}`, no acting step without a postcondition, no retry
recovery alongside an irreversible step, no output without exactly one producing step, no persisted
snapshot ref as a durable target, no contract understating its own risk, no step targeting an
undeclared symbol.

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

**`verify-evidence` exits 1 today, correctly**, on a real gap: no replay evidence is committed, so §6's
"logs from a replay run" is unsupported by any file. The rule was deliberately not weakened to "if a
replay run exists", which would make it vacuous.

> **Superseded later the same day.** Replay evidence for all three result classes is now committed and
> this checker exits 0 across 5 runs and 19 files. The gap it named was real, and refusing to weaken the
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
across 5 runs and 19 files.

Still open, recorded rather than quietly carried: `events.jsonl` is not redacted and `LogEvent.redacted`
still has no producer (`replay/predicate.ts` renders a read value into `observed`, so a capability that
read an SSN field would log it — unreachable on today's corpus); `redactDeep` masks a credential-named
key only when the value is a string, and PIN/CVV are absent from the field list; and the replay CLI
writes no evidence at all if `replay()` itself throws, which needs a vocabulary decision first — an
unexpected exception is not a citation of anything.
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
casing: the shipped policy carries `screenRules: []`, so the three scenarios `verify-determinism` runs
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

## Cuts so far

A fourth result state; a generic idempotency subsystem; dry-run/shadow mode; the `viewport_box`
strategy; per-action actor headers; a second classification system alongside `DataClass`; a global
egress guard; Playwright tracing in committed evidence; and all scaling infrastructure — containers,
VNC, co-browsing, queues, operator routing. §7 says none of it is rewarded.
→ *Cuts*
