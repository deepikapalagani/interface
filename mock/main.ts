/**
 * THE MOCK SERVER — the target application.
 *
 * Three properties matter more than features:
 *
 *  1. DETERMINISM. All state is in memory from `freshState()`, and the clock is
 *     FROZEN. Rendered output is therefore byte-identical across runs, which is
 *     what lets "replay is deterministic" be checked by diffing rather than
 *     asserted. Everything that can change — card statuses, the confirmation
 *     counter, the audit trail, the armed fault — is rebuilt by
 *     `POST /__admin/reset`, so two identical `reset -> run` sequences leave the
 *     app in byte-identical states.
 *
 *  2. NO RANDOMNESS ANYWHERE. Every condition is a pure function of (seed, armed
 *     fault, request). A fault must be ARMED EXPLICITLY through the admin plane
 *     and fires on a stated condition, then disarms itself. Probabilistic faults
 *     are refused on principle: a lucky replay must never be able to pass.
 *
 *  3. AN AUDIT TRAIL OF ITS OWN — AND IT IS NOW WRITTEN. Every attempt at the one
 *     mutating transaction appends exactly one row, applied or denied, and
 *     `/screen/audit` renders every field of it.
 *
 *     What it is FOR: the automation's `events.jsonl` says "step s07 acted, then
 *     s08 read CNF4401"; the app's trail says "AUTOMATION applied FREEZE 4021 to
 *     400200101 on CRD0500, confirmation CNF4401, APPLIED". NEITHER IS DERIVED
 *     FROM THE OTHER — one is written by the run, one by the app — so agreement
 *     is evidence and disagreement is a defect. A run claiming success against a
 *     trail with no APPLIED row is a phantom success; an APPLIED row the run
 *     never saw is the dangerous direction, and the reason a replay interrupted
 *     by `abend_after_commit` reports `reconcile_required` rather than guessing.
 *
 *     ONLY MUTATING ATTEMPTS APPEND. Reads never do, and that single rule is what
 *     keeps the trail deterministic: `settle()` polls on a wall clock and can
 *     re-observe, so a read-logging trail would make the app's final state a
 *     function of machine speed.
 *
 * The mock has NO notion of a session or a holder, and nothing here refuses a
 * request because a human holds the session. `src/control/lease.ts` must not
 * claim otherwise.
 */
import http from "node:http";
import { tenantByKey, type TenantConfig } from "./tenant.js";
import { applyCardAction } from "./actions.js";
import { freshState, isFaultName, FAULTS, type MockState } from "./seed.js";
import * as screens from "./screens.js";
import type { CardScreenFaults } from "./screens.js";

/**
 * The clock is FROZEN, not ticking.
 *
 * It first advanced one second per request, which made every rendered timestamp
 * depend on how many requests had happened before it — so a single extra
 * observe(), or one retry, shifted the clock on every later screen and produced
 * spurious byte differences between two otherwise identical runs. Measured
 * 2026-09-12. The plan called for a per-request tick; this deviates from it
 * deliberately, because a frozen clock is both simpler and strictly more
 * deterministic. Ordering is carried by the audit row's own index, which is what
 * actually needs to be monotonic.
 */
const VIRTUAL_NOW = "2026-03-02T14:05:00Z";
const CLOCK = VIRTUAL_NOW.slice(11, 19);

interface Server {
  readonly tenant: TenantConfig;
  state: MockState;
}

const html = (res: http.ServerResponse, body: string, status = 200): void => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
};

const json = (res: http.ServerResponse, body: unknown, status = 200): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 1));
};

/** Bounded: a body that never ends must not be able to hold a socket open forever. */
const MAX_BODY_BYTES = 64 * 1024;

const readBody = (req: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = "";
    let oversize = false;
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
      if (body.length > MAX_BODY_BYTES) {
        oversize = true;
        req.destroy();
      }
    });
    req.on("end", () => (oversize ? reject(new Error("request body too large")) : resolve(body)));
    req.on("error", reject);
  });

