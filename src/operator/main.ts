/**
 * THE OPERATOR CONSOLE — mocked UI, real control transfer.
 *
 * §3.6 says in as many words that the operator UI MAY BE MOCKED, and that the
 * handoff mechanism and the control-transfer model MUST BE REAL. This file sits
 * exactly on that line, so it is worth being precise about which half is which.
 *
 * MOCKED: everything you can see. One HTML page, no framework, no build step,
 * inline CSS, a meta refresh instead of a socket. No authentication, no operator
 * directory, no queue, no assignment. A real console would be a product.
 *
 * REAL: everything the buttons do. HAND BACK and ABORT resolve the very promise
 * the run is blocked on, through `HandbackChannel` — the same door the in-page
 * banner button uses, so the two cannot deliver different answers. There is no
 * canned outcome anywhere in this file: the console cannot invent a resolution,
 * it can only deliver the one a person chose into the session that is genuinely
 * waiting on it.
 *
 * ── THE SCREENSHOT IS SERVED FROM MEMORY, ON PURPOSE ────────────────────────
 *
 * §3.4-e forbids persisting raw sensitive data, and a servicing screenshot is the
 * densest PII this system ever holds — `PlaywrightSurface.screenshot` masks it at
 * CAPTURE time because a captured PNG of MBR0400 already contains the SSN. Having
 * masked it, writing it to a temp file to serve it would put it back on disk
 * outside `/evidence/`, where nothing declared it and nobody reviews it. So the
 * bytes stay in this process and are served from a route that forgets them when
 * the turn ends.
 *
 * ── WHY THE REQUEST TYPE IS DECLARED HERE ───────────────────────────────────
 *
 * `src/control/escalation.ts` is another component's file and did not exist when
 * this was written, so `InterventionRequest` below is declared locally and is
 * STRUCTURAL: it names exactly the four things §3.6-b requires an intervention
 * request to carry — goal/capability, current step, current state or screenshot,
 * and why it stopped. When the owning component lands its own definition, the
 * adoption is a one-line import swap and no field moves. That is stated plainly
 * rather than hidden behind a re-export, because a fake seam is worse than a
 * visible one.
 *
 * CONSTRAINT THIS FILE LIVES UNDER: it is reachable from `src/replay/main.ts`,
 * which `scripts/verify-no-llm.ts` walks. It may not import `src/model/`,
 * `src/discover/` or `src/compile/`, and the walker is a raw substring scan, so
 * the name of the raw model log may not appear here even inside a comment.
 */
import http from "node:http";
import type { EscalationTransport, HandoffOutcome, InterventionRequest } from "../control/escalation.js";
import { redactText } from "../safety/redact.js";
import type { HandbackChannel, HandbackSignal, LiveSession } from "../surface/session.js";

/**
 * The request type is `src/control/escalation.ts`'s, not a local copy.
 *
 * This file originally declared its own structural `InterventionRequest` because
 * the orchestrator did not exist yet, with a note promising the adoption would be
 * "a one-line import swap and no field moves". That was wrong, and the compiler
 * said so: the shapes genuinely differed — `goal` nested under `capability`,
 * `observedText` rather than `screenText`, a screenshot carrying its mask count
 * alongside its bytes, plus `requestedAt`/`deadlineAt`/`effectiveRisk`/`action`
 * that only the orchestrator can supply.
 *
 * The orchestrator wins on the merits rather than by seniority: it derives
 * `requestedAt` and `deadlineAt` from the control journal's own cede entry, so a
 * deadline shown to an operator cannot disagree with the audit of control.
 */
type ConsoleChannel = HandbackChannel & Pick<LiveSession, "awaitHandback">;

/**
 * Two vocabularies, deliberately kept separate and mapped here.
 *
 * `HandbackSignal` is what the DRIVER saw; `HandoffOutcome` is what the RUN must
 * decide from, and it maps one-to-one onto three distinct `FailureKind`s. The
 * mapping is total and lives at the seam so neither side has to know the other's
 * spelling.
 */
