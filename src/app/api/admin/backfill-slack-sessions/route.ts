import { NextRequest, NextResponse } from "next/server";
import { WebClient } from "@slack/web-api";
import { resolveApiViewer } from "@/lib/viewer";
import { kv } from "@/lib/kv-client";
import { emailForSlackId } from "@/lib/slack";
import { createSession, addTurn, backdateSession, allSessionThreadKeys, extSessionKey, type SessionScope } from "@/lib/sessions";

// ONE-TIME backfill: seed historical reddy-gtm Slack bot conversations into the
// web session store so past Slack threads show up in /s + team-wide search.
// Reproduces the live mirror exactly (threadKey reddy-gtm:thread:{ts}, scope
// {source:"slack",...}, the sess:ext: map) so a backfilled thread is
// indistinguishable from a live-synced one and can't be double-created.
//
// CURSOR CONTINUATION: each run resumes paging channel history where the last
// left off (KV cursor) instead of re-walking from the top — so it scales to a
// big channel across many runs. Idempotent: dedup by KV map OR Postgres
// scope.threadKey (the KV key expires at 90d but the row doesn't).
//
// Trigger: signed-in teammate OR x-reddy-internal. DEFAULT is a dry run; add
// `?run=1` to write. `?limit=N` = new imports per run (default 120). `?restart=1`
// resets the cursor to the newest message.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 800;

const SESS_EX = 90 * 24 * 3600;
const CURSOR_EX = 7 * 24 * 3600;
// Matches agentThreadKey() in src/app/api/agent/route.ts.
const threadKeyFor = (rootTs: string) => `reddy-gtm:thread:${rootTs}`;
const cursorKeyFor = (channel: string) => `backfill:slack:cursor:${channel}`;

type SlackMsg = { type?: string; subtype?: string; ts?: string; thread_ts?: string; user?: string; bot_id?: string; text?: string };

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
  const internalOk = !!process.env.MCP_INTERNAL_SECRET && req.headers.get("x-reddy-internal") === process.env.MCP_INTERNAL_SECRET;
  if (!internalOk && !resolveApiViewer(req)) {
    return NextResponse.json({ ok: false, error: "sign in required" }, { status: 401 });
  }

  const dryRun = req.nextUrl.searchParams.get("run") !== "1";
  const channel = process.env.SLACK_CHANNEL_ID || process.env.SALES_CHANNEL_ID || process.env.SALES_TESTING_CHANNEL_ID;
  if (!channel) return NextResponse.json({ ok: false, error: "no Slack channel configured" }, { status: 400 });
  const maxThreads = Math.min(Math.max(Number(req.nextUrl.searchParams.get("limit") ?? "120") || 120, 1), 400);
  const cursorKey = cursorKeyFor(channel);

  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
  let botId: string;
  try {
    const auth = await slack.auth.test();
    botId = String(auth.user_id ?? "");
    if (!botId) throw new Error("no user_id");
  } catch (e) {
    return NextResponse.json({ ok: false, error: `slack auth.test failed: ${e instanceof Error ? e.message : String(e)}` }, { status: 500 });
  }

  const s = { channel, botId, dryRun, pages: 0, scanned: 0, botThreads: 0, imported: 0, skipped: 0, turns: 0, errors: [] as string[] };

  // Load already-imported threadKeys ONCE for O(1) in-memory dedup (per-root
  // jsonb lookups are seq scans and don't scale to thousands of roots).
  const seen = await allSessionThreadKeys().catch(() => new Set<string>());

  // Resume from the saved cursor unless restarting.
  let cursor: string | undefined =
    req.nextUrl.searchParams.get("restart") === "1" ? undefined : (await kv.get<string>(cursorKey).catch(() => null)) || undefined;
  let exhausted = false;

  try {
    while (true) {
      const res = await slack.conversations.history({ channel, cursor, limit: 200 });
      s.pages++;
      for (const m of (res.messages ?? []) as SlackMsg[]) {
        if (m.type !== "message" || m.subtype || !m.ts) continue;
        if (m.thread_ts && m.thread_ts !== m.ts) continue; // a reply, not a root
        const rootTs = m.ts;
        const threadKey = threadKeyFor(rootTs);
        if (seen.has(threadKey)) {
          s.skipped++;
          continue;
        }
        s.scanned++;
        const replies = await slack.conversations.replies({ channel, ts: rootTs, limit: 200 });
        const msgs = ((replies.messages ?? []) as SlackMsg[])
          .filter((x) => x.type === "message" && !x.subtype && x.ts)
          .sort((a, b) => Number(a.ts) - Number(b.ts));
        const mentions = msgs.filter((x) => x.user && x.user !== botId && (x.text ?? "").includes(`<@${botId}>`));
        const botMsgs = msgs.filter((x) => x.user === botId);
        if (mentions.length === 0 || botMsgs.length === 0) continue; // not a bot conversation
        s.botThreads++;

        const ownerEmail = await emailForSlackId(mentions[0].user!).catch(() => null);
        if (!ownerEmail) {
          s.skipped++;
          continue;
        }
        const turnMsgs = msgs.filter((x) => x.user === botId || (x.user && x.user !== botId && (x.text ?? "").includes(`<@${botId}>`)));
        seen.add(threadKey);

        if (dryRun) {
          s.imported++;
          s.turns += turnMsgs.length;
        } else {
          const scope: SessionScope = { source: "slack", label: "Slack thread", threadKey, slackChannel: channel, slackThreadTs: rootTs };
          const session = await createSession({ viewer: ownerEmail, title: normalize(mentions[0].text ?? "").slice(0, 100) || "Slack conversation", scope });
          await kv.set(extSessionKey(threadKey), { id: session.id, viewer: ownerEmail }, { ex: SESS_EX, nx: true }).catch(() => {});
          s.imported++;
          for (const x of turnMsgs) {
            const isBot = x.user === botId;
            const content = normalize(x.text ?? "");
            if (!content) continue;
            const sender = isBot ? ownerEmail : (await emailForSlackId(x.user!).catch(() => null)) || ownerEmail;
            const attributed = !isBot && sender !== ownerEmail ? `**${sender}:** ${content}` : content;
            const turn = await addTurn({ sessionId: session.id, viewer: ownerEmail, role: isBot ? "assistant" : "user", content: attributed });
            if (turn) s.turns++;
          }
          const lastTs = msgs[msgs.length - 1]?.ts ?? rootTs;
          await backdateSession(session.id, Math.round(Number(rootTs) * 1000), Math.round(Number(lastTs) * 1000)).catch(() => {});
        }
      }
      cursor = res.response_metadata?.next_cursor || undefined;
      if (!cursor) {
        exhausted = true;
        break;
      }
      if (s.imported >= maxThreads) break; // stop after finishing the current page
    }
  } catch (e) {
    s.errors.push(e instanceof Error ? e.message : String(e));
  }

  // Persist the resume point (or clear it when the whole channel is done).
  if (!dryRun) {
    if (exhausted) await kv.del(cursorKey).catch(() => {});
    else if (cursor) await kv.set(cursorKey, cursor, { ex: CURSOR_EX }).catch(() => {});
  }

  return NextResponse.json({
    ...s,
    ok: true,
    exhausted,
    cursorSaved: !dryRun && !exhausted && !!cursor,
    note: exhausted ? "Whole channel scanned — done." : dryRun ? "DRY RUN — add ?run=1 to import." : "Batch done — re-run to continue from the saved cursor.",
    errors: s.errors.slice(0, 10),
  });
}
