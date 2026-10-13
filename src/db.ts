import { DatabaseSync } from "node:sqlite";

// SQLite keeps the demo self-contained. The production platform uses Postgres with a row-level
// security policy on every tenant-scoped table; here TenantDrafts plays that role in code.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS credentials (
  tenant TEXT NOT NULL, scope TEXT NOT NULL, client_id TEXT NOT NULL, secret_enc TEXT NOT NULL,
  PRIMARY KEY (tenant, scope)
);
CREATE TABLE IF NOT EXISTS approvers (
  tenant TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (tenant, user_id)
);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY, tenant TEXT NOT NULL, kind TEXT NOT NULL, action TEXT NOT NULL,
  args_json TEXT NOT NULL, payload_hash TEXT NOT NULL, run_id TEXT NOT NULL,
  status TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY, draft_id TEXT NOT NULL UNIQUE REFERENCES drafts(id), tenant TEXT NOT NULL,
  payload_hash TEXT NOT NULL, approver TEXT NOT NULL, nonce TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE IF NOT EXISTS executions (
  draft_id TEXT PRIMARY KEY REFERENCES drafts(id), executed_at INTEGER NOT NULL, response_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, received_at INTEGER NOT NULL, body TEXT NOT NULL
);
`;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  return db;
}

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
