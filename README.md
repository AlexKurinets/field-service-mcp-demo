# field-service-mcp-demo

A runnable rebuild of the design behind a production ServiceTitan MCP server I built for a home services company running three regional brands. The production code isn't public, so this version runs against a small mock ServiceTitan-style API with fake data. It keeps the parts that matter: read tools and draft-only write tools in separate servers, the tenant taken from a signed run token instead of from tool arguments, a Claude Code PreToolUse hook that denies by default, and approvals bound to a hash of the exact payload. It is not affiliated with ServiceTitan.

```bash
npm install
npm test        # 26 conformance tests: transport, auth, tenant isolation, the gate, the hook, refresh, rate limits, webhooks
npm run demo    # narrated end-to-end run, about 2 seconds
npm run gateway # mock API on :7800, gateway on :7801, prints a run token per tenant for wiring into Claude Code
```

Node 22.13 or later (it uses the built-in `node:sqlite`). No external services.

## Layout

```
scheduler ──run token (JWT: tenant, run id, tools)──▶ Claude Code run
                                                       │  PreToolUse hook (managed settings, read-only)
                                                       ▼
                                    gateway  /mcp/read     ──▶ read server   ──read-scoped token──▶ field-service API
                                             /mcp/drafts   ──▶ draft server  ──▶ drafts table (hash) ──▶ Slack approval
                                                                                                  │
                                    executor (write-scoped token, outside agent runs) ◀───────────┘ ──▶ field-service API
```

| File | What it does |
|---|---|
| `src/servers/read.ts` | MCP read server: `jobs_search`, `job_get`, `customer_get`, `estimates_list_open`, `invoices_list_overdue`, `technician_schedule_get` |
| `src/servers/drafts.ts` | MCP draft server: `followup_task_draft`, `invoice_reminder_draft`, `job_note_draft`. Writes a draft row, never calls the API |
| `src/http.ts` | Gateway: Streamable HTTP endpoints, run-token auth, credential broker endpoint, hook backend, Slack callback, signed webhooks |
| `src/stdio.ts` | The same two servers over stdio, holding only `RUN_TOKEN` and `GATEWAY_URL` |
| `src/runToken.ts` | Run tokens (HS256 JWT via `jose`): tenant, run id, requested tools, issuer, audience, expiry |
| `src/vault.ts`, `src/broker.ts` | Per-tenant credentials encrypted with AES-256-GCM; access tokens minted, cached and refreshed ahead of expiry |
| `src/canonical.ts`, `src/approvals.ts`, `src/executor.ts` | Payload hashing, approvals with nonce and expiry, and the executor that recomputes the hash before it sends anything |
| `src/hook/pretooluse.ts` | Claude Code PreToolUse hook |
| `src/mockApi.ts`, `src/seed.ts` | Mock API (client-credentials OAuth, tenant in the path, read and write scopes, per-tenant rate limit, idempotency keys) and fake data with a canary string per tenant |
| `test/conformance.test.ts` | The conformance suite |

## SDK and transport

Built on the official TypeScript SDK, `@modelcontextprotocol/sdk` 1.32.1, with `McpServer.registerTool` and zod input schemas. The gateway serves both servers over Streamable HTTP in stateless mode: each POST is authenticated from its bearer run token and handled by a fresh server instance bound to that tenant, so there is no session state to hijack and a request can only ever see one tenant. `src/stdio.ts` starts the same server code over stdio for local development, CI and hosts that spawn MCP servers as child processes.

## Keeping reads and writes apart

The two kinds of tool live in separate servers, which gives three independent controls. An allowlist can grant the whole read server (`mcp__fieldservice_read`) while write tools are granted one at a time. The read server only ever receives a read-scoped API token, and the API rejects writes on that scope. The draft server has no API client at all: its tools insert a row holding the tenant, the action, the canonical arguments and a SHA-256 over all three, then post an approval request to the tenant's Slack channel. Tool annotations are set (`readOnlyHint: true` on reads, `readOnlyHint: false, destructiveHint: false` on drafts), but they're guidance for the model, not the enforcement.

