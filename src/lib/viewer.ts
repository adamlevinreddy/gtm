// Signed viewer identity (Daybreak Phase 6). The cookie value is
// `email|hmac(email)` — server-set, httpOnly, verified on every read, so
// identity can't be silently spoofed by other scripts and the old
// "everyone is adam@" default dies at the shell.
//
// Legacy plain-email cookies (set by the pre-P6 client picker) are still
// accepted so nobody gets bounced by the upgrade; the next explicit pick
// re-sets the signed form.

import { createHmac, timingSafeEqual } from "node:crypto";

// Rejects '%' too: Next decodes cookie values once and we decode again, so a
// percent in the email could make the second decode throw (verified repro).
const EMAIL_RE = /^[^\s@|%]+@[^\s@|%]+\.[^\s@|%]+$/;

function secret(): string {
  return process.env.BOARD_API_SECRET || process.env.MCP_INTERNAL_SECRET || "dev-secret";
}

function hmac(email: string): string {
  return createHmac("sha256", secret()).update(email.toLowerCase()).digest("hex").slice(0, 32);
}

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

export function signViewer(email: string): string {
  return `${email.toLowerCase()}|${hmac(email)}`;
}

/** Cookie value → verified email, or null. Accepts legacy plain emails.
 * NEVER throws — a malformed cookie must degrade to anonymous, not 500
 * every page (Next decodes once; our second decode could throw URIError). */
export function verifyViewerCookie(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    const [email, sig] = decoded.split("|");
    if (!email || !isValidEmail(email)) return null;
    if (!sig) return email.toLowerCase(); // legacy unsigned cookie
    const expected = hmac(email);
    return timingSafeEqual(Buffer.from(sig), Buffer.from(expected)) ? email.toLowerCase() : null;
  } catch {
    return null;
  }
}
