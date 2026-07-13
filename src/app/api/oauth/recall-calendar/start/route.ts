import { NextRequest, NextResponse } from "next/server";
import { buildGoogleOAuthUrl } from "@/lib/recall-calendar-v2";

// Entry point for "Connect Recall Calendar (V2)" — from @Reddy-GTM set me up
// in Slack, or from the /settings connect row on the web.
// Query: ?email=<user-email>&return=settings (return optional)
//
// V2 flow: we own Google OAuth end-to-end. State carries the user's
// email so the callback can stash the resulting calendar_id by email,
// plus the return hint so web-initiated connects land back on /settings.
export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get("email");
  if (!email) {
    return new NextResponse("Missing email query param.", { status: 400 });
  }
  const returnTo = req.nextUrl.searchParams.get("return");

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
  const state = encodeURIComponent(
    JSON.stringify(returnTo === "settings" ? { email, return: returnTo } : { email }),
  );

  const url = buildGoogleOAuthUrl({ clientId, redirectUri, state });
  return NextResponse.redirect(url, 302);
}
