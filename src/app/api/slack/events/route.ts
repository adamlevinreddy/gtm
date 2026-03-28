import { NextRequest, NextResponse } from "next/server";
import { CompanyClassifier } from "@/lib/classifier";
import { fetchCompanyLists } from "@/lib/github";
import { sendQuickClassification } from "@/lib/slack";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = await req.json();

  // Slack URL verification challenge
  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  // Handle events
  if (body.event) {
    const event = body.event;

    // Only respond when the bot is @mentioned
    if (event.type === "app_mention" && !event.bot_id) {
      // Strip the bot mention (<@BOTID>) from the text
      const rawText = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
      const text = rawText.toLowerCase();

      if (text.startsWith("check ")) {
        const companyName = rawText.slice(6).trim();

        try {
          const lists = await fetchCompanyLists();
          const classifier = new CompanyClassifier(
            lists.exclusions,
            lists.tags,
            lists.prospects
          );

          const result = classifier.classifyKnown(companyName);

          await sendQuickClassification({
            companyName,
            action: result?.action || "unknown",
            category: result?.category || null,
            confidence: result?.confidence || "none",
            threadTs: event.ts,
          });
        } catch {
          // Silently fail — don't break the ack
        }
      }
    }
  }

  return NextResponse.json({ ok: true });
}
