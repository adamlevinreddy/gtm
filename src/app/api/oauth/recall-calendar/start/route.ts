import { NextRequest, NextResponse } from "next/server";
import { buildGoogleOAuthUrl } from "@/lib/recall-calendar-v2";

// Entry point for "Connect Recall Calendar (V2)" from @Reddy-GTM set me up.
// Query: ?email=<slack-email>
//
// V2 flow: we own Google OAuth end-to-end. State carries the user's
// email so the callback can stash the resulting calendar_id by email.
export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get("email");
  if (!email) {
    return new NextResponse("Missing email query param.", { status: 400 });
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return new NextResponse(
      "GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET must both be set in Vercel env (V2 calendar requires us to do the token exchange ourselves).",
      { status: 500 },
    );
  }

  const baseUrl = process.env.PUBLIC_BASE_URL ?? req.nextUrl.origin;
  const redirectUri = `${baseUrl}/api/oauth/recall-calendar/callback`;
  // State carries email so the callback can attribute the new calendar.
  // Plain JSON in state is fine — Google passes it through verbatim.
  const state = encodeURIComponent(JSON.stringify({ email }));

  const url = buildGoogleOAuthUrl({ clientId, redirectUri, state });
  return NextResponse.redirect(url, 302);
}
