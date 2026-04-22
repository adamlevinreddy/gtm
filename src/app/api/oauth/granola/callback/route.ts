import { NextRequest, NextResponse } from "next/server";
import { completeAuthorize } from "@/lib/granola";

// OAuth callback. Granola redirects here with ?code=... &state=... after
// the user approves. We exchange the code for access + refresh tokens,
// persist them against the Slack email that started the flow, and render
// a "you're connected" page the user can close.
export async function GET(req: NextRequest) {
  const url = req.nextUrl;
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  const errorDescription = url.searchParams.get("error_description");

  if (error) {
    return htmlPage({
      ok: false,
      title: "Granola connection failed",
      message: errorDescription || error,
    });
  }
  if (!code || !state) {
    return htmlPage({
      ok: false,
      title: "Invalid callback",
      message: "Missing code or state — please restart the connect flow from Slack.",
    });
  }

  try {
    const { email } = await completeAuthorize(state, code, url.origin);
    return htmlPage({
      ok: true,
      title: "Granola connected",
      message: `You're all set, ${email}. Head back to Slack — Reddy-GTM now has access to your Granola meetings.`,
    });
  } catch (err) {
    console.error(
      `[oauth/granola/callback] failed: ${err instanceof Error ? err.stack || err.message : String(err)}`,
    );
    return htmlPage({
      ok: false,
      title: "Granola connection failed",
      message: err instanceof Error ? err.message : String(err),
    });
  }
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
    .card { background: #141414; border: 1px solid #222; border-radius: 16px; max-width: 440px; padding: 2rem; text-align: center; }
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
