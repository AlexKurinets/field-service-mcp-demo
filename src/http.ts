import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { openDb } from "./db.js";
import { Vault } from "./vault.js";
import { CredentialBroker } from "./broker.js";
import { MANIFESTS, manifestFor } from "./manifest.js";
import { effectiveTools, mintRunToken, verifyRunToken, type RunClaims } from "./runToken.js";
import { buildReadServer } from "./servers/read.js";
import { buildDraftServer, type DraftSink } from "./servers/drafts.js";
import { StClient, bucketFor } from "./stClient.js";
import { TenantDrafts, loadDraft } from "./drafts.js";
import { DRAFT_ACTIONS } from "./actions.js";
import { payloadHash } from "./canonical.js";
import { approveDraft, consumeApproval, findUsableApproval, GateError, rejectDraft } from "./approvals.js";
import { executeDraft } from "./executor.js";
import { verifySlack, verifyWebhook } from "./webhooks.js";
import { MOCK_APP_KEY, readBody, startMockApi, type MockApi } from "./mockApi.js";

export interface SlackMessage { channel: string; draftId: string; text: string }

export interface GatewayOptions {
  port?: number;
  dbPath: string;
  apiUrl: string;
  signingKey: string;
  vaultKey: string;
  slackSigningSecret: string;
  approvalTtlSec?: number;
  tokenMarginSec?: number;
  rateLimitPerSec?: number;
}

export interface Gateway {
  url: string;
  db: DatabaseSync;
  vault: Vault;
  broker: CredentialBroker;
  apiUrl: string;
  slackOutbox: SlackMessage[];
  close(): Promise<void>;
}

export async function startGateway(o: GatewayOptions): Promise<Gateway> {
  const db = openDb(o.dbPath);
  const vault = new Vault(db, o.vaultKey);
  const broker = new CredentialBroker(vault, o.apiUrl, o.tokenMarginSec ?? 60);
  const rate = o.rateLimitPerSec ?? 10;
  const approvalTtl = o.approvalTtlSec ?? 3600;
  const slackOutbox: SlackMessage[] = [];

  // Stand-in for posting an approve/reject message to the tenant's Slack channel.
  const notify = (tenant: string, draftId: string, action: string, args: Record<string, unknown>) => {
    slackOutbox.push({ channel: manifestFor(tenant).slackChannel, draftId, text: `Approval needed: ${action} ${JSON.stringify(args)}` });
  };

  const sinkFor = (claims: RunClaims): DraftSink => {
    const drafts = new TenantDrafts(db, claims.tenant);
    return {
      create: async (action, args) => {
        const d = drafts.create("executor", action, args, claims.runId);
        notify(claims.tenant, d.id, action, args);
        return { draftId: d.id, payloadHash: d.payloadHash };
      },
    };
  };

  const authRun = async (req: http.IncomingMessage): Promise<RunClaims | null> => {
    const m = (req.headers.authorization ?? "").match(/^Bearer (.+)$/);
    if (!m) return null;
    try {
      return await verifyRunToken(o.signingKey, m[1]);
    } catch {
      return null;
    }
  };

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const p = new URL(req.url ?? "/", "http://gateway").pathname;

    // MCP over Streamable HTTP, stateless: every request is authenticated from its run token and
    // served by a fresh server instance bound to that tenant. There is no session to hijack.
    if (p === "/mcp/read" || p === "/mcp/drafts") {
      if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });
      const claims = await authRun(req);
      if (!claims) return send(res, 401, { error: "invalid_run_token" });
      let body: unknown;
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        return send(res, 400, { error: "bad_json" });
      }
      const tools = effectiveTools(claims);
      const mcp = p === "/mcp/read"
        ? buildReadServer({ api: new StClient(o.apiUrl, broker.tokenSource(claims.tenant, "read"), bucketFor(claims.tenant, rate)), allowedTools: tools })
        : buildDraftServer({ sink: sinkFor(claims), allowedTools: tools });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    // Context for stdio servers, which hold only a run token.
    if (p === "/run/context" && req.method === "GET") {
      const claims = await authRun(req);
      if (!claims) return send(res, 401, { error: "invalid_run_token" });
      return send(res, 200, { tenant: claims.tenant, runId: claims.runId, tools: effectiveTools(claims), apiUrl: o.apiUrl });
    }

    // Read-scoped API token for a stdio read server. Write-scoped tokens are never brokered out.
    if (p === "/broker/token" && req.method === "GET") {
      const claims = await authRun(req);
      if (!claims) return send(res, 401, { error: "invalid_run_token" });
      const tok = await broker.accessToken(claims.tenant, "read");
      return send(res, 200, { accessToken: tok.accessToken, expiresAt: tok.expiresAt, stTenantId: manifestFor(claims.tenant).stTenantId, appKey: MOCK_APP_KEY });
    }

    // Draft creation for stdio draft servers.
    if (p === "/drafts" && req.method === "POST") {
      const claims = await authRun(req);
      if (!claims) return send(res, 401, { error: "invalid_run_token" });
      const { action, args } = JSON.parse(await readBody(req)) as { action: string; args: Record<string, unknown> };
      const def = DRAFT_ACTIONS[action];
      if (!def || !effectiveTools(claims).includes(def.tool)) return send(res, 403, { error: "action_not_allowed" });
      return send(res, 201, await sinkFor(claims).create(action, args ?? {}));
    }

    // PreToolUse hook backend for spend and publish tools: allow only if an unused, unexpired
    // approval exists for this tenant, tool and exact arguments. Otherwise queue it for approval.
    if (p === "/gate/check" && req.method === "POST") {
      const claims = await authRun(req);
      if (!claims) return send(res, 401, { error: "invalid_run_token" });
      const { tool, args } = JSON.parse(await readBody(req)) as { tool: string; args: Record<string, unknown> };
      const hash = payloadHash({ tenant: claims.tenant, action: tool, args: args ?? {} });
      const approval = findUsableApproval(db, claims.tenant, hash);
      if (approval && consumeApproval(db, approval.id)) return send(res, 200, { allow: true, approvalId: approval.id });
      const drafts = new TenantDrafts(db, claims.tenant);
      let d = drafts.findPendingByHash(hash);
      if (!d) {
        d = drafts.create("tool_call", tool, args ?? {}, claims.runId);
        notify(claims.tenant, d.id, tool, args ?? {});
      }
      return send(res, 200, { allow: false, draftId: d.id });
    }

    // Slack interactivity callback for the approve/reject buttons. Signed by Slack.
    if (p === "/slack/interactions" && req.method === "POST") {
      const raw = await readBody(req);
      if (!verifySlack(o.slackSigningSecret, header(req, "x-slack-request-timestamp"), header(req, "x-slack-signature"), raw)) {
        return send(res, 401, { error: "bad_signature" });
      }
      const payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "{}") as {
        user?: { id?: string };
        actions?: Array<{ action_id?: string; value?: string }>;
      };
      const userId = payload.user?.id ?? "";
      const act = payload.actions?.[0];
      try {
        if (act?.action_id === "reject") {
          rejectDraft(db, act.value ?? "", userId);
          return send(res, 200, { ok: true, status: "rejected" });
        }
        if (act?.action_id !== "approve") return send(res, 400, { ok: false, error: "unknown_action" });
        approveDraft(db, act.value ?? "", userId, approvalTtl);
        const draft = loadDraft(db, act.value ?? "");
        if (draft?.kind === "executor") {
          const out = await executeDraft({ db, broker, apiUrl: o.apiUrl }, draft.id);
          return send(res, 200, { ok: true, status: "executed", response: out.response });
        }
        return send(res, 200, { ok: true, status: "approved" });
      } catch (err) {
        if (err instanceof GateError) return send(res, 200, { ok: false, error: err.code });
        throw err;
      }
    }

    // Inbound field-service webhooks, one signing secret per tenant.
    const wh = p.match(/^\/webhooks\/fieldservice\/([\w-]+)$/);
    if (wh && req.method === "POST") {
      const tenant = wh[1];
      if (!MANIFESTS[tenant]) return send(res, 404, { error: "unknown_tenant" });
      const raw = await readBody(req);
      const { secret } = vault.get(tenant, "webhook");
      if (!verifyWebhook(secret, header(req, "x-fs-signature"), raw)) return send(res, 401, { error: "bad_signature" });
      db.prepare("INSERT INTO webhook_events (tenant, received_at, body) VALUES (?, ?, ?)").run(tenant, Date.now(), raw);
      return send(res, 202, { queued: true });
    }

    return send(res, 404, { error: "not_found" });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: "internal_error" });
      else res.end();
    });
  });
  await new Promise<void>((r) => server.listen(o.port ?? 0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    db,
    vault,
    broker,
    apiUrl: o.apiUrl,
    slackOutbox,
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => {
        db.close();
        r();
      });
    }),
  };
}

