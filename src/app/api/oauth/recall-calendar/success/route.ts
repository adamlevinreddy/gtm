import { NextRequest, NextResponse } from "next/server";
import { applyDefaultPreferences } from "@/lib/recall-calendar";

// Final stop after Recall finishes the Google OAuth dance. Two things
// happen here:
//   1. Apply our team's default recording preferences to the just-
//      connected calendar user (using the JWT we threaded through the
//      success_url).
//   2. Render a "you're connected" page the user can close.
//
// On error path (?error=1), just render the failure page.
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const email = url.searchParams.get("email");
  const error = url.searchParams.get("error");
  const jwt = url.searchParams.get("jwt");

  if (error) {
    return htmlPage({
      ok: false,
      title: "Recall calendar connection failed",
      message:
        "Google or Recall returned an error during authorization. Head back to Slack and try @Reddy-GTM set me up again.",
    });
  }

  if (!email || !jwt) {
    return htmlPage({
      ok: false,
      title: "Invalid callback",
      message: "Missing email or jwt — please restart the connect flow from Slack.",
    });
  }

  // Apply team defaults. Failure here doesn't block the user — they're
  // already calendar-connected; preferences just stay at Recall defaults
  // until we (or they) update them.
  let prefsApplied = true;
  try {
    await applyDefaultPreferences(jwt, email);
  } catch (err) {
    prefsApplied = false;
    console.warn(
      `[oauth/recall-calendar/success] applyDefaultPreferences failed for ${email}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return htmlPage({
    ok: true,
    title: "Calendar connected",
    message: prefsApplied
      ? `You're all set, ${email}. Reddy Notetaker will join external + internal meetings on your accepted calendar invites and post the recording + transcript to the team's knowledge base.`
      : `You're connected, ${email}, but I couldn't apply the default recording preferences. Ping Adam — preferences will need to be set manually in the Recall dashboard.`,
  });
}

function htmlPage({
  ok,
  title,
  message,
}: {
  ok: boolean;
  title: string;
  message: string;
}): NextResponse {
  const color = ok ? "#10b981" : "#ef4444";
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>${escapeHtml(title)} · Reddy</title>
  <style>
    html, body { margin: 0; padding: 0; height: 100%; background: #0a0a0a; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
    body { display: flex; align-items: center; justify-content: center; padding: 2rem; }
    .card { background: #141414; border: 1px solid #222; border-radius: 16px; max-width: 460px; padding: 2rem; text-align: center; }
    .dot { width: 10px; height: 10px; border-radius: 50%; background: ${color}; display: inline-block; margin-right: 8px; vertical-align: middle; }
    h1 { font-size: 1.25rem; margin: 0 0 0.75rem 0; font-weight: 600; }
    p { color: #b3b3b3; line-height: 1.55; margin: 0.5rem 0; }
    .close { font-size: 0.8rem; color: #666; margin-top: 1.75rem; }
  </style>
</head>
<body>
  <div class="card">
    <h1><span class="dot"></span>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    <p class="close">You can close this tab.</p>
  </div>
</body>
</html>`;
  return new NextResponse(html, {
    status: ok ? 200 : 400,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