/**
 * A one-shot CRD0500 fault, consumed by the render it fires on.
 *
 * Self-disarming is a property of the APP: the second render of this screen is
 * clean, so anything that retries meets a clean screen rather than the same
 * dialog forever. Whether the automation recovers is the engine's business, and
 * `scripts/fault.ts` is where that expectation is stated and checked.
 */
const takeCardScreenFault = (state: MockState): CardScreenFaults => {
  if (state.armedFault === "broadcast") {
    state.armedFault = null;
    return { broadcast: true, confirmSubmit: false };
  }
  if (state.armedFault === "confirm_submit") {
    state.armedFault = null;
    return { broadcast: false, confirmSubmit: true };
  }
  return { broadcast: false, confirmSubmit: false };
};

export const createServer = (tenant: TenantConfig): http.Server => {
  const srv: Server = { tenant, state: freshState() };
  const t = tenant;

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    // ---- admin plane. No capability reaches these routes, but not because of the
    //      allowlist: `deniedRoutes: ["/__admin"]` is matched against the page an
    //      action starts from, not where it lands, so it is a declared intent. What
    //      enforces it is that no SurfaceAction verb can POST to an arbitrary URL
    //      and no screen below renders a control reaching /__admin.
    if (path === "/__admin/reset" && req.method === "POST") {
      srv.state = freshState();
      return json(res, { reset: true, tenant: t.id });
    }

    if (path === "/__admin/fault" && req.method === "POST") {
      const names = FAULTS.map((f) => f.name);
      let requested: unknown;
      try {
        requested = (JSON.parse((await readBody(req)) || "{}") as { fault?: unknown }).fault;
      } catch {
        return json(res, { error: "body must be JSON", faults: names }, 400);
      }
      if (requested === "none") {
        srv.state.armedFault = null;
        return json(res, { armedFault: null, faults: names });
      }
      if (typeof requested !== "string" || !isFaultName(requested)) {
        // Loudly, and naming the legal set: a typo must never look like a
        // successful arming, or a fault demo would silently prove nothing.
        return json(res, { error: `unknown fault ${JSON.stringify(requested)}`, faults: names }, 400);
      }
      srv.state.armedFault = requested;
      return json(res, { armedFault: requested, faults: names });
    }

    if (path === "/__admin/state") {
      // Everything that can CHANGE, and nothing that cannot. Card statuses are
      // here because a status flip was previously invisible to the determinism
      // checker, whose comparison was consequently vacuous. Last four and status
      // only — never a PAN, never an SSN: the admin plane is not covered by the
      // evidence leak scan, so it must not be a place a secret can be picked up.
      return json(res, {
        tenant: t.id,
        confirmationSeq: srv.state.confirmationSeq,
        armedFault: srv.state.armedFault,
        audit: srv.state.audit,
        members: Object.keys(srv.state.members),
        cards: Object.fromEntries(
          Object.entries(srv.state.members).map(([id, m]) => [
            id,
            m.cards.map((c) => ({ last4: c.last4, status: c.status })),
          ]),
        ),
      });
    }

    // ---- the application itself
    if (path === "/") return html(res, screens.frameset(t));
    if (path === "/nav") return html(res, screens.navFrame(t));
    if (path === "/screen/signon") return html(res, screens.signOn(t, CLOCK));
    if (path === "/screen/menu") return html(res, screens.menu(t, CLOCK));
    if (path === "/screen/search") return html(res, screens.search(t, CLOCK));
    if (path === "/screen/audit") return html(res, screens.auditInquiry(t, CLOCK, srv.state));

    if (path === "/screen/results") {
      const field = t.fields["MEMBER_ID"] ?? "MBRNO";
      const id = (url.searchParams.get(field) ?? "").trim();
      const member = id ? srv.state.members[id] : undefined;
      // An unknown id is a legitimate ANSWER, rendered as the app's own message —
      // never an exception. This is the business-outcome path.
      return html(res, screens.results(t, CLOCK, member ? [member] : []));
    }

    if (path === "/screen/detail") {
      const id = (url.searchParams.get("id") ?? "").trim();
      const member = srv.state.members[id];
      if (!member) return html(res, screens.results(t, CLOCK, []));
      return html(res, screens.detail(t, CLOCK, member));
    }

    if (path === "/screen/cards") {
      const id = (url.searchParams.get("id") ?? "").trim();
      const member = srv.state.members[id];
      // Mirrors /screen/detail exactly, so MEMBER_NOT_FOUND is detectable on this
      // path too rather than only on the search path.
      if (!member) return html(res, screens.results(t, CLOCK, []));
      return html(res, screens.cardServices(t, CLOCK, member, null, takeCardScreenFault(srv.state)));
    }

    /**
     * THE ONLY MUTATING APPLICATION ROUTE.
     *
     * POST-only by design: a mutating effect must not be reachable by a URL
     * alone, so a URL copied out of a log can never re-trigger a state change.
     */
    if (path === "/screen/card-action") {
      if (req.method !== "POST") return html(res, screens.methodNotAllowed(t, CLOCK), 405);

      const form = new URLSearchParams(await readBody(req));
      // Fields are read through the tenant map exactly as /screen/results reads
      // MEMBER_ID; only `id` is a literal, as /screen/detail already uses.
      const memberId = (form.get("id") ?? "").trim();
      const last4 = (form.get(t.fields["CARD_SELECT"] ?? "SEL") ?? "").trim();
      const action = (form.get(t.fields["CARD_ACTION"] ?? "CACT") ?? "").trim();
      const override = (form.get(t.fields["OVERRIDE_CODE"] ?? "OVRCD") ?? "").trim();

      const outcome = applyCardAction(srv.state, {
        memberId,
        last4,
        action,
        override,
        at: VIRTUAL_NOW,
        screen: t.screenIds["CARD_SERVICES"] ?? "CRD0500",
      });

      const member = srv.state.members[memberId];
      if (!member) return html(res, screens.results(t, CLOCK, []));

      if (outcome.screen === "CONFIRMATION" && outcome.confirmation !== null && outcome.card !== null) {
        // THE FLAGSHIP FAULT. The change has ALREADY been applied and the APPLIED
        // row has ALREADY been written by the time we get here — that is the
        // whole point. The caller is shown an abend and cannot tell what
        // committed, which is exactly the state `reconcile_required` exists for.
        if (srv.state.armedFault === "abend_after_commit") {
          srv.state.armedFault = null;
          return html(res, screens.abend(t, CLOCK));
        }
        return html(
          res,
          screens.confirmation(t, CLOCK, member, {
            last4: outcome.card.last4,
            action,
            status: outcome.newStatus ?? outcome.card.status,
            confirmation: outcome.confirmation,
          }),
        );
      }

      return html(res, screens.cardServices(t, CLOCK, member, outcome.message, takeCardScreenFault(srv.state)));
    }

    return html(res, screens.notFound(t, CLOCK), 404);
  };

  return http.createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      // A malformed request must not take the server down mid-run, and must not
      // be reported as a rendered screen either — a 400 here is unambiguous.
      if (!res.headersSent) json(res, { error: error instanceof Error ? error.message : String(error) }, 400);
    });
  });
};

/* ------------------------------------------------------------------ cli */

/**
 * `mock/main.ts`, not `main.ts`.
 *
 * The loose form was satisfied by src/replay/main.ts, src/discover/main.ts and
 * src/operator/main.ts alike, so importing `createServer` from any of them bound
 * a second server on :7101 inside that process as a side effect of the import.
 * src/operator/main.ts already uses this tighter form.
 */
const isMain = process.argv[1]?.endsWith("mock/main.ts") ?? false;
if (isMain) {
  const arg = (name: string, fallback: string): string => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
  };
  const tenant = tenantByKey(arg("tenant", "a"));
  const port = Number(arg("port", "7101"));
  createServer(tenant).listen(port, () => {
    console.log(`${tenant.product} (${tenant.institution}) on http://localhost:${port}/`);
    console.log(`  tenant=${tenant.id}  content frame="${tenant.contentFrame}"  member id field="${tenant.fields["MEMBER_ID"]}"`);
    console.log(`  virtual clock FROZEN at ${VIRTUAL_NOW} — rendered output does not depend on request count`);
    console.log(`  faults (armed via npm run mock:fault): ${FAULTS.map((f) => f.name).join(", ")}`);
  });
}
