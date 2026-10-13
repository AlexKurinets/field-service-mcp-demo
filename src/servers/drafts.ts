import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// Where a draft goes. In the gateway it is a tenant-bound DB insert plus a Slack approval message;
// over stdio it is a POST to the gateway carrying the run token. Neither path holds API credentials.
export interface DraftSink {
  create(action: string, args: Record<string, unknown>): Promise<{ draftId: string; payloadHash: string }>;
}

export interface DraftServerContext {
  sink: DraftSink;
  allowedTools: string[];
}

// Draft tools write a row and nothing else, so they are not read-only but not destructive either.
const DRAFT = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

const receipt = (r: { draftId: string; payloadHash: string }, what: string): CallToolResult => ({
  content: [{
    type: "text",
    text: JSON.stringify({
      draft_id: r.draftId,
      status: "pending_approval",
      payload_hash: r.payloadHash,
      note: `${what} drafted and sent to Slack for approval. Nothing has been sent to the field-service system.`,
    }, null, 2),
  }],
});

export function buildDraftServer(ctx: DraftServerContext): McpServer {
  const server = new McpServer({ name: "fieldservice-drafts", version: "1.0.0" });
  const allowed = (name: string) => ctx.allowedTools.includes(name);

  if (allowed("followup_task_draft")) {
    server.registerTool("followup_task_draft", {
      title: "Draft follow-up task",
      description: "Draft a follow-up task for an office manager, for example on an unsold estimate. Requires human approval before it is created.",
      inputSchema: {
        customer_id: z.number().int().positive(),
        estimate_id: z.number().int().positive().optional(),
        due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
        note: z.string().min(1).max(500),
      },
      annotations: { title: "Draft follow-up task", ...DRAFT },
    }, async (args) => receipt(await ctx.sink.create("crm.task.create", args), "Follow-up task"));
  }

  if (allowed("invoice_reminder_draft")) {
    server.registerTool("invoice_reminder_draft", {
      title: "Draft invoice reminder",
      description: "Draft a payment reminder for an overdue invoice. Requires human approval before it is sent to the customer.",
      inputSchema: {
        invoice_id: z.number().int().positive(),
        channel: z.enum(["email", "sms"]),
        message: z.string().min(1).max(600),
      },
      annotations: { title: "Draft invoice reminder", ...DRAFT },
    }, async (args) => receipt(await ctx.sink.create("accounting.invoice.reminder.send", args), "Invoice reminder"));
  }

  if (allowed("job_note_draft")) {
    server.registerTool("job_note_draft", {
      title: "Draft job note",
      description: "Draft an internal note on a job. Requires human approval before it is written.",
      inputSchema: {
        job_id: z.number().int().positive(),
        note: z.string().min(1).max(1000),
      },
      annotations: { title: "Draft job note", ...DRAFT },
    }, async (args) => receipt(await ctx.sink.create("jpm.job.note.create", args), "Job note"));
  }

  return server;
}
