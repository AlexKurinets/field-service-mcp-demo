import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { SEED_TENANTS, seedTenant, isoDay, type TenantData } from "./seed.js";

// A small stand-in for a ServiceTitan-style REST API: client-credentials OAuth, tenant in the URL
// path, separate read and write scopes, per-tenant rate limits, and idempotency keys on writes.
// It holds fake data only and is not affiliated with ServiceTitan.

export const MOCK_APP_KEY = "ak1.demo-field-service-app";

export interface IssuedClient { clientId: string; clientSecret: string; stTenantId: number; scope: "read" | "write" }

export interface WriteRecord { stTenantId: number; path: string; body: unknown; idempotencyKey: string }

export interface MockApiStats {
  requests: number;
  tokenRequests: number;
  rateLimited: number;
  writes: WriteRecord[];
}

export interface MockApi {
  url: string;
  stats: MockApiStats;
  clients: Record<string, { read: IssuedClient; write: IssuedClient }>;
  data: Map<number, TenantData>;
  revokeAllTokens(): void;
  close(): Promise<void>;
}

export interface MockApiOptions { port?: number; tokenTtlSec?: number; rateLimitPerSec?: number }

export async function startMockApi(opts: MockApiOptions = {}): Promise<MockApi> {
  const tokenTtlSec = opts.tokenTtlSec ?? 900;
  const rateLimit = opts.rateLimitPerSec ?? 50;
  const stats: MockApiStats = { requests: 0, tokenRequests: 0, rateLimited: 0, writes: [] };
  const data = new Map<number, TenantData>();
  const clients: MockApi["clients"] = {};
  const clientIndex = new Map<string, IssuedClient>();
  const tokens = new Map<string, { stTenantId: number; scope: "read" | "write"; exp: number }>();
  const windows = new Map<number, { second: number; count: number }>();
  const idempotent = new Map<string, unknown>();
  const notes: Array<{ id: string; jobId: number; text: string }> = [];

  for (const t of SEED_TENANTS) {
    data.set(t.stTenantId, seedTenant(t.tenant, t.base));
    const issue = (scope: "read" | "write"): IssuedClient => {
      const c = { clientId: `cid.${scope}.${t.stTenantId}.${randomBytes(4).toString("hex")}`, clientSecret: randomBytes(24).toString("hex"), stTenantId: t.stTenantId, scope };
      clientIndex.set(c.clientId, c);
      return c;
    };
    clients[t.tenant] = { read: issue("read"), write: issue("write") };
  }

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };

  const server = http.createServer(async (req, res) => {
    stats.requests++;
    const raw = await readBody(req);
    const url = new URL(req.url ?? "/", "http://mock");

    if (req.method === "POST" && url.pathname === "/connect/token") {
      stats.tokenRequests++;
      const form = new URLSearchParams(raw);
      const c = clientIndex.get(form.get("client_id") ?? "");
      if (form.get("grant_type") !== "client_credentials" || !c || c.clientSecret !== form.get("client_secret")) {
        return send(res, 401, { error: "invalid_client" });
      }
      const token = `st_${randomUUID()}`;
      tokens.set(token, { stTenantId: c.stTenantId, scope: c.scope, exp: Date.now() + tokenTtlSec * 1000 });
      return send(res, 200, { access_token: token, token_type: "Bearer", expires_in: tokenTtlSec });
    }

    const m = url.pathname.match(/^\/(jpm|crm|sales|accounting|dispatch)\/v2\/tenant\/(\d+)(\/.*)$/);
    if (!m) return send(res, 404, { error: "not_found" });
    const [, area, tenantStr, rest] = m;
    const stTenantId = Number(tenantStr);

    if (req.headers["st-app-key"] !== MOCK_APP_KEY) return send(res, 401, { error: "missing_app_key" });
    const tok = tokens.get((req.headers.authorization ?? "").replace(/^Bearer /, ""));
    if (!tok || tok.exp < Date.now()) return send(res, 401, { error: "invalid_token" });
    if (tok.stTenantId !== stTenantId) return send(res, 403, { error: "token_not_valid_for_tenant" });

    const sec = Math.floor(Date.now() / 1000);
    const w = windows.get(stTenantId);
    if (!w || w.second !== sec) windows.set(stTenantId, { second: sec, count: 1 });
    else if (++w.count > rateLimit) {
      stats.rateLimited++;
      return send(res, 429, { error: "rate_limited" }, { "retry-after": "1" });
    }

    const d = data.get(stTenantId);
    if (!d) return send(res, 404, { error: "unknown_tenant" });
    const q = url.searchParams;
    const today = isoDay(0);

    if (req.method === "GET") {
      let mm: RegExpMatchArray | null;
      if (area === "jpm" && rest === "/jobs") {
        const text = q.get("text")?.toLowerCase();
        const rows = d.jobs.filter((j) =>
          (!q.get("status") || j.status === q.get("status")) &&
          (!q.get("customerId") || j.customerId === Number(q.get("customerId"))) &&
          (!text || `${j.type} ${j.summary}`.toLowerCase().includes(text)));
        const size = Math.min(Number(q.get("pageSize") ?? 50), 50);
        return send(res, 200, { data: rows.slice(0, size), hasMore: rows.length > size });
      }
      if (area === "jpm" && (mm = rest.match(/^\/jobs\/(\d+)$/))) {
        const job = d.jobs.find((j) => j.id === Number(mm![1]));
        return job ? send(res, 200, job) : send(res, 404, { error: "not_found" });
      }
      if (area === "crm" && (mm = rest.match(/^\/customers\/(\d+)$/))) {
        const c = d.customers.find((x) => x.id === Number(mm![1]));
        return c ? send(res, 200, c) : send(res, 404, { error: "not_found" });
      }
      if (area === "sales" && rest === "/estimates") {
        const before = q.get("createdBefore");
        const rows = d.estimates.filter((e) => (!q.get("status") || e.status === q.get("status")) && (!before || e.createdOn <= before));
        return send(res, 200, { data: rows, hasMore: false });
      }
      if (area === "accounting" && rest === "/invoices") {
        const minDays = Number(q.get("minDaysOverdue") ?? 0);
        const minBalance = Number(q.get("minBalance") ?? 0);
        const rows = d.invoices.filter((v) => {
          if (q.get("overdueOnly") !== "true") return true;
          const daysOver = Math.floor((Date.parse(today) - Date.parse(v.dueDate)) / 86_400_000);
          return v.balance > 0 && daysOver > 0 && daysOver >= minDays && v.balance >= minBalance;
        });
        return send(res, 200, { data: rows, hasMore: false });
      }
      if (area === "dispatch" && rest === "/appointments") {
        const rows = d.appointments
          .filter((a) => (!q.get("date") || a.start.startsWith(q.get("date")!)) && (!q.get("technicianId") || a.technicianId === Number(q.get("technicianId"))))
          .map((a) => ({ ...a, technicianName: d.technicians.find((t) => t.id === a.technicianId)?.name }));
        return send(res, 200, { data: rows, hasMore: false });
      }
      return send(res, 404, { error: "not_found" });
    }

    if (req.method === "POST") {
      if (tok.scope !== "write") return send(res, 403, { error: "insufficient_scope" });
      const key = req.headers["idempotency-key"];
      if (typeof key !== "string" || !key) return send(res, 400, { error: "idempotency_key_required" });
      const idemKey = `${stTenantId}:${key}`;
      if (idempotent.has(idemKey)) return send(res, 200, idempotent.get(idemKey));
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw || "{}"); } catch { return send(res, 400, { error: "bad_json" }); }

      let mm: RegExpMatchArray | null;
      let result: unknown;
      if (area === "jpm" && (mm = rest.match(/^\/jobs\/(\d+)\/notes$/))) {
        const jobId = Number(mm[1]);
        if (!d.jobs.some((j) => j.id === jobId)) return send(res, 404, { error: "not_found" });
        const note = { id: `note_${randomUUID().slice(0, 8)}`, jobId, text: String(body.text ?? "") };
        notes.push(note);
        result = note;
      } else if (area === "crm" && rest === "/tasks") {
        if (!d.customers.some((c) => c.id === Number(body.customerId))) return send(res, 404, { error: "not_found" });
        result = { id: `task_${randomUUID().slice(0, 8)}`, ...body };
      } else if (area === "accounting" && (mm = rest.match(/^\/invoices\/(\d+)\/reminders$/))) {
        const inv = d.invoices.find((v) => v.id === Number(mm![1]));
        if (!inv) return send(res, 404, { error: "not_found" });
        result = { id: `rem_${randomUUID().slice(0, 8)}`, invoiceId: inv.id, channel: body.channel, queued: true };
      } else {
        return send(res, 404, { error: "not_found" });
      }
      stats.writes.push({ stTenantId, path: url.pathname, body, idempotencyKey: key });
      idempotent.set(idemKey, result);
      return send(res, 201, result);
    }

    return send(res, 405, { error: "method_not_allowed" });
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    stats,
    clients,
    data,
    revokeAllTokens: () => tokens.clear(),
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export function readBody(req: http.IncomingMessage, limit = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
