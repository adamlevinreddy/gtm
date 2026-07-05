import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse, type NextRequest } from "next/server";

// Auth gate (Daybreak Arc V — Clerk). Gated on the publishable key so local dev
// (no keys) stays on the honor-system picker with no Clerk involvement.
//
// SCOPE: this runs on PAGES only (see matcher). API routes are deliberately
// excluded — they carry their own auth (browser board/ui routes gate on the
// signed cookie; machine routes on x-board-secret / x-reddy-internal), and
// gating them through Clerk would break webhooks, the sandbox, and crons.
//
// /auth/sync is public here (it mints the cookie from the Clerk session and
// must be reachable before that cookie exists); every other page requires a
// signed-in Clerk user. We also stamp x-pathname so a server component can
// bounce a freshly-signed-in user to /auth/sync?next=<page>.

const CLERK_ON = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

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
  // Pages only. Skip /api (own auth), /_next, and any file with an extension.
  matcher: ["/((?!api|_next|.*\\..*).*)"],
};
