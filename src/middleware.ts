import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";

// Auth gate (Daybreak Arc V — Clerk). Gated on the publishable key so local dev
// (no keys) stays on the honor-system picker with no Clerk involvement.
//
// SCOPE: this runs on PAGES only (see matcher). Machine endpoints are excluded
// — /api/* (webhooks, sandbox, crons: own x-board-secret/x-reddy-internal auth)
// AND /mcp (the external MCP server, which lives OUTSIDE /api and self-auths via
// a Bearer token). Gating either through Clerk would break them.
//
// /auth/sync is public here (it mints the cookie from the Clerk session and
// must be reachable before that cookie exists); every other page requires a
// signed-in Clerk user. We also stamp x-pathname so a server component can
// bounce a freshly-signed-in user to /auth/sync?next=<page>.
//
// BOTH keys required: gating the edge on the publishable key alone while
// ssoEnabled() (node) keys off the secret can diverge on a half-configured
// deploy and lock everyone into a redirect loop. Requiring both here and in
// auth.ts keeps the two gates in lockstep — a half-config falls back to the
// picker, never a loop.
const CLERK_ON = !!(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY
);

const isPublicPage = createRouteMatcher(["/auth/sync", "/auth/denied"]);

function withPathHeader(req: NextRequest): NextResponse {
  // Forward the path on the REQUEST headers (not the response) so a server
  // component can read it via headers() to build the /auth/sync return URL.
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-pathname", req.nextUrl.pathname);
  return NextResponse.next({ request: { headers: requestHeaders } });
}

export default CLERK_ON
  ? clerkMiddleware(async (auth, req) => {
      if (!isPublicPage(req)) await auth.protect();
      return withPathHeader(req);
    })
  : withPathHeader;

export const config = {
  // Pages only. Skip /api and /mcp (both self-authing machine endpoints),
  // /_next, and any file with an extension.
  matcher: ["/((?!api|mcp|_next|.*\\..*).*)"],
};
