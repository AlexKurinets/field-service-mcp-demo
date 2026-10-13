import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export type Scope = "read" | "write" | "webhook";

// Per-tenant credentials, encrypted at rest with AES-256-GCM. The tenant and scope are bound in
// as additional authenticated data, so a ciphertext copied into another tenant's row won't decrypt.
export class Vault {
  private key: Buffer;

  constructor(private db: DatabaseSync, keyHex: string | undefined) {
    if (!keyHex || !/^[0-9a-f]{64}$/i.test(keyHex)) throw new Error("VAULT_KEY must be 32 bytes of hex");
    this.key = Buffer.from(keyHex, "hex");
  }

  put(tenant: string, scope: Scope, clientId: string, secret: string): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(`${tenant}:${scope}`));
    const enc = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
    const blob = Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
    this.db
      .prepare("INSERT OR REPLACE INTO credentials (tenant, scope, client_id, secret_enc) VALUES (?, ?, ?, ?)")
      .run(tenant, scope, clientId, blob);
  }

  get(tenant: string, scope: Scope): { clientId: string; secret: string } {
    const row = this.db
      .prepare("SELECT client_id, secret_enc FROM credentials WHERE tenant = ? AND scope = ?")
      .get(tenant, scope) as { client_id: string; secret_enc: string } | undefined;
    if (!row) throw new Error(`no ${scope} credential for ${tenant}`);
    const buf = Buffer.from(row.secret_enc, "base64");
    const decipher = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12));
    decipher.setAAD(Buffer.from(`${tenant}:${scope}`));
    decipher.setAuthTag(buf.subarray(12, 28));
    const secret = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
    return { clientId: row.client_id, secret };
  }
}
