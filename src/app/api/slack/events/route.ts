import { NextRequest, NextResponse } from "next/server";
import { WebClient } from "@slack/web-api";
import { CompanyClassifier } from "@/lib/classifier";
import { fetchCompanyLists } from "@/lib/github";
import { sendQuickClassification } from "@/lib/slack";
import { parseUploadedFile } from "@/lib/parse-upload";
import { classifyWithAgent } from "@/lib/agent";
import { createReview } from "@/lib/kv";
import type { ClassificationResult, ReviewItem } from "@/lib/types";

export const maxDuration = 300;

// Simple deduplication — track event IDs we've already processed
const processedEvents = new Set<string>();

function getSlackClient() {
  return new WebClient(process.env.SLACK_BOT_TOKEN);
}

async function addReaction(channel: string, timestamp: string, emoji: string) {
  try {
    await getSlackClient().reactions.add({ channel, name: emoji, timestamp });
  } catch {
    // Reaction may already exist
  }
}

async function removeReaction(channel: string, timestamp: string, emoji: string) {
  try {
    await getSlackClient().reactions.remove({ channel, name: emoji, timestamp });
  } catch {
    // Reaction may not exist
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

  // Deduplicate — Slack retries if we're slow
  const eventId = body.event_id || body.event?.client_msg_id || body.event?.ts;
  if (eventId && processedEvents.has(eventId)) {
    return NextResponse.json({ ok: true });
  }
  if (eventId) {
    processedEvents.add(eventId);
    // Clean up old entries after 5 minutes to avoid memory leak
    setTimeout(() => processedEvents.delete(eventId), 5 * 60 * 1000);
  }

  if (body.event) {
    const event = body.event;

    if (event.type === "app_mention" && !event.bot_id) {
      const rawText = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
      const text = rawText.toLowerCase();
      const channel = event.channel;

      // --- QUICK CHECK ---
      if (text.startsWith("check ")) {
        const companyName = rawText.slice(6).trim();
        await addReaction(channel, event.ts, "eyes");

        try {
          const lists = await fetchCompanyLists();
          const classifier = new CompanyClassifier(lists.exclusions, lists.tags, lists.prospects);
          const result = classifier.classifyKnown(companyName);

          await sendQuickClassification({
            companyName,
            action: result?.action || "unknown",
            category: result?.category || null,
            confidence: result?.confidence || "none",
            threadTs: event.ts,
          });
          await removeReaction(channel, event.ts, "eyes");
          await addReaction(channel, event.ts, "white_check_mark");
        } catch {
          await removeReaction(channel, event.ts, "eyes");
          await addReaction(channel, event.ts, "x");
        }
      }

      // --- FILE CLASSIFICATION ---
      else if (text.includes("classify")) {
        let files = event.files;
        if (!files || files.length === 0) {
          try {
            const msgResult = await getSlackClient().conversations.history({
              channel, latest: event.ts, inclusive: true, limit: 1,
            });
            files = msgResult.messages?.[0]?.files;
          } catch {
            // Fall through
          }
        }

        if (!files || files.length === 0) {
          await replyInThread(channel, event.ts, "I don't see a file attached. Upload a CSV or XLSX in the same message.");
          return NextResponse.json({ ok: true });
        }

        await addReaction(channel, event.ts, "hourglass_flowing_sand");
        await replyInThread(channel, event.ts, ":hourglass_flowing_sand: Processing your list...");

        try {
          const file = files[0];

          // Download file from Slack
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
              await replyInThread(channel, event.ts, "This file is password-protected. Include the password: `@GTM Classifier classify this, the password is MyPassword`");
              await removeReaction(channel, event.ts, "hourglass_flowing_sand");
              await addReaction(channel, event.ts, "x");
              return NextResponse.json({ ok: true });
            }
            fileBuffer = await officeCrypto.decrypt(rawBuffer, { password });
          }

          // Parse
          const companies = await parseUploadedFile(fileBuffer, file.name || "upload.xlsx");
          const source = (file.name || "upload").replace(/\.[^.]+$/, "");

          // Classify known
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

          // Classify unknowns with Claude Agent in Vercel Sandbox
          let agentResults: ClassificationResult[] = [];
          if (unknowns.length > 0) {
            try {
              await replyInThread(channel, event.ts, `:brain: Classifying ${unknowns.length} unknown companies with Claude...`);
              agentResults = await classifyWithAgent(unknowns);
            } catch (agentErr) {
              const errMsg = agentErr instanceof Error ? agentErr.message : String(agentErr);
              await replyInThread(channel, event.ts, `:warning: Agent classification failed: ${errMsg.slice(0, 500)}`);
            }
          }

          const reviewItems: ReviewItem[] = agentResults.map((r) => {
            const companyData = unknowns.find((u) => u.name === r.name);
            return {
              name: r.name, titles: companyData?.titles || [],
              action: r.action, category: r.category, rationale: r.rationale,
            };
          });

          // Store in KV
          const reviewId = await createReview({ source, items: reviewItems, knownResults });

          // Build clean summary
          const excluded = knownResults.filter((r) => r.action === "exclude");
          const tagged = knownResults.filter((r) => r.action === "tag");
          const prospects = knownResults.filter((r) => r.action === "prospect");

          const baseUrl = "https://gtm-jet.vercel.app";

          let summary = `:white_check_mark: *Classification complete: ${source}*\n\n`;
          summary += `> *${companies.length}* companies processed\n`;
          summary += `> :no_entry: *${excluded.length}* vendors excluded\n`;
          summary += `> :label: *${tagged.length}* tagged for different outreach (BPO/Media)\n`;
          summary += `> :bust_in_silhouette: *${prospects.length}* known prospects\n`;
          summary += `> :mag: *${unknowns.length}* unknown — ${agentResults.length > 0 ? "classified by Claude" : "needs classification"}\n`;

          summary += `\n<${baseUrl}/review/${reviewId}|View full results & review>`;

          await replyInThread(channel, event.ts, summary);

          // Swap hourglass for checkmark
          await removeReaction(channel, event.ts, "hourglass_flowing_sand");
          await addReaction(channel, event.ts, "white_check_mark");
        } catch (err) {
          await removeReaction(channel, event.ts, "hourglass_flowing_sand");
          await addReaction(channel, event.ts, "x");
          await replyInThread(channel, event.ts, `Error: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
      }

      // --- UNKNOWN COMMAND ---
      else {
        await replyInThread(channel, event.ts,
          "I can help with:\n" +
          "• `@GTM Classifier check <company>` — check if a company is a vendor/prospect\n" +
          "• `@GTM Classifier classify this` — attach a CSV/XLSX to classify a list"
        );
      }
    }
  }

  return NextResponse.json({ ok: true });
}
