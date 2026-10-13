import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { StClient } from "../stClient.js";
import { isoDay } from "../seed.js";

export interface ReadServerContext {
  api: StClient;
  allowedTools: string[];
}

const ok = (data: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
const notFound = (what: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: `${what} not found` }] });

// Read annotations are guidance for the model. The enforcement is that this server only ever
// holds a read-scoped token, and no schema below has a tenant parameter.
const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

interface List<T> { data: T[]; hasMore: boolean }

export function buildReadServer(ctx: ReadServerContext): McpServer {
  const server = new McpServer({ name: "fieldservice-read", version: "1.0.0" });
  const allowed = (name: string) => ctx.allowedTools.includes(name);
  const { api } = ctx;

  if (allowed("jobs_search")) {
    server.registerTool("jobs_search", {
      title: "Search jobs",
      description: "Search this brand's jobs by status, customer or free text in the job type and summary.",
      inputSchema: {
        status: z.enum(["Scheduled", "InProgress", "Completed", "Canceled"]).optional(),
        customer_id: z.number().int().positive().optional(),
        text: z.string().max(100).optional(),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { title: "Search jobs", ...READ },
    }, async ({ status, customer_id, text, limit }) => {
      const res = await api.get<List<Record<string, unknown>>>("jpm", "/jobs", { status, customerId: customer_id, text, pageSize: limit });
      return ok(res ?? { data: [], hasMore: false });
    });
  }

  if (allowed("job_get")) {
    server.registerTool("job_get", {
      title: "Get job",
      description: "Fetch one job by ID.",
      inputSchema: { job_id: z.number().int().positive() },
      annotations: { title: "Get job", ...READ },
    }, async ({ job_id }) => {
      const job = await api.get("jpm", `/jobs/${job_id}`);
      return job ? ok(job) : notFound(`Job ${job_id}`);
    });
  }

  if (allowed("customer_get")) {
    server.registerTool("customer_get", {
      title: "Get customer",
      description: "Fetch one customer by ID, including access notes.",
      inputSchema: { customer_id: z.number().int().positive() },
      annotations: { title: "Get customer", ...READ },
    }, async ({ customer_id }) => {
      const c = await api.get("crm", `/customers/${customer_id}`);
      return c ? ok(c) : notFound(`Customer ${customer_id}`);
    });
  }

  if (allowed("estimates_list_open")) {
    server.registerTool("estimates_list_open", {
      title: "List open estimates",
      description: "Open (unsold) estimates, optionally only those older than N days.",
      inputSchema: { older_than_days: z.number().int().min(0).max(365).optional() },
      annotations: { title: "List open estimates", ...READ },
    }, async ({ older_than_days }) => {
      const res = await api.get("sales", "/estimates", {
        status: "Open",
        createdBefore: older_than_days === undefined ? undefined : isoDay(-older_than_days),
      });
      return ok(res);
    });
  }

  if (allowed("invoices_list_overdue")) {
    server.registerTool("invoices_list_overdue", {
      title: "List overdue invoices",
      description: "Invoices past due with an open balance.",
      inputSchema: {
        min_days_overdue: z.number().int().min(0).max(365).optional(),
        min_balance: z.number().min(0).optional(),
      },
      annotations: { title: "List overdue invoices", ...READ },
    }, async ({ min_days_overdue, min_balance }) => {
      const res = await api.get("accounting", "/invoices", { overdueOnly: "true", minDaysOverdue: min_days_overdue, minBalance: min_balance });
      return ok(res);
    });
  }

  if (allowed("technician_schedule_get")) {
    server.registerTool("technician_schedule_get", {
      title: "Get technician schedule",
      description: "Appointments for a date, optionally for one technician.",
      inputSchema: {
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
        technician_id: z.number().int().positive().optional(),
      },
      annotations: { title: "Get technician schedule", ...READ },
    }, async ({ date, technician_id }) => {
      const res = await api.get("dispatch", "/appointments", { date, technicianId: technician_id });
      return ok(res);
    });
  }

  return server;
}
