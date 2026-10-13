import { pathToFileURL } from "node:url";

// Claude Code PreToolUse hook. It is configured in managed settings mounted read-only in the job
// container, so a run can't edit or remove it. It sees only the tool name and input, never the
// transcript, so nothing the model writes can change a decision. It fails closed on any error.

export type ToolClass = "read" | "draft" | "local_read" | "spend" | "publish";

export const REGISTRY: Record<string, ToolClass> = {
  mcp__fieldservice_read__jobs_search: "read",
  mcp__fieldservice_read__job_get: "read",
  mcp__fieldservice_read__customer_get: "read",
  mcp__fieldservice_read__estimates_list_open: "read",
  mcp__fieldservice_read__invoices_list_overdue: "read",
  mcp__fieldservice_read__technician_schedule_get: "read",
  mcp__fieldservice_drafts__followup_task_draft: "draft",
  mcp__fieldservice_drafts__invoice_reminder_draft: "draft",
  mcp__fieldservice_drafts__job_note_draft: "draft",
  // Connectors outside this demo, registered so the spend and publish path has something to gate.
  mcp__ads__campaign_budget_update: "spend",
  mcp__reviews__review_reply_publish: "publish",
  Read: "local_read",
  Glob: "local_read",
  Grep: "local_read",
  // Claude Code loads deferred MCP tool schemas through ToolSearch. It only returns schemas, and
  // denying it leaves the agent unable to see the fieldservice tools at all.
  ToolSearch: "local_read",
};

export interface HookInput {
  tool_name: string;
  tool_input?: Record<string, unknown>;
  hook_event_name?: string;
}

export interface Decision {
  decision: "allow" | "deny" | "defer";
  reason: string;
}

export type ApprovalCheck = (tool: string, args: Record<string, unknown>) => Promise<{ allow: boolean; draftId?: string }>;

// No pipes, redirects, substitutions or chaining, so no route to the network or to secrets.
const SAFE_BASH = /^(ls|cat|head|tail|wc|grep|jq)( +[\w./=:@%+-]+)* *$/;

export async function decide(input: HookInput, check: ApprovalCheck): Promise<Decision> {
  const tool = input.tool_name;
  if (tool === "Bash") {
    const cmd = String(input.tool_input?.command ?? "").trim();
    return SAFE_BASH.test(cmd)
      ? { decision: "defer", reason: "allowlisted read-only command" }
      : { decision: "deny", reason: "Bash is limited to simple read-only commands in agent runs" };
  }
  const cls = REGISTRY[tool];
  if (!cls) return { decision: "deny", reason: `${tool} is not in the tool registry, and unknown tools are denied` };
  // Reads and drafts fall through to the run's normal --allowedTools list as a second layer.
  if (cls === "read" || cls === "draft" || cls === "local_read") return { decision: "defer", reason: `${cls} tool` };
  const r = await check(tool, input.tool_input ?? {});
  return r.allow
    ? { decision: "allow", reason: "matching single-use approval consumed" }
    : { decision: "deny", reason: `${cls} tools need a human approval of this exact call. Draft ${r.draftId ?? "(not created)"} was sent to Slack; stop and report it.` };
}

export function remoteCheck(gatewayUrl: string | undefined, runToken: string | undefined): ApprovalCheck {
  return async (tool, args) => {
    if (!gatewayUrl || !runToken) return { allow: false };
    const res = await fetch(`${gatewayUrl}/gate/check`, {
      method: "POST",
      headers: { authorization: `Bearer ${runToken}`, "content-type": "application/json" },
      body: JSON.stringify({ tool, args }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { allow: false };
    const body = (await res.json()) as { allow?: unknown; draftId?: string };
    return { allow: body.allow === true, draftId: body.draftId };
  };
}

export function toHookOutput(d: Decision): string | null {
  if (d.decision === "defer") return null;
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d.decision, permissionDecisionReason: d.reason },
  });
}

async function main(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
    if (typeof input.tool_name !== "string") throw new Error("no tool_name");
  } catch {
    process.stderr.write("gate: unreadable hook input, blocking the tool call\n");
    process.exit(2);
  }
  const d = await decide(input, remoteCheck(process.env.GATEWAY_URL, process.env.RUN_TOKEN)).catch(
    (): Decision => ({ decision: "deny", reason: "gate check failed, so the call is blocked" }),
  );
  const out = toHookOutput(d);
  if (out) process.stdout.write(out + "\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) void main();
