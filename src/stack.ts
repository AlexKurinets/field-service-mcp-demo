import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMockApi, type MockApi } from "./mockApi.js";
import { bootstrap, startGateway, type Gateway } from "./http.js";
import { mintRunToken } from "./runToken.js";
import { resetBuckets } from "./stClient.js";

// Mock API + gateway with fresh keys and a temp database, used by the tests and the demo.

export interface StackOptions {
  tokenTtlSec?: number;
  tokenMarginSec?: number;
  apiRateLimitPerSec?: number;
  clientRatePerSec?: number;
  approvalTtlSec?: number;
}

export interface Stack {
  api: MockApi;
  gw: Gateway;
  keys: { signingKey: string; vaultKey: string; slackSigningSecret: string };
  webhookSecrets: Record<string, string>;
  mint(tenant: string, tools?: string[], ttlSec?: number): Promise<string>;
  connect(tenant: string, which: "read" | "drafts", tools?: string[]): Promise<Client>;
  close(): Promise<void>;
}

export async function startStack(opts: StackOptions = {}): Promise<Stack> {
  resetBuckets();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fieldservice-mcp-"));
  const api = await startMockApi({ tokenTtlSec: opts.tokenTtlSec, rateLimitPerSec: opts.apiRateLimitPerSec });
  const keys = {
    signingKey: randomBytes(32).toString("hex"),
    vaultKey: randomBytes(32).toString("hex"),
    slackSigningSecret: randomBytes(16).toString("hex"),
  };
  const gw = await startGateway({
    dbPath: path.join(dir, "platform.db"),
    apiUrl: api.url,
    ...keys,
    tokenMarginSec: opts.tokenMarginSec,
    rateLimitPerSec: opts.clientRatePerSec,
    approvalTtlSec: opts.approvalTtlSec,
  });
  const { webhookSecrets } = bootstrap(gw, api);
  const clients: Client[] = [];

  const mint = (tenant: string, tools: string[] = [], ttlSec = 600) =>
    mintRunToken(keys.signingKey, { tenant, runId: `run-${tenant}-${randomBytes(3).toString("hex")}`, tools }, ttlSec);

  const connect = async (tenant: string, which: "read" | "drafts", tools?: string[]) => {
    const token = await mint(tenant, tools);
    const client = new Client({ name: "conformance", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${gw.url}/mcp/${which}`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }));
    clients.push(client);
    return client;
  };

  return {
    api, gw, keys, webhookSecrets, mint, connect,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()));
      await gw.close();
      await api.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function textOf(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("\n");
}
