import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = await req.json();

  // Slack URL verification challenge
  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  // Handle events asynchronously
  if (body.event) {
    const event = body.event;

    // Only respond to messages, not bot messages
    if (event.type === "message" && !event.bot_id) {
      const text = (event.text || "").toLowerCase().trim();

      if (text.startsWith("check ")) {
        const companyName = event.text.slice(6).trim();
        const baseUrl = process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : "http://localhost:3000";

        // Fire-and-forget to classify endpoint
        fetch(`${baseUrl}/api/classify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: "quick",
            company: companyName,
            slackThreadTs: event.ts,
          }),
        }).catch(() => {
          // Swallow — we already ack'd Slack
        });
      }
    }
  }

  // Always ack within 3 seconds
  return NextResponse.json({ ok: true });
}
