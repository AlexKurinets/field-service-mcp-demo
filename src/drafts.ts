import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { payloadHash } from "./canonical.js";

export type DraftKind = "executor" | "tool_call";
export type DraftStatus = "pending" | "approved" | "rejected" | "executed" | "failed";

export interface Draft {
  id: string;
  tenant: string;
  kind: DraftKind;
  action: string;
  args: Record<string, unknown>;
  payloadHash: string;
  runId: string;
  status: DraftStatus;
  createdAt: number;
}

interface DraftRow {
  id: string; tenant: string; kind: DraftKind; action: string; args_json: string;
  payload_hash: string; run_id: string; status: DraftStatus; created_at: number;
}

export function rowToDraft(r: DraftRow): Draft {
  return {
    id: r.id, tenant: r.tenant, kind: r.kind, action: r.action, args: JSON.parse(r.args_json),
    payloadHash: r.payload_hash, runId: r.run_id, status: r.status, createdAt: r.created_at,
  };
}

// Every query here carries the tenant bound at construction. Agent-facing code only ever gets a
// TenantDrafts, so it has no way to name another tenant's rows (the RLS role in this demo).
export class TenantDrafts {
  constructor(private db: DatabaseSync, readonly tenant: string) {}

  create(kind: DraftKind, action: string, args: Record<string, unknown>, runId: string): Draft {
    const d: Draft = {
      id: `drf_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      tenant: this.tenant, kind, action, args,
      payloadHash: payloadHash({ tenant: this.tenant, action, args }),
      runId, status: "pending", createdAt: Date.now(),
    };
    this.db
      .prepare("INSERT INTO drafts (id, tenant, kind, action, args_json, payload_hash, run_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(d.id, d.tenant, d.kind, d.action, JSON.stringify(d.args), d.payloadHash, d.runId, d.status, d.createdAt);
    return d;
  }

  get(id: string): Draft | undefined {
    const r = this.db.prepare("SELECT * FROM drafts WHERE id = ? AND tenant = ?").get(id, this.tenant) as DraftRow | undefined;
    return r && rowToDraft(r);
  }

  list(): Draft[] {
    return (this.db.prepare("SELECT * FROM drafts WHERE tenant = ? ORDER BY created_at").all(this.tenant) as unknown as DraftRow[]).map(rowToDraft);
  }

  findPendingByHash(hash: string): Draft | undefined {
    const r = this.db
      .prepare("SELECT * FROM drafts WHERE tenant = ? AND payload_hash = ? AND status = 'pending'")
      .get(this.tenant, hash) as DraftRow | undefined;
    return r && rowToDraft(r);
  }
}

// System access for the executor and the approval handler, which run outside agent runs and
// take the tenant from the draft row itself.
export function loadDraft(db: DatabaseSync, id: string): Draft | undefined {
  const r = db.prepare("SELECT * FROM drafts WHERE id = ?").get(id) as DraftRow | undefined;
  return r && rowToDraft(r);
}

export function setDraftStatus(db: DatabaseSync, id: string, status: DraftStatus): void {
  db.prepare("UPDATE drafts SET status = ? WHERE id = ?").run(status, id);
}
