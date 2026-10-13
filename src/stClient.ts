// Minimal client for the field-service API. The tenant ID in every URL comes from the token
// source, which the gateway resolved from the run token. Tool arguments never supply it.

export interface ApiToken { accessToken: string; stTenantId: number; appKey: string }

export interface TokenSource {
  get(): Promise<ApiToken>;
  invalidate(): void;
}

// Per-tenant token bucket, so one tenant's burst can't spend another tenant's rate limit.
export class TokenBucket {
  private tokens: number;
  private last = Date.now();

  constructor(private ratePerSec: number, private burst: number) {
    this.tokens = burst;
  }

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await sleep(Math.ceil(((1 - this.tokens) / this.ratePerSec) * 1000));
    }
  }
}

const buckets = new Map<string, TokenBucket>();

export function bucketFor(tenant: string, ratePerSec: number): TokenBucket {
  let b = buckets.get(tenant);
  if (!b) {
    b = new TokenBucket(ratePerSec, ratePerSec);
    buckets.set(tenant, b);
  }
  return b;
}

export function resetBuckets(): void {
  buckets.clear();
}

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

type Query = Record<string, string | number | undefined>;

export class StClient {
  constructor(private baseUrl: string, private tokens: TokenSource, private bucket: TokenBucket) {}

  // Returns null on 404 so tools can report "not found" without an exception.
  async get<T>(area: string, path: string, query: Query = {}): Promise<T | null> {
    const res = await this.request("GET", area, path, query);
    if (res.status === 404) return null;
    return (await res.json()) as T;
  }

  async post<T>(area: string, path: string, body: unknown, idempotencyKey: string): Promise<T> {
    const res = await this.request("POST", area, path, {}, body, idempotencyKey);
    return (await res.json()) as T;
  }

  private async request(method: string, area: string, path: string, query: Query, body?: unknown, idempotencyKey?: string): Promise<Response> {
    let refreshed = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.bucket.take();
      const tok = await this.tokens.get();
      const url = new URL(`${this.baseUrl}/${area}/v2/tenant/${tok.stTenantId}${path}`);
      for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
      const headers: Record<string, string> = { authorization: `Bearer ${tok.accessToken}`, "st-app-key": tok.appKey };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
      const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      if (res.status === 401 && !refreshed) {
        // Token revoked or expired early: drop it, fetch a fresh one once, retry.
        refreshed = true;
        this.tokens.invalidate();
        continue;
      }
      if (res.status === 429) {
        await sleep(Number(res.headers.get("retry-after") ?? 1) * 1000);
        continue;
      }
      if (res.ok || res.status === 404) return res;
      throw new ApiError(res.status, `${method} ${url.pathname} failed with ${res.status}`);
    }
    throw new ApiError(429, `${method} ${path} still rate limited after retries`);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
