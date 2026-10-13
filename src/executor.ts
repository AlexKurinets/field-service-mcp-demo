import type { DatabaseSync } from "node:sqlite";
import { payloadHash } from "./canonical.js";
import { loadDraft, setDraftStatus } from "./drafts.js";
import { approvalForDraft, consumeApproval, GateError, isApprover } from "./approvals.js";
import { DRAFT_ACTIONS } from "./actions.js";
import type { CredentialBroker } from "./broker.js";
import { StClient, TokenBucket } from "./stClient.js";
import { transaction } from "./db.js";

export interface ExecutorDeps {
  db: DatabaseSync;
  broker: CredentialBroker;
  apiUrl: string;
  rateLimitPerSec?: number;
}

// The only component holding write-scoped credentials. It runs outside agent runs, recomputes the
// payload hash from exactly what it is about to send, and fails closed on any mismatch.
export async function executeDraft(deps: ExecutorDeps, draftId: string, now = Date.now()): Promise<{ draftId: string; response: unknown }> {
  const { db } = deps;
  const { draft, request } = transaction(db, () => {
    const draft = loadDraft(db, draftId);
    if (!draft) throw new GateError("draft_not_found");
    const action = DRAFT_ACTIONS[draft.action];
    if (draft.kind !== "executor" || !action) throw new GateError("unknown_action", draft.action);

    const approval = approvalForDraft(db, draft.id);
    if (!approval) throw new GateError("not_approved");
    if (approval.usedAt !== null) throw new GateError("already_used");
    if (approval.expiresAt <= now) throw new GateError("expired");
    if (!isApprover(db, draft.tenant, approval.approver) || approval.tenant !== draft.tenant) throw new GateError("approver_not_allowed");

    const recomputed = payloadHash({ tenant: draft.tenant, action: draft.action, args: draft.args });
    if (recomputed !== approval.payloadHash || recomputed !== draft.payloadHash) throw new GateError("hash_mismatch");

    if (!consumeApproval(db, approval.id, now)) throw new GateError("already_used");
    return { draft, request: action.toRequest(draft.args) };
  });

  const api = new StClient(deps.apiUrl, deps.broker.tokenSource(draft.tenant, "write"), new TokenBucket(deps.rateLimitPerSec ?? 10, 5));
  try {
    // The draft ID is the idempotency key, so a retry after a timeout can't send twice.
    const response = await api.post(request.area, request.path, request.body, draft.id);
    db.prepare("INSERT INTO executions (draft_id, executed_at, response_json) VALUES (?, ?, ?)").run(draft.id, Date.now(), JSON.stringify(response));
    setDraftStatus(db, draft.id, "executed");
    return { draftId: draft.id, response };
  } catch (err) {
    setDraftStatus(db, draft.id, "failed");
    throw new GateError("upstream_error", (err as Error).message);
  }
}
