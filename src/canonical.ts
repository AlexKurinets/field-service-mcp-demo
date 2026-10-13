import { createHash } from "node:crypto";

// Canonical JSON: sorted keys, NFC strings, undefined dropped, -0 folded to 0. Two payloads that
// mean the same thing hash the same, and changing any value changes the hash.
export function canonicalize(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(v: unknown): unknown {
  if (v === null) return null;
  if (typeof v === "string") return v.normalize("NFC");
  if (typeof v === "boolean") return v;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number in payload");
    return Object.is(v, -0) ? 0 : v;
  }
  if (Array.isArray(v)) return v.map(normalize);
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = normalize(val);
    }
    return out;
  }
  throw new Error(`unsupported value in payload: ${typeof v}`);
}

export interface Payload {
  tenant: string;
  action: string;
  args: Record<string, unknown>;
}

// What an approval is bound to: tenant, action and the full argument object.
export function payloadHash(p: Payload): string {
  return createHash("sha256")
    .update(canonicalize({ v: 1, tenant: p.tenant, action: p.action, args: p.args }))
    .digest("hex");
}
