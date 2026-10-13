import { createHmac, timingSafeEqual } from "node:crypto";

const safeEqual = (a: string, b: string) => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
};

const nowSec = () => Math.floor(Date.now() / 1000);

// Inbound field-service webhooks: `x-fs-signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "<t>.<body>")>`,
// verified against the raw body with a five-minute replay window.
export function signWebhook(secret: string, rawBody: string, t = nowSec()): string {
  return `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex")}`;
}

export function verifyWebhook(secret: string, header: string | undefined, rawBody: string, now = nowSec(), toleranceSec = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || Math.abs(now - t) > toleranceSec || !parts.v1) return false;
  return safeEqual(createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex"), parts.v1);
}

// Slack request signing for the approval buttons: v0=hex(HMAC-SHA256(signing secret, "v0:<ts>:<body>")).
export function signSlack(secret: string, ts: number, rawBody: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${ts}:${rawBody}`).digest("hex")}`;
}

export function verifySlack(secret: string, tsHeader: string | undefined, sigHeader: string | undefined, rawBody: string, now = nowSec()): boolean {
  const ts = Number(tsHeader);
  if (!sigHeader || !Number.isInteger(ts) || Math.abs(now - ts) > 300) return false;
  return safeEqual(signSlack(secret, ts, rawBody), sigHeader);
}
