import { NextRequest, NextResponse } from "next/server";
import { beginAuthorize } from "@/lib/granola";

// Entry point for the per-user Granola OAuth flow. Hit from a Slack link
// generated in the "@Reddy-GTM set me up" message. Query params:
//   - email: the Slack user's email (canonical user_id across Reddy-GTM)
//
// We generate PKCE + state, stash them in KV, and 302 the user to
// Granola's authorize endpoint. Callback returns to
// /api/oauth/granola/callback.
export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get("email");
  if (!email) {
    return new NextResponse("Missing email query param.", { status: 400 });
  }

  const origin = req.nextUrl.origin;
  try {
    const { authUrl } = await beginAuthorize(email, origin);
    return NextResponse.redirect(authUrl, 302);
  } catch (err) {
    console.error(
      `[oauth/granola/start] failed for ${email}: ${err instanceof Error ? err.stack || err.message : String(err)}`,
    );
    return new NextResponse(
      `Failed to start Granola auth: ${err instanceof Error ? err.message : String(err)}`,
      { status: 500 },
    );
  }
}
