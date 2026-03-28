import { NextRequest, NextResponse } from "next/server";
import { WebClient } from "@slack/web-api";
import { CompanyClassifier } from "@/lib/classifier";
import { fetchCompanyLists } from "@/lib/github";
import { sendQuickClassification, sendReviewNotification } from "@/lib/slack";
import { parseUploadedFile } from "@/lib/parse-upload";
import { classifyWithAgent } from "@/lib/agent";
import { createReview } from "@/lib/kv";
import type { ClassificationResult, ReviewItem } from "@/lib/types";

export const maxDuration = 300; // 5 min for file processing

function getSlackClient() {
  return new WebClient(process.env.SLACK_BOT_TOKEN);
}

async function addReaction(channel: string, timestamp: string, emoji: string) {
  try {
    await getSlackClient().reactions.add({ channel, name: emoji, timestamp });
  } catch {
    // Reaction may already exist or fail — non-critical
  }
}

async function replyInThread(channel: string, threadTs: string, text: string) {
  await getSlackClient().chat.postMessage({ channel, thread_ts: threadTs, text });
}

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
      const rawText = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
      const text = rawText.toLowerCase();
      const channel = event.channel;

      // --- QUICK CHECK: "@GTM Classifier check <company>" ---
      if (text.startsWith("check ")) {
        const companyName = rawText.slice(6).trim();
        await addReaction(channel, event.ts, "eyes");

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
          await addReaction(channel, event.ts, "white_check_mark");
        } catch {
          await addReaction(channel, event.ts, "x");
        }
      }

      // --- FILE UPLOAD: "@GTM Classifier classify this" with file attached ---
      else if (text.includes("classify") && event.files && event.files.length > 0) {
        await addReaction(channel, event.ts, "hourglass_flowing_sand");
        await replyInThread(channel, event.ts, "Got it — processing your list. I'll send a review link when ready.");

        try {
          const file = event.files[0];
          const slack = getSlackClient();

          // Download the file from Slack
          const fileResponse = await fetch(file.url_private_download || file.url_private, {
            headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
          });
          const rawBuffer = Buffer.from(await fileResponse.arrayBuffer());

          // Decrypt if password-protected
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          const officeCrypto = require("officecrypto-tool") as {
            isEncrypted: (buf: Buffer) => boolean;
            decrypt: (buf: Buffer, opts: { password: string }) => Promise<Buffer>;
          };
          let fileBuffer: Buffer = rawBuffer;
          if (officeCrypto.isEncrypted(rawBuffer)) {
            const passwordMatch = rawText.match(/password\s+(?:is\s+)?["""']?([^"""'\s,]+)/i);
            const password = passwordMatch ? passwordMatch[1] : undefined;
            if (!password) {
              await replyInThread(channel, event.ts, "This file is password-protected. Please include the password in your message, e.g. `@GTM Classifier classify this, the password is MyPassword`");
              await addReaction(channel, event.ts, "x");
              return NextResponse.json({ ok: true });
            }
            fileBuffer = await officeCrypto.decrypt(rawBuffer, { password });
          }

          // Parse the file
          const companies = await parseUploadedFile(fileBuffer, file.name || "upload.xlsx");

          // Extract source name from filename
          const source = (file.name || "upload").replace(/\.[^.]+$/, "");

          // Classify
          const lists = await fetchCompanyLists();
          const classifier = new CompanyClassifier(lists.exclusions, lists.tags, lists.prospects);

          const knownResults: ClassificationResult[] = [];
          const unknowns: typeof companies = [];

          for (const company of companies) {
            const known = classifier.classifyKnown(company.name);
            if (known) {
              knownResults.push(known);
            } else {
              unknowns.push(company);
            }
          }

          // Classify unknowns with Claude agent
          let agentResults: ClassificationResult[] = [];
          if (unknowns.length > 0) {
            try {
              agentResults = await classifyWithAgent(unknowns);
            } catch {
              await replyInThread(channel, event.ts, "Note: Claude agent classification failed for unknown companies. Showing known matches only.");
            }
          }

          const reviewItems: ReviewItem[] = agentResults.map((r) => {
            const companyData = unknowns.find((u) => u.name === r.name);
            return {
              name: r.name,
              titles: companyData?.titles || [],
              action: r.action,
              category: r.category,
              rationale: r.rationale,
            };
          });

          // Store in KV
          const reviewId = await createReview({ source, items: reviewItems, knownResults });

          const excludedCount = knownResults.filter((r) => r.action === "exclude").length;
          const taggedCount = knownResults.filter((r) => r.action === "tag").length;
          const prospectCount = knownResults.filter((r) => r.action === "prospect").length;

          // Send review notification to channel
          await sendReviewNotification({
            reviewId,
            source,
            totalCompanies: companies.length,
            knownMatches: knownResults.length,
            needsReview: reviewItems.length,
            excludedCompanies: excludedCount,
            taggedCompanies: taggedCount,
            prospectCompanies: prospectCount,
          });

          await addReaction(channel, event.ts, "white_check_mark");
        } catch (err) {
          await addReaction(channel, event.ts, "x");
          await replyInThread(channel, event.ts, `Error processing file: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
      }

      // --- UNKNOWN COMMAND ---
      else {
        await replyInThread(channel, event.ts,
          "I can help with:\n" +
          "• `@GTM Classifier check <company>` — check if a company is a vendor/prospect\n" +
          "• `@GTM Classifier classify this` — attach a CSV/XLSX file to classify a list"
        );
      }
    }
  }

  return NextResponse.json({ ok: true });
}