const toOutcome = (signal: HandbackSignal): HandoffOutcome => {
  if (signal.kind === "timed_out") return { kind: "timeout" };
  const note = signal.note;
  return {
    kind: signal.kind === "aborted" ? "abort" : "resolved",
    operator: signal.operator,
    ...(note === undefined ? {} : { note }),
  };
};

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Two buttons and a body of context. Deliberately one function and no templating engine. */
const render = (request: InterventionRequest | null, hasShot: boolean, attached: boolean): string => {
  if (request === null) {
    return `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="2">
<title>OPERATOR CONSOLE — IDLE</title>
<body style="font:13px/1.5 Arial,Helvetica,sans-serif;background:#f4f4f4;margin:0;padding:24px">
<div style="max-width:820px;margin:0 auto;background:#fff;border:1px solid #ccc;padding:20px">
<h1 style="font-size:15px;margin:0 0 8px">OPERATOR CONSOLE</h1>
<p style="color:#555">No intervention is currently open. This page refreshes every 2 seconds.</p>
${attached ? "" : `<p style="color:#7E1416"><b>NO LIVE RUN ATTACHED.</b> The console was started on its own, so the buttons have no session to resolve. Start a run with <code>npm run replay -- --operator</code> to attach one.</p>`}
</div></body>`;
  }

  // §3.4-e: the live screen text is whatever the app rendered, which on a member
  // detail screen is an unmasked SSN. It is redacted on the way to the browser —
  // the console is a fourth boundary, and the operator does not need the digits
  // to decide whether to press a button.
  const safeText = redactText(request.observedText);

  return `<!doctype html><meta charset="utf-8">
<title>INTERVENTION — ${esc(request.stepRef)}</title>
<body style="font:13px/1.5 Arial,Helvetica,sans-serif;background:#f4f4f4;margin:0;padding:24px">
<div style="max-width:900px;margin:0 auto;background:#fff;border:1px solid #ccc">

<div style="background:#7E1416;color:#fff;padding:10px 16px;font-weight:bold">
  AUTOMATION IS PAUSED — A HUMAN HOLDS THIS SESSION
</div>

<div style="padding:16px">
  <table style="border-collapse:collapse;width:100%;font-size:13px">
    <tr><td style="padding:3px 10px 3px 0;color:#555;width:120px">GOAL</td><td>${esc(request.capability.goal)}</td></tr>
    <tr><td style="padding:3px 10px 3px 0;color:#555">CAPABILITY</td><td><code>${esc(request.capability.id)}@${esc(request.capability.version)}</code></td></tr>
    <tr><td style="padding:3px 10px 3px 0;color:#555">RUN</td><td><code>${esc(request.runId)}</code></td></tr>
    <tr><td style="padding:3px 10px 3px 0;color:#555">STEP</td><td><b>${esc(request.stepRef)}</b> — ${esc(request.stepTitle)}</td></tr>
    <tr><td style="padding:3px 10px 3px 0;color:#555">SCREEN</td><td>${esc(request.screen ?? "(unrecognised)")} &nbsp; <span style="color:#777">${esc(request.location)}</span></td></tr>
  </table>

  <div style="margin:14px 0;padding:10px;background:#fdf3f3;border-left:4px solid #7E1416">
    <b>WHY IT STOPPED</b><br>${esc(request.reason)}<br>
    <span style="color:#777">rule <code>${esc(request.ruleId)}</code></span>
  </div>

  <p style="margin:14px 0 4px;color:#555"><b>WHAT TO DO</b></p>
  <p style="margin:0 0 14px">Perform step ${esc(request.stepRef)} in the browser window that is already open — it is
  the same live session, with the run's own form state intact. Then press HAND BACK and the run resumes
  from this step's checkpoint. Press ABORT if the step should not be performed at all.</p>

  ${hasShot ? `<p style="margin:14px 0 4px;color:#555"><b>LIVE SCREEN</b> (masked at capture)</p>
  <img src="/screenshot.png" alt="masked screenshot of the live session" style="max-width:100%;border:1px solid #ccc">` : ""}

  <p style="margin:14px 0 4px;color:#555"><b>LIVE SCREEN TEXT</b> (redacted)</p>
  <pre style="background:#f7f7f7;border:1px solid #ddd;padding:10px;max-height:260px;overflow:auto;white-space:pre-wrap">${esc(safeText)}</pre>

  <form method="post" action="/handback" style="display:inline">
    <input type="hidden" name="operator" value="console">
    <button style="font:bold 13px Arial;padding:8px 22px;background:#1d6b2f;color:#fff;border:0;cursor:pointer">HAND BACK</button>
  </form>
  <form method="post" action="/abort" style="display:inline;margin-left:10px">
    <input type="hidden" name="operator" value="console">
    <button style="font:bold 13px Arial;padding:8px 22px;background:#7E1416;color:#fff;border:0;cursor:pointer">ABORT</button>
  </form>
</div>
</div></body>`;
};

const done = (message: string): string =>
  `<!doctype html><meta charset="utf-8"><title>CONTROL RETURNED</title>
<body style="font:13px/1.5 Arial,Helvetica,sans-serif;background:#f4f4f4;margin:0;padding:24px">
<div style="max-width:820px;margin:0 auto;background:#fff;border:1px solid #ccc;padding:20px">
<h1 style="font-size:15px;margin:0 0 8px">${esc(message)}</h1>
<p style="color:#555">The run has the session again. You can close this tab.</p>
</div></body>`;

export interface ConsoleOptions {
  readonly port: number;
  /**
   * The live session, seen through exactly two methods: one to wait for a turn to
   * end and one to end it. Nothing wider, so the console can conclude a turn and
   * can do nothing else to the session.
   */
  readonly channel: ConsoleChannel | null;
  /** Who is sitting at the console. Recorded on the escalation record. */
  readonly operator?: string;
}

/**
 * The console, as an object a run can hand an intervention to.
 *
 * It holds no driver and no Playwright type — only a `HandbackChannel`, which is
 * one method wide. That is deliberate: the console can end a turn and can do
 * nothing else to the session, so a bug here cannot drive the app.
 */
