import crypto from "node:crypto";

// Per-user bearer tokens for the /mcp endpoint. Self-contained HMAC —
// no KV lookup required to verify. The token encodes the user's email
// and an expiry, signed with MCP_TOKEN_SECRET.
//
// Format: base64url(JSON({ email, exp })) + "." + base64url(hmac)
//
// Why bearer instead of OAuth for v1: Claude Desktop accepts a static
// `Authorization: Bearer <token>` header in MCP server config, so we
// can ship today without writing an OAuth provider. Each teammate gets
// a token, pastes it into their Claude Desktop config, done. We can
// add OAuth later for broader distribution.

type Payload = { email: string; exp: number };

function base64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function fromBase64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

function hmac(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}

export function mintMcpToken(email: string, ttlSeconds: number, secret: string): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload: Payload = { email, exp };
  const body = base64url(JSON.stringify(payload));
  const sig = hmac(body, secret);
  return `${body}.${sig}`;
}

// Verify a bearer token, return the email it identifies (or null on
// invalid / expired). Timing-safe HMAC comparison.
export function verifyMcpToken(token: string, secret: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = hmac(body, secret);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  try {
    if (!crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  let payload: Payload;
  try {
    payload = JSON.parse(fromBase64url(body).toString("utf8")) as Payload;
  } catch {
    return null;
  }
  if (!payload.email || !payload.exp) return null;
  if (Math.floor(Date.now() / 1000) > payload.exp) return null;
  return payload.email;
}
