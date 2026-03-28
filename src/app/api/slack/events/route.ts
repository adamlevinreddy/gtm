import { NextRequest, NextResponse } from "next/server";
import { WebClient } from "@slack/web-api";
import { CompanyClassifier } from "@/lib/classifier";
import { fetchCompanyLists } from "@/lib/database";
import { sendQuickClassification } from "@/lib/slack";
import { parseUploadedFile } from "@/lib/parse-upload";
import { createReview } from "@/lib/kv";
import type { ClassificationResult } from "@/lib/types";

export const maxDuration = 60; // Known matching is fast — don't need 5 min

const processedEvents = new Set<string>();

function getSlackClient() {
  return new WebClient(process.env.SLACK_BOT_TOKEN);
}

async function addReaction(channel: string, timestamp: string, emoji: string) {
  try {
    await getSlackClient().reactions.add({ channel, name: emoji, timestamp });
  } catch { /* may already exist */ }
}

async function removeReaction(channel: string, timestamp: string, emoji: string) {
  try {
    await getSlackClient().reactions.remove({ channel, name: emoji, timestamp });
  } catch { /* may not exist */ }
}

async function replyInThread(channel: string, threadTs: string, text: string) {
  await getSlackClient().chat.postMessage({ channel, thread_ts: threadTs, text });
}

export async function POST(req: NextRequest) {
  const body = await req.json();

  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  const eventId = body.event_id || body.event?.client_msg_id || body.event?.ts;
  if (eventId && processedEvents.has(eventId)) {
    return NextResponse.json({ ok: true });
  }
  if (eventId) {
    processedEvents.add(eventId);
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
          } catch { /* fall through */ }
        }

        if (!files || files.length === 0) {
          await replyInThread(channel, event.ts, "I don't see a file attached. Upload a CSV or XLSX in the same message.");
          return NextResponse.json({ ok: true });
        }

        await addReaction(channel, event.ts, "hourglass_flowing_sand");

        try {
          const file = files[0];

          // Download file
          const fileResponse = await fetch(file.url_private_download || file.url_private, {
            headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` },
          });
          const rawBuffer = Buffer.from(await fileResponse.arrayBuffer());

          // Decrypt if needed
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

          // Parse file
          const companies = await parseUploadedFile(fileBuffer, file.name || "upload.xlsx");
          const source = (file.name || "upload").replace(/\.[^.]+$/, "");

          // Known matching (fast)
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

          // Store review in KV (unknowns will be populated by background job)
          const reviewId = await createReview({ source, items: [], knownResults });

          // Post known matches summary immediately
          const excluded = knownResults.filter((r) => r.action === "exclude");
          const tagged = knownResults.filter((r) => r.action === "tag");
          const prospects = knownResults.filter((r) => r.action === "prospect");
          const baseUrl = "https://gtm-jet.vercel.app";

          let summary = `:white_check_mark: *Known matches found for ${source}:*\n\n`;
          summary += `> *${companies.length}* companies processed\n`;
          summary += `> :no_entry: *${excluded.length}* vendors excluded\n`;
          summary += `> :label: *${tagged.length}* tagged for different outreach (BPO/Media)\n`;
          summary += `> :bust_in_silhouette: *${prospects.length}* known prospects\n`;
          summary += `> :mag: *${unknowns.length}* unknown — sending to Claude for classification...\n`;
          summary += `\n<${baseUrl}/review/${reviewId}|View results>`;

          await replyInThread(channel, event.ts, summary);

          // Fire all batches in parallel — each gets its own function + sandbox
          if (unknowns.length > 0) {
            const BATCH_SIZE = 40;
            const batches: typeof unknowns[] = [];
            for (let i = 0; i < unknowns.length; i += BATCH_SIZE) {
              batches.push(unknowns.slice(i, i + BATCH_SIZE));
            }

            for (let i = 0; i < batches.length; i++) {
              fetch(`${baseUrl}/api/classify/background`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  reviewId,
                  batch: batches[i],
                  batchIndex: i,
                  totalBatches: batches.length,
                  totalUnknowns: unknowns.length,
                  slackChannel: channel,
                  slackThreadTs: event.ts,
                }),
              }).catch(() => { /* fire and forget */ });
            }
          } else {
            // No unknowns — swap emoji immediately
            await removeReaction(channel, event.ts, "hourglass_flowing_sand");
            await addReaction(channel, event.ts, "white_check_mark");
          }
          // Hourglass stays until background batches finish and swap it
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
