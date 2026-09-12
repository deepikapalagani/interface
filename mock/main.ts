/**
 * THE MOCK SERVER — the target application.
 *
 * Three properties matter more than features:
 *
 *  1. DETERMINISM. All state is in memory from `freshState()`, and the clock is
 *     FROZEN. Rendered output is therefore byte-identical across runs, which is
 *     what lets "replay is deterministic" be checked by diffing rather than
 *     asserted.
 *
 *  2. NO RANDOMNESS ANYWHERE. Every condition is a pure function of (seed,
 *     armed faults, session state). Probabilistic faults are refused on
 *     principle: a lucky replay must never be able to pass.
 *
 *  3. AN AUDIT TRAIL OF ITS OWN. The app records what was done to it, so the
 *     automation's evidence can be reconciled against an independent record —
 *     which is how a phantom success gets caught.
 */
import http from "node:http";
import { tenantByKey, type TenantConfig } from "./tenant.js";
import { freshState, nextConfirmation, type MockState } from "./seed.js";
import * as screens from "./screens.js";

/**
 * The clock is FROZEN, not ticking.
 *
 * It first advanced one second per request, which made every rendered timestamp
 * depend on how many requests had happened before it — so a single extra
 * observe(), or one retry, shifted the clock on every later screen and produced
 * spurious byte differences between two otherwise identical runs. Measured
 * 2026-09-12. The plan called for a per-request tick; this deviates from it
 * deliberately, because a frozen clock is both simpler and strictly more
 * deterministic. Ordering is carried by the audit sequence number, which is what
 * actually needs to be monotonic.
 */
const VIRTUAL_NOW = "2026-03-02T14:05:00Z";
const CLOCK = VIRTUAL_NOW.slice(11, 19);

interface Server {
  readonly tenant: TenantConfig;
  state: MockState;
  /** Monotonic request counter. Used for audit ordering only — never rendered. */
  seq: number;
}

const html = (res: http.ServerResponse, body: string, status = 200): void => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
};

const json = (res: http.ServerResponse, body: unknown, status = 200): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body, null, 1));
};

export const createServer = (tenant: TenantConfig): http.Server => {
  const srv: Server = { tenant, state: freshState(), seq: 0 };
  const t = tenant;

  return http.createServer((req, res) => {
    srv.seq += 1;
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    // ---- admin plane. The allowlist denies these routes to the automation,
    //      which is what stops a capability from arming its own faults.
    if (path === "/__admin/reset" && req.method === "POST") {
      srv.state = freshState();
      srv.seq = 0;
      return json(res, { reset: true, tenant: t.id });
    }
    if (path === "/__admin/state") {
      return json(res, {
        tenant: t.id,
        confirmationSeq: srv.state.confirmationSeq,
        audit: srv.state.audit,
        members: Object.keys(srv.state.members),
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

    return html(res, screens.notFound(t, CLOCK), 404);
  });
};

/** Exported for tests, which drive confirmations without going through the UI. */
export const issueConfirmation = (state: MockState): string => nextConfirmation(state);

/* ------------------------------------------------------------------ cli */

const isMain = process.argv[1]?.endsWith("main.ts") ?? false;
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
  });
}
