import crypto from "node:crypto";

// Self-authenticating download links for Recall meeting videos.
//
// Why this exists: when the agent posts a "click to download" link to
// Slack, the user's browser can't send the `x-reddy-secret` header that
// the video endpoint normally requires. So we let the URL itself carry
// a short-lived signed token (HMAC-SHA256 of botId + expiry, keyed by
// the same secret).
//
// Pattern: token = `${expiresAt}.${base64url(hmac)}`. The endpoint
// reconstructs the HMAC, timing-safe-compares, and rejects on mismatch
// or expiry. Default TTL is 1 hour — matches GitHub LFS signed URLs and
// is plenty for "click the link in Slack."

export function signVideoToken(botId: string, expiresAt: number, secret: string): string {
  const sig = crypto
    .createHmac("sha256", secret)
    .update(`${botId}.${expiresAt}`)
    .digest("base64url");
  return `${expiresAt}.${sig}`;
}

export function verifyVideoToken(
  token: string,
  botId: string,
  secret: string,
): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const exp = Number.parseInt(parts[0], 10);
  if (!Number.isFinite(exp)) return false;
  if (Math.floor(Date.now() / 1000) > exp) return false;
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${botId}.${exp}`)
    .digest("base64url");
  const a = Buffer.from(parts[1]);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Build a clickable link the agent can post to Slack. Defaults to 1h TTL.
export function buildVideoLink(opts: {
  baseUrl: string;
  botId: string;
  customer: string | null;
  secret: string;
  ttlSeconds?: number;
}): string {
  const exp = Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? 3600);
  const token = signVideoToken(opts.botId, exp, opts.secret);
  const params = new URLSearchParams({ token });
  if (opts.customer) params.set("customer", opts.customer);
  return `${opts.baseUrl}/api/recall/video/${opts.botId}?${params.toString()}`;
}
