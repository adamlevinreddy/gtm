// WorkOS AuthKit SSO (Daybreak Arc V). When configured, the app requires a
// real sign-in with a reddy.io Google account before ANYTHING renders; the
// authenticated email becomes the signed viewer cookie. When the env vars
// are absent, everything falls back to the picker gate — deploys stay green
// until the WorkOS dashboard is set up.
//
// Required env (Vercel):
//   WORKOS_API_KEY     — from the WorkOS dashboard (API Keys)
//   WORKOS_CLIENT_ID   — same page
// Redirect URI to register in WorkOS: {PUBLIC_BASE_URL}/api/auth/callback

import { WorkOS } from "@workos-inc/node";

export function ssoEnabled(): boolean {
  return !!(process.env.WORKOS_API_KEY && process.env.WORKOS_CLIENT_ID);
}

export const ALLOWED_DOMAIN = process.env.SSO_ALLOWED_DOMAIN || "reddy.io";

function client(): WorkOS {
  return new WorkOS(process.env.WORKOS_API_KEY!, { clientId: process.env.WORKOS_CLIENT_ID! });
}

export function redirectUri(): string {
  const base = process.env.PUBLIC_BASE_URL ?? "https://gtm-jet.vercel.app";
  return `${base}/api/auth/callback`;
}

export function authorizationUrl(state?: string): string {
  return client().userManagement.getAuthorizationUrl({
    provider: "authkit",
    clientId: process.env.WORKOS_CLIENT_ID!,
    redirectUri: redirectUri(),
    ...(state ? { state } : {}),
  });
}

/** Exchange the callback code → the authenticated email, or null. */
export async function emailFromCode(code: string): Promise<string | null> {
  try {
    const { user } = await client().userManagement.authenticateWithCode({
      clientId: process.env.WORKOS_CLIENT_ID!,
      code,
    });
    return user?.email?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}