function header(req: http.IncomingMessage, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

// Loads each tenant's API client credentials and webhook secret into the vault and its approvers
// into the approvers table. In the platform this happens once per tenant at onboarding.
export function bootstrap(gw: Gateway, api: MockApi): { webhookSecrets: Record<string, string> } {
  const webhookSecrets: Record<string, string> = {};
  for (const m of Object.values(MANIFESTS)) {
    const c = api.clients[m.tenant];
    gw.vault.put(m.tenant, "read", c.read.clientId, c.read.clientSecret);
    gw.vault.put(m.tenant, "write", c.write.clientId, c.write.clientSecret);
    webhookSecrets[m.tenant] = randomBytes(24).toString("hex");
    gw.vault.put(m.tenant, "webhook", "webhook", webhookSecrets[m.tenant]);
    for (const u of m.approvers) gw.db.prepare("INSERT OR IGNORE INTO approvers (tenant, user_id) VALUES (?, ?)").run(m.tenant, u);
  }
  return { webhookSecrets };
}

// `npm run gateway`: mock API on :7800 and gateway on :7801, printing a run token per tenant so
// the servers can be wired into Claude Code with the example config in the README.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const signingKey = process.env.GATEWAY_SIGNING_KEY ?? randomBytes(32).toString("hex");
  const api = await startMockApi({ port: 7800 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fieldservice-mcp-"));
  const gw = await startGateway({
    port: 7801,
    dbPath: path.join(dir, "platform.db"),
    apiUrl: api.url,
    signingKey,
    vaultKey: process.env.VAULT_KEY ?? randomBytes(32).toString("hex"),
    slackSigningSecret: process.env.SLACK_SIGNING_SECRET ?? randomBytes(16).toString("hex"),
  });
  bootstrap(gw, api);
  console.log(`mock API ${api.url}\ngateway  ${gw.url}  (MCP at /mcp/read and /mcp/drafts)\n`);
  for (const tenant of Object.keys(MANIFESTS)) {
    const token = await mintRunToken(signingKey, { tenant, runId: `manual-${tenant}`, tools: [] }, 3600);
    console.log(`RUN_TOKEN for ${tenant} (1 hour):\n${token}\n`);
  }
}
