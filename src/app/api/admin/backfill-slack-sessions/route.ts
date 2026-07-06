import { NextRequest, NextResponse } from "next/server";
import { WebClient } from "@slack/web-api";
import { resolveApiViewer } from "@/lib/viewer";
import { kv } from "@/lib/kv-client";
import { emailForSlackId } from "@/lib/slack";
import { createSession, addTurn, extSessionKey, findSessionByThreadKey, type SessionScope } from "@/lib/sessions";

// ONE-TIME backfill: seed historical reddy-gtm Slack bot conversations into the
// web session store so past Slack threads show up in /s + team-wide search.
// Reproduces the live mirror exactly — same threadKey (reddy-gtm:thread:{ts}),
// same scope shape, same `sess:ext:` map — so a backfilled thread is
// indistinguishable from a live-synced one and can't be double-created.
//
// Idempotent: skips any thread that already has a session (KV map OR the
// Postgres scope.threadKey — the KV key expires at 90d but the row doesn't).
// Re-run freely to continue; it just skips what's already imported.
//
// Trigger: a signed-in teammate visits this URL. DEFAULT is a dry-run preview
// (reports what it WOULD import); add `?run=1` to actually write. `?limit=N`
// caps threads per run (default 300).

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 800;

const SESS_EX = 90 * 24 * 3600;
// Matches agentThreadKey() in src/app/api/agent/route.ts — kept inline to avoid
// importing that route's heavy sandbox deps into this one.
const threadKeyFor = (rootTs: string) => `reddy-gtm:thread:${rootTs}`;

type SlackMsg = {
  type?: string;
  subtype?: string;
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  reply_count?: number;
};

// Strip Slack markup to the clean text the live mirror stores.
function normalize(text: string): string {
  return (text || "")
    .replace(/<@[A-Z0-9]+>/g, "")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .trim();
}

export async function GET(req: NextRequest) {
  // Auth: a signed-in teammate (board_viewer cookie) OR the internal secret
  // (x-reddy-internal, same as the oneshot lane) for a server-to-server run.
  const internalOk = !!process.env.MCP_INTERNAL_SECRET && req.headers.get("x-reddy-internal") === process.env.MCP_INTERNAL_SECRET;
  if (!internalOk && !resolveApiViewer(req)) {
    return NextResponse.json({ ok: false, error: "sign in required" }, { status: 401 });
  }

  const dryRun = req.nextUrl.searchParams.get("run") !== "1";
  const channel = process.env.SLACK_CHANNEL_ID || process.env.SALES_CHANNEL_ID || process.env.SALES_TESTING_CHANNEL_ID;
  if (!channel) return NextResponse.json({ ok: false, error: "no Slack channel configured" }, { status: 400 });
  const maxThreads = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit") ?? "300") || 300, 1), 1000);

  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
  let botId: string;
  try {
    const auth = await slack.auth.test();
    botId = String(auth.user_id ?? "");
    if (!botId) throw new Error("no user_id");
  } catch (e) {
    return NextResponse.json({ ok: false, error: `slack auth.test failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }

  const summary = { channel, botId, dryRun, scanned: 0, botThreads: 0, imported: 0, skipped: 0, turns: 0, errors: [] as string[] };

  // 1) Page channel history for thread roots (top-level messages).
  const rootTsList: string[] = [];
  const seenRoot = new Set<string>();
  let cursor: string | undefined;
  try {
    do {
      const res = await slack.conversations.history({ channel, cursor, limit: 200 });
      for (const m of (res.messages ?? []) as SlackMsg[]) {
        if (m.type !== "message" || m.subtype || !m.ts) continue;
        if (m.thread_ts && m.thread_ts !== m.ts) continue; // a reply, not a root
        if (!seenRoot.has(m.ts)) {
          seenRoot.add(m.ts);
          rootTsList.push(m.ts);
        }
      }
      cursor = res.response_metadata?.next_cursor || undefined;
    } while (cursor && rootTsList.length < maxThreads * 4);
  } catch (e) {
    summary.errors.push(`history: ${e instanceof Error ? e.message : String(e)}`);
  }

  // 2) For each root, pull the thread; import if it's a bot conversation.
  for (const rootTs of rootTsList) {
    if (summary.imported + summary.skipped >= maxThreads) break;
    summary.scanned++;
    try {
      const replies = await slack.conversations.replies({ channel, ts: rootTs, limit: 200 });
      const msgs = ((replies.messages ?? []) as SlackMsg[])
        .filter((m) => m.type === "message" && !m.subtype && m.ts)
        .sort((a, b) => Number(a.ts) - Number(b.ts));
      if (msgs.length === 0) continue;

      const botMsgs = msgs.filter((m) => m.user === botId);
      const mentions = msgs.filter((m) => m.user && m.user !== botId && (m.text ?? "").includes(`<@${botId}>`));
      // Only threads where a human asked the bot AND the bot replied are conversations.
      if (botMsgs.length === 0 || mentions.length === 0) continue;
      summary.botThreads++;

      const threadKey = threadKeyFor(rootTs);
      const already = (await kv.get(extSessionKey(threadKey)).catch(() => null)) || (await findSessionByThreadKey(threadKey).catch(() => null));
      if (already) {
        summary.skipped++;
        continue;
      }

      const firstMention = mentions[0];
      const ownerEmail = await emailForSlackId(firstMention.user!).catch(() => null);
      if (!ownerEmail) {
        summary.skipped++; // can't attribute the owner → skip rather than mis-own
        continue;
      }
      const title = normalize(firstMention.text ?? "").slice(0, 100) || "Slack conversation";

      // Turns: user turns = @mentions of the bot (matches what live mirror saw);
      // assistant turns = the bot's posts. Non-owner humans get a "**email:**" prefix.
      const turnMsgs = msgs.filter((m) => m.user === botId || (m.user && m.user !== botId && (m.text ?? "").includes(`<@${botId}>`)));

      if (dryRun) {
        summary.imported++;
        summary.turns += turnMsgs.length;
        continue;
      }

      const scope: SessionScope = { source: "slack", label: "Slack thread", threadKey, slackChannel: channel, slackThreadTs: rootTs };
      const session = await createSession({ viewer: ownerEmail, title, scope });
      await kv.set(extSessionKey(threadKey), { id: session.id, viewer: ownerEmail }, { ex: SESS_EX, nx: true }).catch(() => {});
      summary.imported++;

      for (const m of turnMsgs) {
        const isBot = m.user === botId;
        const content = normalize(m.text ?? "");
        if (!content) continue;
        const sender = isBot ? ownerEmail : (await emailForSlackId(m.user!).catch(() => null)) || ownerEmail;
        const attributed = !isBot && sender !== ownerEmail ? `**${sender}:** ${content}` : content;
        const turn = await addTurn({ sessionId: session.id, viewer: ownerEmail, role: isBot ? "assistant" : "user", content: attributed });
        if (turn) summary.turns++;
      }
    } catch (e) {
      summary.errors.push(`${rootTs}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return NextResponse.json({
    ok: true,
    ...summary,
    rootsFound: rootTsList.length,
    note: dryRun ? "DRY RUN — add ?run=1 to import. Re-run to continue (idempotent)." : "Imported. Re-run to continue if rootsFound hit the cap.",
    errors: summary.errors.slice(0, 10),
  });
}
