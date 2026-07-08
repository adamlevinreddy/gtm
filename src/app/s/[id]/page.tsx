import Link from "next/link";
import { notFound } from "next/navigation";
import { after } from "next/server";
import type { Metadata } from "next";
import { getSession, addTurn, getPendingRequest, clearPendingRequest } from "@/lib/sessions";
import { kv } from "@/lib/kv-client";
import { postToChannel } from "@/lib/slack";
import { BORDER } from "@/lib/tokens";
import AppShell, { resolveViewer } from "@/app/AppShell";
import Gate from "@/app/Gate";
import MeetingChatStream from "@/components/MeetingChatStream";
import {
  MARKETING_CHAT_ENDPOINT,
  MARKETING_PLAY_IDS,
  MARKETING_FOOTER_ACTIONS,
  isMarketingSession,
} from "@/lib/marketing-chat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = { title: "Session" };

// /s/{id} — resume a conversation (Daybreak Phase 8). History hydrates from
// Neon; the scope snapshotted at creation still binds the agent.

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await resolveViewer();
  if (!viewer) return <Gate />;

  const { id } = await params;
  let found = await getSession(id, viewer).catch(() => null);
  if (!found) notFound();

  // Self-healing resume (Daybreak P8): a run that outlived its asking tab
  // left a pending requestId — if the agent has since finished, complete the
  // turn now so the session never shows a permanently unanswered question.
  const pending = await getPendingRequest(id).catch(() => null);
  if (pending) {
    const result = await kv
      .get<{ ok?: boolean; answer?: string; error?: string }>(`mcp:result:${pending}`)
      .catch(() => null);
    if (result) {
      const answer =
        result.answer || (result.error ? `⚠️ ${result.error}` : "⚠️ The run finished without an answer.");
      // Idempotency: if the late poll already persisted this exact answer (the
      // client's success path does, but never clears the pending marker), skip
      // the append AND the Slack mirror so a second /s/{id} load — or a link
      // prefetch — can't duplicate the turn or double-post to the thread.
      const last = found.turns[found.turns.length - 1];
      const alreadyPersisted = last?.role === "assistant" && last.content === answer;
      if (!alreadyPersisted) {
        await addTurn({ sessionId: id, viewer, role: "assistant", content: answer }).catch(() => null);
        // Slack-born session: the self-healed answer must reach the thread too,
        // same as live answers do via the sessions API mirror.
        const s = found.session.scope as { source?: string; slackChannel?: string; slackThreadTs?: string } | null;
        if (s?.source === "slack" && s.slackChannel && s.slackThreadTs && result.answer) {
          after(() => postToChannel(s.slackChannel!, { text: answer.slice(0, 3500), threadTs: s.slackThreadTs! }).catch(() => {}));
        }
      }
      await clearPendingRequest(id);
      found = (await getSession(id, viewer).catch(() => null)) ?? found;
    }
  }

  const scope = found.session.scope as { botIds?: string[]; note?: string; label?: string; source?: string } | null;
  const botIds = scope?.botIds ?? [];
  const scoped = botIds.length > 0;
  // Resuming a Marketing session must stay on Fable (+ website source + the
  // marketing plays / Save-to-Docs action), not silently fall back to Opus.
  const marketing = isMarketingSession(scope);

  return (
    <AppShell active="sessions" viewer={viewer} maxWidth="max-w-4xl">
      <nav className="mb-4 flex items-center gap-1.5 text-sm text-zinc-400">
        <Link href="/s" className="no-underline hover:underline" style={{ color: "#574B59" }}>
          ← All sessions
        </Link>
      </nav>
      <div
        className="flex h-[80vh] flex-col overflow-hidden rounded-xl border bg-white"
        style={{ borderColor: BORDER }}
      >
        <MeetingChatStream
          {...(scoped ? { botIds, scopeNote: scope?.note } : { unscoped: true })}
          title={found.session.title}
          scopeLabel={scope?.label ?? (marketing ? "Fable" : "meetings · HubSpot · documents · board")}
          placeholder="Continue the conversation…"
          showCost
          initialCostUsd={found.session.costUsd ?? 0}
          {...(marketing
            ? {
                endpoint: MARKETING_CHAT_ENDPOINT,
                playIds: MARKETING_PLAY_IDS,
                footerActions: MARKETING_FOOTER_ACTIONS,
              }
            : {})}
          initialSession={{
            id: found.session.id,
            turns: found.turns.map((t) => ({
              role: t.role === "assistant" ? ("assistant" as const) : ("user" as const),
              content: t.content,
            })),
          }}
        />
      </div>
    </AppShell>
  );
}