The executor in `src/executor.ts` is the only code that holds a write-scoped token, and it never runs inside an agent run. Before sending, it reloads the draft, recomputes the hash from exactly what it's about to send, and checks that an approval exists for that hash, that it hasn't expired, that its single-use nonce hasn't been consumed, and that the approver is on that tenant's approver list. Any mismatch fails closed. The draft ID is sent as the idempotency key, so a retry after a timeout can't send twice.

## Auth

There are two layers. Between an agent run and the servers, the scheduler mints a short-lived JWT naming the tenant, the run ID and the tools requested. The gateway verifies signature, issuer, audience and expiry on every request, resolves the tenant from the token, and exposes only the tools that are in both the token and that tenant's manifest. No tool schema has a tenant parameter, and the conformance suite fails if one appears.

Between the gateway and the field-service API, each tenant's client credentials are encrypted at rest with AES-256-GCM, with the tenant and scope bound in as additional authenticated data, so a ciphertext copied into another tenant's row won't decrypt. The broker exchanges them for short-lived access tokens, caches them, refreshes them ahead of expiry, and swaps in a fresh token once if the API returns 401. A stdio server never sees a client secret: it asks the gateway's broker for a read-scoped token using its run token. Calls go through a per-tenant token bucket, so one brand's backfill can't spend another brand's rate limit.

## The approval gate in Claude Code

`examples/agent-settings.json` installs `src/hook/pretooluse.ts` as a PreToolUse hook for every tool. In the platform this lives in managed settings mounted read-only in the job container, so a run can't edit or remove it. The hook reads only the tool name and input, never the transcript, and classifies the tool from a registry. Reads and drafts fall through to the run's `--allowedTools` list as a second layer. Unknown tools are denied. Bash is limited to simple read-only commands with no pipes, redirects or substitutions, since curl with a token is the obvious way around a gate that only watches MCP tools. Spend and publish tools (two example connectors are registered) are denied unless the gateway finds an unused, unexpired approval for that tenant, tool and exact argument set, which it consumes. The hook fails closed if the gateway is unreachable or the input is unreadable.

`examples/headless-run.md` is a real `claude -p` run against the gateway with this hook and `examples/mcp.http.json`: the read tool returned the brand's overdue invoices, the draft tool created a pending draft, a lookup of another brand's job came back not found, and the hook blocked the agent's curl call even though Bash was in `--allowedTools`.

## What the tests prove

`npm test` runs 26 tests against a real gateway, a real mock API and real MCP clients:

- **Transport and auth:** six read tools all marked read-only, three draft tools, no tenant parameter in any schema; missing, forged, expired and wrong-audience run tokens get 401; the tool list is the manifest grant intersected with the token; the same servers work over stdio with only a run token and the gateway URL.
- **Tenant isolation:** each tenant's data carries a canary string. Every read tool is called for every tenant, and each tenant's output must contain its own canary and never another's. Other tenants' IDs come back as not found, the API itself refuses a tenant's token on another tenant's path, draft rows are unreachable across tenants, and swapped credential ciphertexts fail to decrypt.
- **Approval gate:** draft tools make zero API writes; the executor refuses unapproved drafts; an approval releases exactly the drafted payload once, with the draft ID as idempotency key; a changed payload, an expired approval, a replay and an approver from another tenant are all refused; the Slack callback rejects bad signatures and stale timestamps.
- **Hook:** unknown tools, WebFetch, writes to settings and unsafe Bash are denied; a spend call is allowed only after approval of that exact call and only once; a different amount, an argument claiming approval, or another tenant's run are denied; the compiled hook process fails closed.
- **Credentials and limits:** tokens refresh ahead of expiry and a revoked token is replaced once; a burst of 15 calls stays under the API's per-tenant rate limit with zero 429s.
- **Webhooks:** valid signatures accepted, bad, stale and cross-tenant signatures rejected.

To check that the tests bite, I disabled the hash check in the executor, the approval check in the hook and the tenant check in the mock API one at a time. Each change failed the tests that cover it.

## Differences from production

The production server used Postgres with row-level security on every tenant-scoped table; here SQLite and a tenant-bound repository class (`TenantDrafts`) stand in for it. Slack is simulated by an outbox array plus a real signed interactivity endpoint. The scheduler, budget caps and the agent runner are outside this repo; `--max-budget-usd` and `--allowedTools` in the example command stand in for them. The mock API models the shape of a field-service API, not ServiceTitan's full surface.
