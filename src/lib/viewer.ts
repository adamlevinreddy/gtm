// Signed viewer identity (Daybreak Phase 6). The cookie value is
// `email|hmac(email)` — server-set, httpOnly, verified on every read, so
// identity can't be silently spoofed by other scripts and the old
// "everyone is adam@" default dies at the shell.
//
// Legacy plain-email cookies (set by the pre-P6 client picker) are still
// accepted so nobody gets bounced by the upgrade; the next explicit pick
// re-sets the signed form.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";
import { ssoEnabled } from "@/lib/workos";
import { VIEWER_COOKIE } from "@/lib/team";

// Rejects '%' too: Next decodes cookie values once and we decode again, so a
// percent in the email could make the second decode throw (verified repro).
const EMAIL_RE = /^[^\s@|%]+@[^\s@|%]+\.[^\s@|%]+$/;

function secret(): string {
  return process.env.BOARD_API_SECRET || process.env.MCP_INTERNAL_SECRET || "dev-secret";
}

function hmac(email: string): string {
  return createHmac("sha256", secret()).update(email.toLowerCase()).digest("hex").slice(0, 32);
}

// Mode-bound HMAC: binds the cookie to HOW it was issued. A picker cookie
// (honor-system) can then be rejected once SSO is enforced, without touching
// the shared BOARD_API_SECRET.
export type ViewerMode = "sso" | "picker";
function modeHmac(email: string, mode: ViewerMode): string {
  return createHmac("sha256", secret()).update(`${email.toLowerCase()}|${mode}`).digest("hex").slice(0, 32);
}

export function isValidEmail(email: string): boolean {
  return EMAIL_RE.test(email);
}

/** Sign an identity cookie. `mode` records issuance channel — the SSO callback
 * passes "sso"; the honor-system picker uses the default "picker", which stops
 * verifying the moment SSO is enabled (so a cookie minted during the open
 * pre-SSO window can't outlive cutover). */
export function signViewer(email: string, mode: ViewerMode = "picker"): string {
  const e = email.toLowerCase();
  return `${e}|${mode}|${modeHmac(e, mode)}`;
}

function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** Cookie value → verified email, or null. SIGNED cookies only — unsigned
 * legacy values are rejected (they were a forgeable identity; anyone could
 * send `Cookie: board_viewer=adam@reddy.io` raw). Legacy holders just hit
 * the gate once and re-establish.
 * NEVER throws — a malformed cookie must degrade to anonymous, not 500
 * every page (Next decodes once; our second decode could throw URIError). */
export function verifyViewerCookie(value: string | undefined | null): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    const parts = decoded.split("|");
    const sso = ssoEnabled();

    // New form: email|mode|sig
    if (parts.length === 3) {
      const [email, mode, sig] = parts;
      if (!email || !sig || !isValidEmail(email)) return null;
      if (mode !== "sso" && mode !== "picker") return null;
      if (sso && mode !== "sso") return null; // picker cookie dies at SSO cutover
      return safeEq(sig, modeHmac(email, mode)) ? email.toLowerCase() : null;
    }

    // Legacy form: email|hmac(email) — pre-mode signed cookies. Accepted while
    // SSO is off so nobody gets bounced by the upgrade; rejected once SSO is
    // enforced (holders just re-auth via Google).
    if (parts.length === 2) {
      if (sso) return null;
      const [email, sig] = parts;
      if (!email || !sig || !isValidEmail(email)) return null;
      return safeEq(sig, hmac(email)) ? email.toLowerCase() : null;
    }

    return null;
  } catch {
    return null;
  }
}

/** Identity for browser-facing API routes (board mutations, meeting-chat, etc.).
 *
 * SSO ON  → identity comes ONLY from the signed cookie. `?as=` / `body.as` and
 *   the BOARD_DEFAULT_VIEWER fallback are ALL disabled, and a missing/invalid
 *   cookie returns null so the caller MUST reject (401). This is what closes
 *   the "anonymous caller runs the agent as any teammate" hole — page-level
 *   gating alone left the API layer wide open.
 * SSO OFF → honor-system, exactly as before: body.as → ?as= → signed cookie →
 *   default viewer. Never null in this mode.
 *
 * Keep every /api/board/ui/* and /api/agent/* browser route on THIS resolver —
 * a per-route copy is how the bypass crept in the first time. */
export function resolveApiViewer(req: NextRequest, bodyAs?: unknown): string | null {
  const cookie = verifyViewerCookie(req.cookies.get(VIEWER_COOKIE)?.value);
  if (ssoEnabled()) return cookie; // ?as=/body.as/default all off under SSO
  if (typeof bodyAs === "string" && bodyAs.includes("@")) return bodyAs.toLowerCase();
  const qAs = req.nextUrl.searchParams.get("as");
  if (qAs && qAs.includes("@")) return qAs.toLowerCase();
  if (cookie) return cookie;
  return (process.env.BOARD_DEFAULT_VIEWER || "adam@reddy.io").toLowerCase();
}
