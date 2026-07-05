import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getSession, addTurn, getPendingRequest, clearPendingRequest } from "@/lib/sessions";
import { kv } from "@/lib/kv-client";
import { BORDER } from "@/lib/tokens";
import AppShell, { resolveViewer } from "@/app/AppShell";
import WelcomeGate from "@/app/WelcomeGate";
import MeetingChatStream from "@/components/MeetingChatStream";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = { title: "Session" };

// /s/{id} — resume a conversation (Daybreak Phase 8). History hydrates from
// Neon; the scope snapshotted at creation still binds the agent.

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const viewer = await resolveViewer();
  if (!viewer) return <WelcomeGate />;

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
      await addTurn({ sessionId: id, viewer, role: "assistant", content: answer }).catch(() => null);
      await clearPendingRequest(id);
      found = (await getSession(id, viewer).catch(() => null)) ?? found;
    }
  }

  const scope = found.session.scope as { botIds?: string[]; note?: string; label?: string } | null;
  const botIds = scope?.botIds ?? [];
  const scoped = botIds.length > 0;

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
          scopeLabel={scope?.label ?? "meetings · HubSpot · documents · board"}
          placeholder="Continue the conversation…"
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
