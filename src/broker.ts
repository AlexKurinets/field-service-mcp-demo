import type { Vault } from "./vault.js";
import { manifestFor } from "./manifest.js";
import { MOCK_APP_KEY } from "./mockApi.js";
import type { TokenSource } from "./stClient.js";

// Mints and caches short-lived API access tokens per tenant and scope, refreshing ahead of expiry.
// Only the gateway process holds the vault key, so this class never runs inside an agent run.
export class CredentialBroker {
  refreshes = 0;
  private cache = new Map<string, { accessToken: string; expiresAt: number }>();
  private inflight = new Map<string, Promise<{ accessToken: string; expiresAt: number }>>();

  constructor(private vault: Vault, private apiUrl: string, private marginSec = 60) {}

  async accessToken(tenant: string, scope: "read" | "write"): Promise<{ accessToken: string; expiresAt: number }> {
    const key = `${tenant}:${scope}`;
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt - this.marginSec * 1000 > Date.now()) return hit;
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const p = (async () => {
      const { clientId, secret } = this.vault.get(tenant, scope);
      const res = await fetch(`${this.apiUrl}/connect/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "client_credentials", client_id: clientId, client_secret: secret }),
      });
      if (!res.ok) throw new Error(`token request for ${tenant}/${scope} failed with ${res.status}`);
      const body = (await res.json()) as { access_token: string; expires_in: number };
      const entry = { accessToken: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
      this.cache.set(key, entry);
      this.refreshes++;
      return entry;
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  invalidate(tenant: string, scope: "read" | "write"): void {
    this.cache.delete(`${tenant}:${scope}`);
  }

  tokenSource(tenant: string, scope: "read" | "write"): TokenSource {
    const { stTenantId } = manifestFor(tenant);
    return {
      get: async () => ({ accessToken: (await this.accessToken(tenant, scope)).accessToken, stTenantId, appKey: MOCK_APP_KEY }),
      invalidate: () => this.invalidate(tenant, scope),
    };
  }
}
