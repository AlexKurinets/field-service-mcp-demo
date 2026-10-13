import { randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { loadDraft, setDraftStatus } from "./drafts.js";
import { transaction } from "./db.js";

export type Refusal =
  | "draft_not_found" | "not_pending" | "approver_not_allowed" | "not_approved"
  | "hash_mismatch" | "expired" | "already_used" | "unknown_action" | "upstream_error";

export class GateError extends Error {
  constructor(readonly code: Refusal, message?: string) {
    super(message ?? code);
  }
}

export interface Approval {
  id: string; draftId: string; tenant: string; payloadHash: string;
  approver: string; nonce: string; expiresAt: number; usedAt: number | null;
}

interface ApprovalRow {
  id: string; draft_id: string; tenant: string; payload_hash: string;
  approver: string; nonce: string; expires_at: number; used_at: number | null;
}

const toApproval = (r: ApprovalRow): Approval => ({
  id: r.id, draftId: r.draft_id, tenant: r.tenant, payloadHash: r.payload_hash,
  approver: r.approver, nonce: r.nonce, expiresAt: r.expires_at, usedAt: r.used_at,
});

export function isApprover(db: DatabaseSync, tenant: string, userId: string): boolean {
  return !!db.prepare("SELECT 1 FROM approvers WHERE tenant = ? AND user_id = ?").get(tenant, userId);
}

// Records a human approval bound to the draft's payload hash, with a single-use nonce and expiry.
export function approveDraft(db: DatabaseSync, draftId: string, approver: string, ttlSec: number, now = Date.now()): Approval {
  return transaction(db, () => {
    const d = loadDraft(db, draftId);
    if (!d) throw new GateError("draft_not_found");
    if (d.status !== "pending") throw new GateError("not_pending", `draft is ${d.status}`);
    if (!isApprover(db, d.tenant, approver)) throw new GateError("approver_not_allowed", `${approver} cannot approve for ${d.tenant}`);
    const a: Approval = {
      id: `apr_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      draftId: d.id, tenant: d.tenant, payloadHash: d.payloadHash, approver,
      nonce: randomBytes(16).toString("hex"), expiresAt: now + ttlSec * 1000, usedAt: null,
    };
    db.prepare("INSERT INTO approvals (id, draft_id, tenant, payload_hash, approver, nonce, expires_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)")
      .run(a.id, a.draftId, a.tenant, a.payloadHash, a.approver, a.nonce, a.expiresAt);
    setDraftStatus(db, d.id, "approved");
    return a;
  });
}

export function rejectDraft(db: DatabaseSync, draftId: string, approver: string): void {
  const d = loadDraft(db, draftId);
  if (!d) throw new GateError("draft_not_found");
  if (!isApprover(db, d.tenant, approver)) throw new GateError("approver_not_allowed");
  if (d.status !== "pending") throw new GateError("not_pending");
  setDraftStatus(db, d.id, "rejected");
}

export function approvalForDraft(db: DatabaseSync, draftId: string): Approval | undefined {
  const r = db.prepare("SELECT * FROM approvals WHERE draft_id = ?").get(draftId) as ApprovalRow | undefined;
  return r && toApproval(r);
}

// Hook path: an unexpired, unused approval for exactly this tenant and payload hash.
export function findUsableApproval(db: DatabaseSync, tenant: string, hash: string, now = Date.now()): Approval | undefined {
  const r = db
    .prepare("SELECT * FROM approvals WHERE tenant = ? AND payload_hash = ? AND used_at IS NULL AND expires_at > ? ORDER BY expires_at LIMIT 1")
    .get(tenant, hash, now) as ApprovalRow | undefined;
  return r && toApproval(r);
}

// Atomic single use: only one caller can flip used_at from NULL.
export function consumeApproval(db: DatabaseSync, approvalId: string, now = Date.now()): boolean {
  const r = db.prepare("UPDATE approvals SET used_at = ? WHERE id = ? AND used_at IS NULL").run(now, approvalId);
  return Number(r.changes) === 1;
}
