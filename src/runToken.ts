import { SignJWT, jwtVerify } from "jose";
import { MANIFESTS } from "./manifest.js";

// The scheduler mints one of these per agent run. It is the only thing that says which tenant a
// run belongs to, and the gateway reads the tenant from here, never from tool arguments.

const ISSUER = "fieldservice-scheduler";
const AUDIENCE = "fieldservice-gateway";

export interface RunClaims {
  tenant: string;
  runId: string;
  tools: string[];
}

const keyBytes = (key: string) => new TextEncoder().encode(key);

export async function mintRunToken(signingKey: string, claims: RunClaims, ttlSec = 600): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ tenant: claims.tenant, tools: claims.tools })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(claims.runId)
    .setIssuedAt(now)
    .setExpirationTime(now + ttlSec)
    .sign(keyBytes(signingKey));
}

export async function verifyRunToken(signingKey: string, token: string): Promise<RunClaims> {
  const { payload } = await jwtVerify(token, keyBytes(signingKey), {
    issuer: ISSUER,
    audience: AUDIENCE,
    algorithms: ["HS256"],
  });
  const tenant = payload.tenant;
  if (typeof tenant !== "string" || !MANIFESTS[tenant]) throw new Error("run token names an unknown tenant");
  if (typeof payload.sub !== "string") throw new Error("run token has no run id");
  const tools = Array.isArray(payload.tools) ? payload.tools.filter((t): t is string => typeof t === "string") : [];
  return { tenant, runId: payload.sub, tools };
}

// A run gets the intersection of what its token asks for and what its tenant's manifest grants.
export function effectiveTools(claims: RunClaims): string[] {
  const granted = MANIFESTS[claims.tenant].allowedTools;
  return claims.tools.length ? claims.tools.filter((t) => granted.includes(t)) : [...granted];
}
