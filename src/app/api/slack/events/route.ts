import { NextRequest, NextResponse } from "next/server";
import { WebClient } from "@slack/web-api";
import { CompanyClassifier } from "@/lib/classifier";
import { fetchCompanyLists } from "@/lib/database";
import { sendQuickClassification } from "@/lib/slack";
import { parseUploadedFile, parseUploadedFileRaw } from "@/lib/parse-upload";
import { createReview } from "@/lib/kv";
import { kv } from "@vercel/kv";
import { db } from "@/lib/db";
import { accounts, contacts, companies, conferenceLists, listContacts } from "@/lib/schema";
import { eq, ilike } from "drizzle-orm";
import { enrichContactViaApollo, enrichAccountViaApollo } from "@/lib/enrichment";
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

    console.log(`[slack] Event type: ${event.type}, bot_id: ${event.bot_id || "none"}, text: "${(event.text || "").slice(0, 100)}"`);

    if (event.type === "app_mention" && !event.bot_id) {
      const rawText = (event.text || "").replace(/<@[A-Z0-9]+>/g, "").trim();
      const text = rawText.toLowerCase();
      const channel = event.channel;

      console.log(`[slack] Parsed text: "${text}", has files: ${!!event.files}, file count: ${event.files?.length || 0}`);

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
          await replyInThread(channel, event.ts, "I don't see a file attached. Upload a CSV or XLSX with `@GTM Classifier process this`.");
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
          await replyInThread(channel, event.ts, "Ask me a question about your campaigns, e.g. `@GTM Classifier campaign how are our Google Ads performing this week?`");
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

      // --- UNKNOWN COMMAND ---
      else {
        await replyInThread(channel, event.ts,
          "I can help with:\n" +
          "• `@GTM Classifier process this` — *full pipeline*: extract → score → enrich → push to HubSpot\n" +
          "• `@GTM Classifier classify this` — classify companies from a CSV/XLSX\n" +
          "• `@GTM Classifier check <company>` — check if a company is a vendor/prospect\n" +
          "• `@GTM Classifier enrich <company>` — enrich a company via Apollo\n" +
          "• `@GTM Classifier status <company>` — show everything we know\n" +
          "• `@GTM Classifier contacts <conference>` — show contacts from a conference list\n" +
          "• `@GTM Classifier campaign <question>` — ask about marketing campaigns (Google Ads, LinkedIn, Meta, GA4)"
        );
      }
    }
  }

  return NextResponse.json({ ok: true });
}
