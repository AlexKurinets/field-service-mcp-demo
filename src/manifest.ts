// Tenant manifests. In the platform these live in the config repo and are loaded by the
// scheduler; the gateway is the only component that maps a run to a tenant.

export const READ_TOOLS = [
  "jobs_search",
  "job_get",
  "customer_get",
  "estimates_list_open",
  "invoices_list_overdue",
  "technician_schedule_get",
] as const;

export const DRAFT_TOOLS = ["followup_task_draft", "invoice_reminder_draft", "job_note_draft"] as const;

export interface TenantManifest {
  tenant: string;
  displayName: string;
  stTenantId: number;
  allowedTools: string[];
  approvers: string[];
  slackChannel: string;
}

export const MANIFESTS: Record<string, TenantManifest> = {
  "brand-north": {
    tenant: "brand-north",
    displayName: "North region brand",
    stTenantId: 1001,
    allowedTools: [...READ_TOOLS, ...DRAFT_TOOLS],
    approvers: ["U01NORTHOPS"],
    slackChannel: "#north-ops-agent",
  },
  "brand-central": {
    tenant: "brand-central",
    displayName: "Central region brand",
    stTenantId: 1002,
    allowedTools: [...READ_TOOLS, ...DRAFT_TOOLS],
    approvers: ["U02CENTRALOPS"],
    slackChannel: "#central-ops-agent",
  },
  "brand-coastal": {
    tenant: "brand-coastal",
    displayName: "Coastal region brand",
    stTenantId: 1003,
    // Coastal chases invoices in another system, so the reminder draft tool is not granted.
    allowedTools: [...READ_TOOLS, "followup_task_draft", "job_note_draft"],
    approvers: ["U03COASTALOPS"],
    slackChannel: "#coastal-ops-agent",
  },
};

export function manifestFor(tenant: string): TenantManifest {
  const m = MANIFESTS[tenant];
  if (!m) throw new Error(`unknown tenant ${tenant}`);
  return m;
}
