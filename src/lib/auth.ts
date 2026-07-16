// Enforced auth mode (Daybreak Arc V — Clerk via the Vercel Marketplace).
//
// When the Clerk keys are present (production), the app requires a real Google
// sign-in restricted to @reddy.io. Clerk owns ONLY the sign-in gate and the
// one-time cookie mint at /auth/sync — after that, the entire app + API layer
// keep reading identity from our signed `board_viewer` cookie exactly as
// before. That keeps resolveApiViewer synchronous and the hot path free of any
// per-request Clerk call. When the keys are absent (local dev) the honor-system
// picker gate applies.
//
// Env (set by the Clerk Vercel integration):
//   CLERK_SECRET_KEY                  — server signal for enforced mode
//   NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY — edge/middleware + provider signal
//   SSO_ALLOWED_DOMAIN (optional)     — defaults to reddy.io

import { currentUser } from "@clerk/nextjs/server";

export const ALLOWED_DOMAIN = process.env.SSO_ALLOWED_DOMAIN || "reddy.io";

/** True when enforced SSO (Clerk) is configured. Named `ssoEnabled` for
 * continuity with the identity gate used throughout the app.
 *
 * Requires BOTH keys: the middleware/edge gate keys off the publishable key and
 * this node gate off the secret. If they can disagree (one key set, the other
 * not), a half-configured deploy locks everyone into a /auth/sync redirect loop.
 * Gating both on the presence of both keys keeps them in lockstep — a partial
 * config falls back to the honor-system picker instead. */
export function ssoEnabled(): boolean {
  return !!(process.env.CLERK_SECRET_KEY && process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY);
}

/** The signed-in Clerk user's email (lowercased) — only if on the allowed
 * domain. null when signed out / wrong domain / Clerk off. Requires
 * clerkMiddleware on the request (true for pages + the /auth/sync route). */
export async function clerkViewerEmail(): Promise<string | null> {
  if (!ssoEnabled()) return null;
  try {
    const u = await currentUser();
    const email = u?.primaryEmailAddress?.emailAddress?.toLowerCase() ?? null;
    return email && email.endsWith(`@${ALLOWED_DOMAIN}`) ? email : null;
  } catch {
    return null;
  }
}