export class OperatorConsole implements EscalationTransport {
  private request: InterventionRequest | null = null;
  private lastOutcome: string | null = null;

  private constructor(
    private readonly server: http.Server,
    private readonly opts: ConsoleOptions,
    readonly port: number,
  ) {}

  static async start(opts: ConsoleOptions): Promise<OperatorConsole> {
    let consoleRef: OperatorConsole | null = null;

    const server = http.createServer((req, res) => {
      const self = consoleRef;
      if (!self) {
        res.writeHead(503).end("starting");
        return;
      }
      self.handle(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(opts.port, () => resolve());
    });

    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : opts.port;
    consoleRef = new OperatorConsole(server, opts, port);
    return consoleRef;
  }

  get url(): string {
    return `http://localhost:${this.port}/`;
  }

  /** Put an intervention on the screen. Does not block. */
  present(request: InterventionRequest): void {
    this.request = request;
    this.lastOutcome = null;
  }

  /** Take it off the screen once the turn is over. */
  clear(outcome: string): void {
    this.request = null;
    this.lastOutcome = outcome;
  }

  /**
   * THE ESCALATION, from the run's point of view — `EscalationTransport.raise`.
   *
   * The promise awaited here is THE LIVE SESSION's, obtained from the channel;
   * this console never constructs one of its own. That is the design's single
   * most important line: a console free to resolve its own promise could answer
   * without the session agreeing, which is exactly the canned outcome §3.6 must
   * not have. All it can do is put the request on screen and report the answer a
   * person gave.
   *
   * The deadline comes from `request.deadlineAt`, which the orchestrator derived
   * from the control journal — so the console's wait and the run's TTL are the
   * same instant by construction rather than two clocks that might disagree.
   */
  async raise(request: InterventionRequest): Promise<HandoffOutcome> {
    const channel = this.opts.channel;
    if (channel === null) {
      // Reported as a timeout rather than thrown: nobody was reachable, which is
      // an escalation that nobody answered, not broken plumbing.
      return { kind: "timeout" };
    }

    this.present(request);
    try {
      const remaining = Date.parse(request.deadlineAt) - Date.now();
      const signal = await channel.awaitHandback({ timeoutMs: Math.max(0, remaining) });
      this.clear(signal.kind);
      return toOutcome(signal);
    } catch (e) {
      this.clear("error");
      throw e;
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (url.pathname === "/screenshot.png") {
      const shot = this.request?.screenshot;
      if (!shot) {
        res.writeHead(404).end();
        return;
      }
      // Served from memory and never written to disk: see the header. The mask
      // count travels with the bytes so a reviewer can tell a masked capture from
      // one that simply had nothing to mask.
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
      res.end(Buffer.from(shot.bytes));
      return;
    }

    if (req.method === "POST" && (url.pathname === "/handback" || url.pathname === "/abort")) {
      const aborted = url.pathname === "/abort";
      const operator = this.opts.operator ?? "console";
      const signal: HandbackSignal = aborted
        ? { kind: "aborted", operator, note: "operator pressed ABORT" }
        : { kind: "handed_back", operator, note: "operator pressed HAND BACK" };

      // The one thing this console does to the world. `false` means no turn was
      // waiting — reported rather than swallowed, so a button that did nothing
      // does not look like a button that worked.
      const delivered = this.opts.channel?.signalHandback(signal) ?? false;

      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        done(
          delivered
            ? aborted
              ? "ABORTED — the run was told to stop."
              : "HANDED BACK — the run has resumed."
            : "NOTHING WAS WAITING — no live turn is open, so this button resolved nothing.",
        ),
      );
      return;
    }

    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    if (this.request === null && this.lastOutcome !== null) {
      res.end(done(`TURN ENDED — ${this.lastOutcome}`));
      return;
    }
    res.end(render(this.request, this.request?.screenshot !== undefined, this.opts.channel !== null));
  }
}

/* ------------------------------------------------------------------ cli */

/**
 * `npm run operator` — the console on its own, with no run attached.
 *
 * Useful for looking at the page and for checking the port is free before a demo.
 * It says loudly that nothing is attached, because a console whose buttons
 * silently resolve nothing is exactly the sort of mock that gets mistaken for a
 * mechanism.
 */
const isMain = process.argv[1]?.endsWith("operator/main.ts") ?? false;
if (isMain) {
  const i = process.argv.indexOf("--port");
  const port = Number(i >= 0 ? (process.argv[i + 1] ?? "7900") : "7900");

  OperatorConsole.start({ port, channel: null })
    .then((c) => {
      console.log(`operator console on ${c.url}`);
      console.log("  NO LIVE RUN ATTACHED — start one with:");
      console.log("  npm run replay -- --headed --operator --policy tests/fixtures/policy-escalate.json --evidence <dir>");
    })
    .catch((e: unknown) => {
      console.error(`operator: could not start on :${port} — ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
