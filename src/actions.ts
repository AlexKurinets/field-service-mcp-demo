// Draft actions the executor knows how to commit, and the API request each one becomes.
// Draft tools on the MCP side can only create rows naming one of these actions.

export interface ApiRequest { area: string; path: string; body: Record<string, unknown> }

export const DRAFT_ACTIONS: Record<string, { tool: string; toRequest: (args: Record<string, unknown>) => ApiRequest }> = {
  "crm.task.create": {
    tool: "followup_task_draft",
    toRequest: (a) => ({
      area: "crm",
      path: "/tasks",
      body: { customerId: a.customer_id, estimateId: a.estimate_id, dueDate: a.due_date, body: a.note },
    }),
  },
  "accounting.invoice.reminder.send": {
    tool: "invoice_reminder_draft",
    toRequest: (a) => ({
      area: "accounting",
      path: `/invoices/${Number(a.invoice_id)}/reminders`,
      body: { channel: a.channel, message: a.message },
    }),
  },
  "jpm.job.note.create": {
    tool: "job_note_draft",
    toRequest: (a) => ({ area: "jpm", path: `/jobs/${Number(a.job_id)}/notes`, body: { text: a.note } }),
  },
};

export function actionForTool(tool: string): string | undefined {
  return Object.entries(DRAFT_ACTIONS).find(([, v]) => v.tool === tool)?.[0];
}
