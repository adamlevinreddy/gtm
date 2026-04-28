import { NextRequest, NextResponse } from "next/server";
import { WebClient } from "@slack/web-api";
import { CompanyClassifier } from "@/lib/classifier";
import { fetchCompanyLists } from "@/lib/database";
import { sendQuickClassification } from "@/lib/slack";
import { parseUploadedFile, parseUploadedFileRaw } from "@/lib/parse-upload";
import { createReview } from "@/lib/kv";
import { kv } from "@/lib/kv-client";
import { db } from "@/lib/db";
import { accounts, contacts, companies, conferenceLists, listContacts } from "@/lib/schema";
import { eq, ilike } from "drizzle-orm";
import { enrichContactViaApollo, enrichAccountViaApollo } from "@/lib/enrichment";
import { isSetupIntent } from "@/lib/composio-connect";
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

// Slack delivers app_mention text with two different escaping strategies in
// the same message:
//   - <@USER>, <#CHANNEL|name>      → LITERAL angle brackets (Slack control codes)
//   - &lt;https://example.com&gt;   → HTML-entity-encoded (Slack auto-wraps any
//                                     URL the user typed, then escapes the < > so
//                                     they survive Slack's own mrkdwn parser)
// To recover the raw user text we have to: (1) strip control codes that use
// LITERAL brackets, (2) decode the three HTML entities, (3) THEN strip the
// URL wrappers that just became literal brackets in step 2.
// Docs: https://docs.slack.dev/messaging/formatting-message-text/
function normalizeSlackText(input: string): string {
  return input
    // 1. Slack control codes (literal brackets)
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<@[A-Z0-9]+>/g, "")
    // 2. Decode the three HTML entities Slack escapes
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    // 3. Strip the URL angle-bracket wrappers Slack added around user-typed URLs.
    //    Use [\s\S]*? (lazy, includes newlines) because Slack's URL detector
    //    sometimes captures past a newline (e.g. when a URL ends with `&s` and
    //    the next line starts with text).
    .replace(/<((?:https?|mailto):[\s\S]*?)(?:\|[^>]*)?>/g, "$1");
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

    console.log(`[slack] Event type: ${event.type}, bot_id: ${event.bot_id || "none"}, text: "${(event.text || "").slice(0, 100)}"`);

    // --- REDDY-GTM END-THREAD SIGNAL (🔚 reaction) ---
    // Force-close a thread: stop the sandbox + clear KV state so no future
    // mention inherits this thread's tools/context/session history.
    if (
      process.env.REDDY_GTM_ENGINE === "agent-sdk" &&
      event.type === "reaction_added" &&
      event.reaction === "end" &&
      event.item?.type === "message"
    ) {
      const channel = event.item.channel;
      const itemTs = event.item.ts;
      if (!channel || !itemTs) return NextResponse.json({ ok: true });

      let threadTs: string | undefined;
      try {
        const replies = await getSlackClient().conversations.replies({
          channel, ts: itemTs, limit: 1,
        });
        const msg = replies.messages?.[0];
        threadTs = msg?.thread_ts || msg?.ts;
      } catch (err) {
        console.error(`[slack] end-reaction thread lookup failed: ${err}`);
        return NextResponse.json({ ok: true });
      }
      if (!threadTs) return NextResponse.json({ ok: true });

      const state = await kv.get(`reddy-gtm:thread:${threadTs}`).catch(() => null);
      if (!state) return NextResponse.json({ ok: true });

      const baseUrl = "https://gtm-jet.vercel.app";
      fetch(`${baseUrl}/api/slack/close-thread`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slackChannel: channel, slackThreadTs: threadTs, slackEventTs: itemTs }),
      }).catch((err) => console.error(`[slack] close-thread dispatch failed: ${err}`));
      await new Promise((r) => setTimeout(r, 500));
      return NextResponse.json({ ok: true });
    }

    // --- REDDY-GTM SAVE SIGNAL (🔒 reaction) ---
    // When a user reacts with the lock emoji to a bot message in a reddy-gtm
    // thread, dispatch a synthetic save-intent message to the agent. The agent
    // then stages the dirty paths, commits, pushes, and confirms in Slack.
    if (
      process.env.REDDY_GTM_ENGINE === "agent-sdk" &&
      event.type === "reaction_added" &&
      event.reaction === "lock" &&
      event.item?.type === "message"
    ) {
      const channel = event.item.channel;
      const itemTs = event.item.ts;
      if (!channel || !itemTs) return NextResponse.json({ ok: true });

      let threadTs: string | undefined;
      try {
        const replies = await getSlackClient().conversations.replies({
          channel, ts: itemTs, limit: 1,
        });
        const msg = replies.messages?.[0];
        threadTs = msg?.thread_ts || msg?.ts;
      } catch (err) {
        console.error(`[slack] lock-reaction thread lookup failed: ${err}`);
        return NextResponse.json({ ok: true });
      }
      if (!threadTs) return NextResponse.json({ ok: true });

      const state = await kv.get(`reddy-gtm:thread:${threadTs}`).catch(() => null);
      if (!state) {
        console.log(`[slack] lock reaction on non-reddy-gtm thread ${threadTs} — ignoring`);
        return NextResponse.json({ ok: true });
      }

      console.log(`[slack] lock reaction → dispatching save-intent for thread ${threadTs}`);
      await addReaction(channel, threadTs, "speech_balloon");

      const baseUrl = "https://gtm-jet.vercel.app";
      fetch(`${baseUrl}/api/agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userText: "SAVE_INTENT: the user reacted with 🔒 to lock this thread's work into the library. Refresh the workspace (git pull --rebase), inspect git status, stage the relevant dirty paths under corpora/ or decks/ (be explicit — never git add -A), commit with a concise message, pull --rebase, push to main, and confirm in Slack with the final commit path.",
          slackChannel: channel,
          slackThreadTs: threadTs,
          slackUser: event.user,
        }),
      }).catch((err) => console.error(`[slack] save-intent dispatch failed: ${err}`));
      await new Promise((r) => setTimeout(r, 500));
      return NextResponse.json({ ok: true });
    }

    if (event.type === "app_mention" && !event.bot_id) {
      const rawText = normalizeSlackText(event.text || "").trim();
      const text = rawText.toLowerCase();
      const channel = event.channel;

      console.log(`[slack] Parsed text: "${text}", has files: ${!!event.files}, file count: ${event.files?.length || 0}`);

      // --- END-THREAD keyword shortcut ("@Reddy-GTM end thread") ---
      // Same backend as the :end: reaction: stop sandbox + clear KV.
      if (process.env.REDDY_GTM_ENGINE === "agent-sdk" && /\bend\s+thread\b/i.test(text)) {
        const threadTs: string = event.thread_ts || event.ts;
        const baseUrl = "https://gtm-jet.vercel.app";
        fetch(`${baseUrl}/api/slack/close-thread`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ slackChannel: channel, slackThreadTs: threadTs, slackEventTs: event.ts }),
        }).catch((err) => console.error(`[slack] close-thread dispatch failed: ${err}`));
        await new Promise((r) => setTimeout(r, 500));
        return NextResponse.json({ ok: true });
      }

      // --- SET-ME-UP shortcut ("@Reddy-GTM set me up") ---
      // Detect setup-intent phrases and dispatch to /api/slack/set-me-up which
      // DMs the user the Composio OAuth links for every configured toolkit
      // they haven't connected yet. Fire-and-forget to a dedicated endpoint
      // because the Composio SDK work takes longer than Slack's 3s ack window
      // and Vercel's lambda runtime freezes post-response async work.
      if (process.env.REDDY_GTM_ENGINE === "agent-sdk" && isSetupIntent(text)) {
        await addReaction(channel, event.ts, "wave");
        const baseUrl = "https://gtm-jet.vercel.app";
        fetch(`${baseUrl}/api/slack/set-me-up`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            slackUserId: event.user,
            slackChannel: channel,
            slackEventTs: event.ts,
            slackThreadTs: event.thread_ts,
          }),
        }).catch((err) => console.error(`[slack] set-me-up dispatch failed: ${err}`));
        await new Promise((r) => setTimeout(r, 500));
        return NextResponse.json({ ok: true });
      }

      // --- REDDY-GTM AGENT (feature-flagged) ---
      // When REDDY_GTM_ENGINE=agent-sdk is set, ALL app_mention traffic routes
      // to the Reddy-GTM agent running Claude Code in a Vercel Sandbox.
      // Keyword handlers below are skipped entirely in this mode. Intent is
      // inferred by the agent via skills (pricing / decks / legal / etc.).
      if (process.env.REDDY_GTM_ENGINE === "agent-sdk") {
        const threadTs: string = event.thread_ts || event.ts;
        await addReaction(channel, event.ts, "speech_balloon");

        // Attached files: when a user @-mentions with an attachment Slack
        // sometimes puts the file on the same message and sometimes on a
        // sibling message in the same thread. If event.files is empty, fall
        // back to conversations.history for the most recent message in the
        // thread.
        let attachedFiles = event.files;
        if (!attachedFiles || attachedFiles.length === 0) {
          try {
            const msgResult = await getSlackClient().conversations.history({
              channel, latest: event.ts, inclusive: true, limit: 1,
            });
            attachedFiles = msgResult.messages?.[0]?.files;
          } catch { /* fall through */ }
        }
        type SlackFile = { id?: string; name?: string; mimetype?: string; size?: number; url_private?: string; url_private_download?: string };
        const slackFiles = ((attachedFiles ?? []) as SlackFile[]).map((f) => ({
          id: f.id,
          name: f.name,
          mimetype: f.mimetype,
          size: f.size,
          url: f.url_private_download || f.url_private,
        }));
        if (slackFiles.length > 0) {
          console.log(`[slack] forwarding ${slackFiles.length} file(s) to agent: ${slackFiles.map((f) => f.name).join(", ")}`);
        }

        const baseUrl = "https://gtm-jet.vercel.app";
        fetch(`${baseUrl}/api/agent`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            userText: rawText,
            slackChannel: channel,
            slackThreadTs: threadTs,
            slackUser: event.user,
            slackFiles,
          }),
        }).catch((err) => console.error(`[slack] Reddy-GTM agent fetch error: ${err}`));
        await new Promise((r) => setTimeout(r, 500));
        return NextResponse.json({ ok: true });
      }

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

      // --- FULL PIPELINE (extract → score → enrich → push) ---
      else if (text.includes("process") || text.includes("pipeline")) {
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
          await replyInThread(channel, event.ts, "I don't see a file attached. Upload a CSV or XLSX with `@Reddy-GTM process this`.");
          return NextResponse.json({ ok: true });
        }

        await addReaction(channel, event.ts, "hourglass_flowing_sand");

        try {
          const file = files[0];
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
              await replyInThread(channel, event.ts, "This file is password-protected. Include the password in your message.");
              await removeReaction(channel, event.ts, "hourglass_flowing_sand");
              await addReaction(channel, event.ts, "x");
              return NextResponse.json({ ok: true });
            }
            fileBuffer = await officeCrypto.decrypt(rawBuffer, { password });
          }

          // Parse raw data (all columns)
          const rawData = await parseUploadedFileRaw(fileBuffer, file.name || "upload.xlsx");
          const fileName = (file.name || "upload").replace(/\.[^.]+$/, "");

          await replyInThread(channel, event.ts,
            `Parsed ${rawData.rows.length} rows with ${rawData.headers.length} columns. Running full pipeline: extract → score → enrich → push to HubSpot...`
          );

          await removeReaction(channel, event.ts, "hourglass_flowing_sand");

          // Fire the pipeline as a background job.
          // Use waitUntil pattern: start the fetch, don't await the full response,
          // but ensure the request body is fully sent before the function exits.
          const baseUrl = "https://gtm-jet.vercel.app";
          const pipelinePayload = JSON.stringify({
            rawData,
            fileName,
            slackChannel: channel,
            slackThreadTs: event.ts,
          });
          console.log(`[slack] Firing pipeline: ${pipelinePayload.length} bytes to ${baseUrl}/api/pipeline`);
          // Await just long enough for the request to be accepted (not for pipeline to complete)
          fetch(`${baseUrl}/api/pipeline`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: pipelinePayload,
          }).then((res) => {
            console.log(`[slack] Pipeline response: ${res.status}`);
          }).catch((err) => {
            console.error(`[slack] Pipeline fetch error: ${err}`);
          });
          // Small delay to ensure the fetch TCP connection is established
          await new Promise((r) => setTimeout(r, 1000));

        } catch (err) {
          await removeReaction(channel, event.ts, "hourglass_flowing_sand");
          await addReaction(channel, event.ts, "x");
          await replyInThread(channel, event.ts, `Error: ${err instanceof Error ? err.message : "Unknown error"}`);
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
              await replyInThread(channel, event.ts, "This file is password-protected. Include the password: `@Reddy-GTM classify this, the password is MyPassword`");
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
          const reviewId = await createReview({ source, items: [], knownResults, fileName: file.name });
          const baseUrl = "https://gtm-jet.vercel.app";

          // Store metadata for the final combined message
          const excluded = knownResults.filter((r) => r.action === "exclude");
          const tagged = knownResults.filter((r) => r.action === "tag");

          // Determine jobs: HubSpot lookup (1) + classification batches (N)
          const hubspotCandidates = companies.filter((c) => {
            const known = classifier.classifyKnown(c.name);
            return !known || known.action !== "exclude";
          });

          const BATCH_SIZE = 20;
          const classifyBatches: typeof unknowns[] = [];
          for (let i = 0; i < unknowns.length; i += BATCH_SIZE) {
            classifyBatches.push(unknowns.slice(i, i + BATCH_SIZE));
          }

          // Total jobs = HubSpot lookup (always 1) + classification batches
          const totalJobs = 1 + classifyBatches.length;

          // Store completion metadata in KV for the final message
          await kv.set(`review:${reviewId}:meta`, {
            totalCompanies: companies.length,
            excludedCount: excluded.length,
            taggedCount: tagged.length,
            unknownCount: unknowns.length,
            totalJobs,
            slackChannel: channel,
            slackThreadTs: event.ts,
          }, { ex: 7 * 24 * 60 * 60 });

          // Fire HubSpot lookup (counts as 1 job toward completion)
          fetch(`${baseUrl}/api/hubspot/lookup`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              reviewId,
              companies: hubspotCandidates,
              isJob: true,
            }),
          }).catch(() => { /* fire and forget */ });

          // Fire classification batches
          for (let i = 0; i < classifyBatches.length; i++) {
            fetch(`${baseUrl}/api/classify/background`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                reviewId,
                batch: classifyBatches[i],
                batchIndex: i,
                totalBatches: classifyBatches.length,
                totalUnknowns: unknowns.length,
                slackChannel: channel,
                slackThreadTs: event.ts,
              }),
            }).catch(() => { /* fire and forget */ });
          }
          // Hourglass stays until background batches finish and swap it
        } catch (err) {
          await removeReaction(channel, event.ts, "hourglass_flowing_sand");
          await addReaction(channel, event.ts, "x");
          await replyInThread(channel, event.ts, `Error: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
      }

      // --- ENRICH COMPANY ---
      else if (text.startsWith("enrich ")) {
        const companyName = rawText.slice(7).trim();
        await addReaction(channel, event.ts, "mag");

        try {
          // Find account
          const accountRows = await db.select().from(accounts).where(eq(accounts.name, companyName)).limit(1);
          if (accountRows.length === 0) {
            await replyInThread(channel, event.ts, `No account found for "${companyName}". Upload a conference list first to create contacts.`);
            await removeReaction(channel, event.ts, "mag");
            return NextResponse.json({ ok: true });
          }
          const account = accountRows[0];

          // Enrich the account
          const accountResult = await enrichAccountViaApollo({
            accountId: account.id,
            domain: account.domain,
            name: account.name,
          });

          // Find and enrich contacts at this account
          const contactRows = await db.select().from(contacts).where(eq(contacts.accountId, account.id));
          let enrichedCount = 0;

          for (const contact of contactRows) {
            try {
              const result = await enrichContactViaApollo({ contactId: contact.id });
              if (result.success) enrichedCount++;
            } catch { /* continue with next contact */ }
          }

          const lines = [
            `*${companyName}* enrichment complete:`,
            `• Account: ${accountResult.success ? "enriched" : "no match"}`,
            `• Contacts: ${enrichedCount}/${contactRows.length} enriched via Apollo`,
          ];
          if (account.industry) lines.push(`• Industry: ${account.industry}`);
          if (account.employeeCount) lines.push(`• Employees: ${account.employeeCount.toLocaleString()}`);

          await replyInThread(channel, event.ts, lines.join("\n"));
          await removeReaction(channel, event.ts, "mag");
          await addReaction(channel, event.ts, "white_check_mark");
        } catch (err) {
          await removeReaction(channel, event.ts, "mag");
          await addReaction(channel, event.ts, "x");
          await replyInThread(channel, event.ts, `Enrichment error: ${err instanceof Error ? err.message : "Unknown error"}`);
        }
      }

      // --- COMPANY STATUS ---
      else if (text.startsWith("status ")) {
        const companyName = rawText.slice(7).trim();
        await addReaction(channel, event.ts, "mag");

        try {
          // Check classification
          const classRows = await db.select().from(companies).where(eq(companies.name, companyName)).limit(1);

          // Check account
          const accountRows = await db.select().from(accounts).where(eq(accounts.name, companyName)).limit(1);

          const lines: string[] = [`*${companyName}*`];

          if (classRows.length > 0) {
            const c = classRows[0];
            lines.push(`\n*Classification:* ${c.action}${c.category ? ` (${c.category})` : ""} — added ${c.added} via ${c.source}`);
          } else {
            lines.push("\n*Classification:* not in database");
          }

          if (accountRows.length > 0) {
            const a = accountRows[0];
            lines.push(`\n*Account:*`);
            if (a.tier) lines.push(`  Tier: ${a.tier}`);
            if (a.status) lines.push(`  Status: ${a.status}`);
            if (a.industry) lines.push(`  Industry: ${a.industry}`);
            if (a.employeeCount) lines.push(`  Employees: ${a.employeeCount.toLocaleString()}`);
            if (a.hubspotCompanyId) lines.push(`  HubSpot ID: ${a.hubspotCompanyId}`);
            if (a.lastEnrichmentDate) lines.push(`  Last enriched: ${a.lastEnrichmentDate} (${a.lastEnrichmentSource})`);

            // Count contacts
            const contactRows = await db.select().from(contacts).where(eq(contacts.accountId, a.id));
            lines.push(`\n*Contacts:* ${contactRows.length}`);
            for (const ct of contactRows.slice(0, 10)) {
              const name = [ct.firstName, ct.lastName].filter(Boolean).join(" ") || "—";
              lines.push(`  • ${name} | ${ct.title || "—"} | ${ct.persona || "—"}${ct.hubspotContactId ? " | in HubSpot" : ""}`);
            }
            if (contactRows.length > 10) lines.push(`  _...and ${contactRows.length - 10} more_`);
          } else {
            lines.push("\n*Account:* no account record yet");
          }

          await replyInThread(channel, event.ts, lines.join("\n"));
          await removeReaction(channel, event.ts, "mag");
          await addReaction(channel, event.ts, "white_check_mark");
        } catch {
          await removeReaction(channel, event.ts, "mag");
          await addReaction(channel, event.ts, "x");
        }
      }

      // --- CONTACTS BY CONFERENCE ---
      else if (text.startsWith("contacts ")) {
        const query = rawText.slice(9).trim();
        await addReaction(channel, event.ts, "mag");

        try {
          // Search conference lists by file name
          const lists = await db
            .select()
            .from(conferenceLists)
            .where(ilike(conferenceLists.fileName, `%${query}%`));

          if (lists.length === 0) {
            await replyInThread(channel, event.ts, `No conference lists found matching "${query}".`);
            await removeReaction(channel, event.ts, "mag");
            return NextResponse.json({ ok: true });
          }

          const lines: string[] = [];
          for (const list of lists.slice(0, 3)) {
            lines.push(`*${list.fileName}* (${list.totalContacts || 0} contacts, ${list.totalCompanies || 0} companies)`);

            const contactJoins = await db
              .select({ contact: contacts, lc: listContacts })
              .from(listContacts)
              .innerJoin(contacts, eq(listContacts.contactId, contacts.id))
              .where(eq(listContacts.listId, list.id));

            for (const { contact: ct, lc } of contactJoins.slice(0, 15)) {
              const name = [ct.firstName, ct.lastName].filter(Boolean).join(" ") || "—";
              const persona = ct.persona || "—";
              const seq = ct.sequenceStatus !== "not_sequenced" ? ` | seq: ${ct.sequenceStatus}` : "";
              const hs = lc.wasInHubspot ? " | in HubSpot" : "";
              lines.push(`  • ${ct.companyName || "—"} | ${name} | ${ct.title || lc.originalTitle || "—"} | ${persona}${seq}${hs}`);
            }
            if (contactJoins.length > 15) lines.push(`  _...and ${contactJoins.length - 15} more_`);
            lines.push("");
          }
          if (lists.length > 3) lines.push(`_${lists.length - 3} more lists match this query_`);

          await replyInThread(channel, event.ts, lines.join("\n"));
          await removeReaction(channel, event.ts, "mag");
          await addReaction(channel, event.ts, "white_check_mark");
        } catch {
          await removeReaction(channel, event.ts, "mag");
          await addReaction(channel, event.ts, "x");
        }
      }

      // --- CAMPAIGN QUESTION (Supermetrics) ---
      else if (text.startsWith("campaign ") || text.startsWith("campaigns ") || text.startsWith("ads ") || text.startsWith("marketing ")) {
        const question = rawText.replace(/^(campaign|campaigns|ads|marketing)\s+/i, "").trim();
        if (!question) {
          await replyInThread(channel, event.ts, "Ask me a question about your campaigns, e.g. `@Reddy-GTM campaign how are our Google Ads performing this week?`");
          return NextResponse.json({ ok: true });
        }

        await addReaction(channel, event.ts, "bar_chart");
        await replyInThread(channel, event.ts, `Querying marketing data for: _${question}_\nThis may take a minute...`);

        // Fire background job — campaign queries involve multiple MCP round-trips
        const baseUrl = "https://gtm-jet.vercel.app";
        fetch(`${baseUrl}/api/campaign`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            question,
            slackChannel: channel,
            slackThreadTs: event.ts,
          }),
        }).catch((err) => {
          console.error(`[slack] Campaign fetch error: ${err}`);
        });
        await new Promise((r) => setTimeout(r, 500));
      }

      // --- PRICING BUILD / PRICING CHECK ---
      else if (
        text === "pricing-build" || text.startsWith("pricing-build ") || text.startsWith("pricing-build\n") ||
        text === "pricing-check" || text.startsWith("pricing-check ") || text.startsWith("pricing-check\n")
      ) {
        const mode: "build" | "check" = text.startsWith("pricing-build") ? "build" : "check";
        const userText = rawText.replace(/^pricing-(build|check)\s*/i, "").trim();
        const threadTs: string = event.thread_ts || event.ts;

        if (!userText) {
          await replyInThread(channel, event.ts,
            mode === "build"
              ? "Tell me about the proposal, e.g.:\n```pricing-build\nCompany: Acme Corp\nLogo: https://acme.com/logo.png\nModel: 500 agents, 2-year, BYOT, Tapestry-style layout```"
              : "Ask me a pricing question, e.g. `pricing-check what's a fair rate for a 1000-agent BYOT contract similar to Tapestry?`"
          );
          return NextResponse.json({ ok: true });
        }

        await addReaction(channel, event.ts, mode === "build" ? "hammer_and_wrench" : "mag");
        await replyInThread(
          channel,
          threadTs,
          mode === "build"
            ? "Building your proposal — this may take 3–5 minutes. Reply in this thread to iterate."
            : "Researching pricing references — back in a minute."
        );

        const baseUrl = "https://gtm-jet.vercel.app";
        fetch(`${baseUrl}/api/pricing`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode,
            userText,
            slackChannel: channel,
            slackThreadTs: threadTs,
            slackUser: event.user,
          }),
        }).catch((err) => {
          console.error(`[slack] Pricing fetch error: ${err}`);
        });
        await new Promise((r) => setTimeout(r, 500));
      }

      // --- THREAD CONTINUATION (in-thread follow-up to an active pricing session) ---
      else if (event.thread_ts) {
        const threadTs: string = event.thread_ts;
        const existing = await kv.get<{ sandboxName: string; mode: "build" | "check" }>(`pricing:thread:${threadTs}`);
        if (existing) {
          await addReaction(channel, event.ts, existing.mode === "build" ? "hammer_and_wrench" : "mag");

          const baseUrl = "https://gtm-jet.vercel.app";
          fetch(`${baseUrl}/api/pricing`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: existing.mode,
              userText: rawText,
              slackChannel: channel,
              slackThreadTs: threadTs,
              slackUser: event.user,
            }),
          }).catch((err) => {
            console.error(`[slack] Pricing follow-up fetch error: ${err}`);
          });
          await new Promise((r) => setTimeout(r, 500));
          return NextResponse.json({ ok: true });
        }
        // Fall through to unknown-command help if no active pricing thread
        await replyInThread(channel, event.ts,
          "I can help with:\n" +
          "• `@Reddy-GTM process this` — *full pipeline*: extract → score → enrich → push to HubSpot\n" +
          "• `@Reddy-GTM classify this` — classify companies from a CSV/XLSX\n" +
          "• `@Reddy-GTM check <company>` — check if a company is a vendor/prospect\n" +
          "• `@Reddy-GTM enrich <company>` — enrich a company via Apollo\n" +
          "• `@Reddy-GTM status <company>` — show everything we know\n" +
          "• `@Reddy-GTM contacts <conference>` — show contacts from a conference list\n" +
          "• `@Reddy-GTM campaign <question>` — ask about marketing campaigns (Google Ads, LinkedIn, Meta, GA4)\n" +
          "• `@Reddy-GTM pricing-build <details>` — generate a customer pricing proposal PDF\n" +
          "• `@Reddy-GTM pricing-check <question>` — research pricing references"
        );
      }

      // --- UNKNOWN COMMAND ---
      else {
        await replyInThread(channel, event.ts,
          "I can help with:\n" +
          "• `@Reddy-GTM process this` — *full pipeline*: extract → score → enrich → push to HubSpot\n" +
          "• `@Reddy-GTM classify this` — classify companies from a CSV/XLSX\n" +
          "• `@Reddy-GTM check <company>` — check if a company is a vendor/prospect\n" +
          "• `@Reddy-GTM enrich <company>` — enrich a company via Apollo\n" +
          "• `@Reddy-GTM status <company>` — show everything we know\n" +
          "• `@Reddy-GTM contacts <conference>` — show contacts from a conference list\n" +
          "• `@Reddy-GTM campaign <question>` — ask about marketing campaigns (Google Ads, LinkedIn, Meta, GA4)\n" +
          "• `@Reddy-GTM pricing-build <details>` — generate a customer pricing proposal PDF\n" +
          "• `@Reddy-GTM pricing-check <question>` — research pricing references"
        );
      }
    }
  }

  return NextResponse.json({ ok: true });
}
