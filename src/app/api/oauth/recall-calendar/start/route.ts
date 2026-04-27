import { NextRequest, NextResponse } from "next/server";
import { mintCalendarAuthToken, buildGoogleOAuthUrl } from "@/lib/recall-calendar";

// Entry point for "Connect Recall Calendar" from @Reddy-GTM set me up.
// Query: ?email=<slack-email>
//
// We mint a per-user Recall JWT, build the Google OAuth URL with state
// carrying the JWT + our success/error redirects, and 302 the user to
// Google.
export async function GET(req: NextRequest) {
  const email = req.nextUrl.searchParams.get("email");
  if (!email) {
    return new NextResponse("Missing email query param.", { status: 400 });
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  if (!clientId) {
    return new NextResponse(
      "GOOGLE_OAUTH_CLIENT_ID not configured. Paste your Google OAuth Client ID into Vercel env.",
      { status: 500 },
    );
  }

  const baseUrl = process.env.PUBLIC_BASE_URL ?? req.nextUrl.origin;
  const redirectUri = `${baseUrl}/api/oauth/recall-calendar/callback`;
  const successUrl = `${baseUrl}/api/oauth/recall-calendar/success?email=${encodeURIComponent(email)}`;
  const errorUrl = `${baseUrl}/api/oauth/recall-calendar/success?email=${encodeURIComponent(email)}&error=1`;

  try {
    const jwt = await mintCalendarAuthToken(email);
    // Pass the JWT to /success via the state-encoded success_url so we can
    // PUT default preferences after Recall completes the OAuth dance.
    const successWithJwt = `${successUrl}&jwt=${encodeURIComponent(jwt)}`;
    const url = buildGoogleOAuthUrl({
      clientId,
      redirectUri,
      jwt,
      successUrl: successWithJwt,
      errorUrl,
    });
    return NextResponse.redirect(url, 302);
  } catch (err) {
    console.error(
      `[oauth/recall-calendar/start] failed for ${email}: ${err instanceof Error ? err.stack || err.message : String(err)}`,
    );
    return new NextResponse(
      `Failed to start Recall calendar auth: ${err instanceof Error ? err.message : String(err)}`,
      { status: 500 },
    );
  }
}
