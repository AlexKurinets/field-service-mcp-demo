import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildReadServer } from "./servers/read.js";
import { buildDraftServer } from "./servers/drafts.js";
import { StClient, TokenBucket, type ApiToken, type TokenSource } from "./stClient.js";

// The same two servers over stdio, for local development, CI and agent hosts that spawn MCP
// servers as child processes. The process is given RUN_TOKEN and GATEWAY_URL and nothing else:
// it holds no vault key and no client secrets. API tokens come from the gateway's broker, and
// drafts are posted back to the gateway, both authenticated by the run token.

const which = process.argv[2];
const runToken = process.env.RUN_TOKEN;
const gatewayUrl = process.env.GATEWAY_URL;
if ((which !== "read" && which !== "drafts") || !runToken || !gatewayUrl) {
  process.stderr.write("usage: RUN_TOKEN=... GATEWAY_URL=... node dist/src/stdio.js read|drafts\n");
  process.exit(1);
}

async function gateway<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${gatewayUrl}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${runToken}`, "content-type": "application/json" },
  });
  if (!res.ok) throw new Error(`gateway ${path} returned ${res.status}`);
  return (await res.json()) as T;
}

const ctx = await gateway<{ tenant: string; runId: string; tools: string[]; apiUrl: string }>("/run/context");

let cached: (ApiToken & { expiresAt: number }) | undefined;
const tokens: TokenSource = {
  get: async () => {
    if (!cached || cached.expiresAt - 30_000 < Date.now()) {
      cached = await gateway<ApiToken & { expiresAt: number }>("/broker/token");
    }
    return cached;
  },
  invalidate: () => {
    cached = undefined;
  },
};

const server = which === "read"
  ? buildReadServer({ api: new StClient(ctx.apiUrl, tokens, new TokenBucket(10, 10)), allowedTools: ctx.tools })
  : buildDraftServer({
      sink: { create: (action, args) => gateway("/drafts", { method: "POST", body: JSON.stringify({ action, args }) }) },
      allowedTools: ctx.tools,
    });

await server.connect(new StdioServerTransport());
process.stderr.write(`fieldservice-${which} on stdio for ${ctx.tenant} (run ${ctx.runId})\n`);
