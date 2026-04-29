import { NextRequest, NextResponse } from "next/server";
import {
  exchangeGoogleCode,
  getGoogleUserEmail,
  createRecallCalendar,
  kvLinkCalendarToEmail,
  kvLookupCalendarForEmail,
  disconnectRecallCalendar,
} from "@/lib/recall-calendar-v2";

// Google's OAuth redirect lands here after the user consents. V2 model:
// we own the token exchange, register the calendar with Recall by POSTing
// to /api/v2/calendars/, and stash {email -> calendar_id} in KV so future
// webhooks can be attributed to a teammate.
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const stateRaw = url.searchParams.get("state");
  const errParam = url.searchParams.get("error");

  if (errParam) {
    return new NextResponse(`Google OAuth error: ${errParam}`, { status: 400 });
  }
  if (!code || !stateRaw) {
    return new NextResponse("Missing code/state from Google.", { status: 400 });
  }

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return new NextResponse("Server misconfigured: GOOGLE_OAUTH_CLIENT_ID/SECRET missing.", { status: 500 });
  }

  let stateEmail: string | null = null;
  try {
    const parsed = JSON.parse(decodeURIComponent(stateRaw)) as { email?: string };
    stateEmail = parsed.email ?? null;
  } catch {
    // fall through with null
  }

  const baseUrl = process.env.PUBLIC_BASE_URL ?? url.origin;
  const redirectUri = `${baseUrl}/api/oauth/recall-calendar/callback`;

  try {
    const { refreshToken, accessToken } = await exchangeGoogleCode({
      code,
      clientId,
      clientSecret,
      redirectUri,
    });
    const googleEmail = await getGoogleUserEmail(accessToken);
    const email = googleEmail ?? stateEmail ?? null;
    if (!email) {
      return new NextResponse(
        "Could not determine the connecting user's email (state was missing and userinfo failed).",
        { status: 400 },
      );
    }

    // If this email already has a calendar registered, drop the old one
    // before registering a new one — keeps the "one calendar per user"
    // invariant Recall can't enforce on its own.
    const existing = await kvLookupCalendarForEmail(email);
    if (existing) {
      await disconnectRecallCalendar(existing).catch((err) => {
        console.warn(
          `[recall-calendar/callback] failed to disconnect old calendar ${existing} for ${email}: ${err instanceof Error ? err.message : err}`,
        );
      });
    }

    const { id: calendarId } = await createRecallCalendar({
      clientId,
      clientSecret,
      refreshToken,
    });
    await kvLinkCalendarToEmail(calendarId, email);

    const successUrl = `${baseUrl}/api/oauth/recall-calendar/success?email=${encodeURIComponent(email)}&calendar_id=${encodeURIComponent(calendarId)}`;
    return NextResponse.redirect(successUrl, 302);
  } catch (err) {
    console.error(
      `[recall-calendar/callback] failed: ${err instanceof Error ? err.stack || err.message : String(err)}`,
    );
    return new NextResponse(
      `Failed to register calendar with Recall: ${err instanceof Error ? err.message : String(err)}`,
      { status: 500 },
    );
  }
}
