import { cookies } from "next/headers";
import { verifyViewerCookie } from "@/lib/viewer";
import Link from "next/link";
import type { Metadata } from "next";
import { listNotifications } from "@/lib/board-world";
import { PLUM, relTime } from "../ui-shared";
import AppShell from "@/app/AppShell";
import WelcomeGate from "@/app/WelcomeGate";
import MarkAllRead from "./MarkAllRead";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = { title: "Inbox" };

const VIEWER_COOKIE = "board_viewer";

// notification_kind → label + accent (mirrors the enum in schema.ts)
const KIND_META: Record<string, { label: string; color: string; icon: string }> = {
  assigned: { label: "Assigned to you", color: "#3A6B8C", icon: "👤" },
  bot_draft_ready: { label: "Draft ready", color: PLUM, icon: "🤖" },
  became_high_priority: { label: "Now high priority", color: "#B07D2E", icon: "⚑" },
  stalled: { label: "Stalled", color: "#A23B3B", icon: "⏳" },
  mentioned: { label: "Mentioned", color: "#564080", icon: "@" },
  comment: { label: "New comment", color: "#356048", icon: "💬" },
  cascade_completed: { label: "Subtasks done", color: "#3F7D5B", icon: "✓" },
  stage_changed: { label: "Stage changed", color: "#2F6160", icon: "→" },
};

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const cookieStore = await cookies();
  const asParam = typeof sp.as === "string" ? sp.as : undefined;
  const viewer = asParam || verifyViewerCookie(cookieStore.get(VIEWER_COOKIE)?.value);
  if (!viewer) return <WelcomeGate />;
  const onlyUnread = sp.filter === "unread";

  let notifications: Awaited<ReturnType<typeof listNotifications>> = [];
  let error: string | null = null;
  try {
    notifications = await listNotifications(viewer, onlyUnread, 200);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const unread = notifications.filter((n) => !n.readAt).length;

  return (
    <AppShell
      active="inbox"
      viewer={viewer}
      title="Inbox"
      subtitle={`Notifications for ${viewer.split("@")[0]}`}
      maxWidth="max-w-3xl"
      actions={
        <>
          <div className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-white p-0.5">
            <Link
              href="/board/inbox"
              className="rounded-md px-2.5 py-1 text-sm no-underline"
              style={!onlyUnread ? { background: PLUM, color: "#fff" } : { color: "#574B59" }}
            >
              All
            </Link>
            <Link
              href="/board/inbox?filter=unread"
              className="rounded-md px-2.5 py-1 text-sm no-underline"
              style={onlyUnread ? { background: PLUM, color: "#fff" } : { color: "#574B59" }}
            >
              Unread
            </Link>
          </div>
          <MarkAllRead viewer={viewer} unread={unread} />
        </>
      }
    >
        {error ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
            <p className="font-semibold">Inbox not reachable.</p>
            <pre className="mt-2 overflow-x-auto rounded bg-amber-100/60 p-2 font-mono text-[11px]">
              {error}
            </pre>
          </div>
        ) : notifications.length === 0 ? (
          <div className="rounded-xl border border-dashed border-zinc-200 bg-white p-12 text-center text-sm text-zinc-400">
            {onlyUnread ? "No unread notifications." : "Nothing here yet."}
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {notifications.map((n) => {
              const meta = KIND_META[n.kind] ?? {
                label: n.kind,
                color: "#777",
                icon: "•",
              };
              const isUnread = !n.readAt;
              const inner = (
                <div
                  className="flex items-start gap-3 rounded-xl border p-3.5"
                  style={{
                    background: isUnread ? "#fff" : "#FAFAFA",
                    borderColor: isUnread ? "#E4DCE3" : "#EDEDED",
                  }}
                >
                  <span
                    className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-sm"
                    style={{ background: `${meta.color}1A`, color: meta.color }}
                    aria-hidden="true"
                  >
                    {meta.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span
                        className="text-[11px] font-semibold uppercase tracking-wide"
                        style={{ color: meta.color }}
                      >
                        {meta.label}
                      </span>
                      {isUnread && (
                        <span
                          className="h-1.5 w-1.5 rounded-full"
                          style={{ background: PLUM }}
                          aria-label="unread"
                        />
                      )}
                      <span className="ml-auto shrink-0 text-[11px] text-zinc-400">
                        {relTime(
                          n.createdAt instanceof Date
                            ? n.createdAt
                            : new Date(n.createdAt)
                        )}
                      </span>
                    </div>
                    <p className="mt-1 text-sm leading-snug text-zinc-800">
                      {n.body ?? meta.label}
                    </p>
                    {n.workItemId && (
                      <p className="mt-0.5 text-xs text-zinc-400">Open item →</p>
                    )}
                  </div>
                </div>
              );
              return (
                <li key={n.id}>
                  {n.workItemId ? (
                    <a
                      href={`/board/${n.workItemId}`}
                      className="block no-underline transition-opacity hover:opacity-90"
                    >
                      {inner}
                    </a>
                  ) : (
                    inner
                  )}
                </li>
              );
            })}
          </ul>
        )}
    </AppShell>
  );
}
