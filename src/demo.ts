import { startStack, textOf } from "./stack.js";
import { approveDraft, GateError } from "./approvals.js";
import { executeDraft } from "./executor.js";
import { TenantDrafts } from "./drafts.js";
import { decide, remoteCheck } from "./hook/pretooluse.js";
import { signSlack } from "./webhooks.js";

// `npm run demo`: a narrated end-to-end run against the mock API, suitable for a screen recording.

const step = (n: number, title: string) => console.log(`\n${n}. ${title}`);
const line = (s: string) => console.log(`   ${s}`);
const refusal = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === "function" ? p() : p);
    return "NOT REFUSED";
  } catch (err) {
    return err instanceof GateError ? `refused: ${err.code}` : `error: ${(err as Error).message}`;
  }
};

const s = await startStack();
const deps = { db: s.gw.db, broker: s.gw.broker, apiUrl: s.api.url };
try {
  console.log("Field-service MCP demo: split read and draft servers, tenant from a signed run token,");
  console.log("and approvals bound to the exact payload. Mock API, fake data, three brands.");

  step(1, "Run token for brand-north, connect to both servers over Streamable HTTP");
  const read = await s.connect("brand-north", "read");
  const drafts = await s.connect("brand-north", "drafts");
  const readTools = (await read.listTools()).tools;
  const draftTools = (await drafts.listTools()).tools;
  line(`read:   ${readTools.map((t) => t.name).join(", ")}  (readOnlyHint=${readTools.every((t) => t.annotations?.readOnlyHint)})`);
  line(`drafts: ${draftTools.map((t) => t.name).join(", ")}  (readOnlyHint=${draftTools.some((t) => t.annotations?.readOnlyHint)})`);
  const tenantParams = [...readTools, ...draftTools].filter((t) => Object.keys((t.inputSchema as { properties?: object }).properties ?? {}).some((k) => /tenant/i.test(k)));
  line(`tools with a tenant parameter: ${tenantParams.length}`);

  step(2, "invoices_list_overdue");
  const overdue = JSON.parse(textOf(await read.callTool({ name: "invoices_list_overdue", arguments: {} }))) as { data: Array<{ id: number; balance: number; dueDate: string }> };
  for (const v of overdue.data) line(`invoice ${v.id}  $${v.balance}  due ${v.dueDate}`);

  step(3, "job_get 2101, which belongs to brand-central");
  line(textOf(await read.callTool({ name: "job_get", arguments: { job_id: 2101 } })));

  step(4, "invoice_reminder_draft for invoice 1305");
  const before = s.api.stats.writes.length;
  const draft = JSON.parse(textOf(await drafts.callTool({
    name: "invoice_reminder_draft",
    arguments: { invoice_id: 1305, channel: "email", message: "Your invoice is 45 days past due. Reply here with any questions." },
  }))) as { draft_id: string; payload_hash: string };
  line(`draft ${draft.draft_id}  sha256 ${draft.payload_hash.slice(0, 16)}...`);
  line(`Slack: ${s.gw.slackOutbox.at(-1)?.channel} <- approval request`);
  line(`API writes so far: ${s.api.stats.writes.length - before}`);

  step(5, "Executor before anyone approves");
  line(await refusal(executeDraft(deps, draft.draft_id)));

  step(6, "Approval attempt by brand-central's approver");
  line(await refusal(() => approveDraft(s.gw.db, draft.draft_id, "U02CENTRALOPS", 3600)));

  step(7, "Signed Slack approval by brand-north's approver");
  const body = `payload=${encodeURIComponent(JSON.stringify({ type: "block_actions", user: { id: "U01NORTHOPS" }, actions: [{ action_id: "approve", value: draft.draft_id }] }))}`;
  const ts = Math.floor(Date.now() / 1000);
  const res = await fetch(`${s.gw.url}/slack/interactions`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-slack-request-timestamp": String(ts), "x-slack-signature": signSlack(s.keys.slackSigningSecret, ts, body) },
    body,
  });
  line(`gateway: ${JSON.stringify(((await res.json()) as { status: string }).status)}`);
  const w = s.api.stats.writes.at(-1)!;
  line(`API write: POST ${w.path}  idempotency-key ${w.idempotencyKey}`);

  step(8, "Replay the same approval");
  line(`${await refusal(executeDraft(deps, draft.draft_id))}  (API writes: ${s.api.stats.writes.length - before})`);

  step(9, "Approve a draft, then change its arguments before execution");
  const d2 = JSON.parse(textOf(await drafts.callTool({ name: "job_note_draft", arguments: { job_id: 1101, note: "Customer asked for a call before arrival." } }))) as { draft_id: string };
  approveDraft(s.gw.db, d2.draft_id, "U01NORTHOPS", 3600);
  s.gw.db.prepare("UPDATE drafts SET args_json = ? WHERE id = ?").run(JSON.stringify({ job_id: 1101, note: "Waive the diagnostic fee." }), d2.draft_id);
  line(await refusal(executeDraft(deps, d2.draft_id)));

  step(10, "PreToolUse hook");
  const check = remoteCheck(s.gw.url, await s.mint("brand-north"));
  const hook = async (tool_name: string, tool_input: Record<string, unknown>) => {
    const d = await decide({ tool_name, tool_input }, check);
    return `${d.decision.padEnd(5)} ${d.decision === "defer" ? "(falls through to --allowedTools)" : d.reason}`;
  };
  line(`unknown MCP tool             -> ${await hook("mcp__shopify__product_update", { id: 1 })}`);
  line(`Bash curl                    -> ${await hook("Bash", { command: "curl -X POST https://api.example.com" })}`);
  const spend = { campaign_id: "cmp-114", daily_budget: 50, currency: "USD" };
  line(`ad budget $50, no approval   -> ${await hook("mcp__ads__campaign_budget_update", spend)}`);
  const pending = new TenantDrafts(s.gw.db, "brand-north").list().find((d) => d.kind === "tool_call" && d.status === "pending")!;
  approveDraft(s.gw.db, pending.id, "U01NORTHOPS", 3600);
  line(`(approved ${pending.id} in Slack)`);
  line(`ad budget $50, $500 instead  -> ${await hook("mcp__ads__campaign_budget_update", { ...spend, daily_budget: 500 })}`);
  line(`ad budget $50, "approved"    -> ${await hook("mcp__ads__campaign_budget_update", { ...spend, approved: true })}`);
  line(`ad budget $50, exact call    -> ${await hook("mcp__ads__campaign_budget_update", spend)}`);
  line(`ad budget $50, again         -> ${await hook("mcp__ads__campaign_budget_update", spend)}`);
  console.log("");
} finally {
  await s.close();
}
