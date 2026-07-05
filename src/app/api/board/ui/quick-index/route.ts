import { NextRequest, NextResponse } from "next/server";
import { readMeetingIndex } from "@/lib/meeting-index";
import { fmtDayPT } from "@/lib/fmt";
import { verifyViewerCookie } from "@/lib/viewer";
import { VIEWER_COOKIE } from "@/lib/team";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Composite index behind ⌘K (Daybreak Phase 7). One KV read; the client
// caches it and filters LOCALLY — keystrokes never hit the network.

export type QuickItem = {
  type: "meeting" | "account" | "nav";
  title: string;
  subtitle?: string;
  href: string;
  botId?: string;
};

const NAV_ITEMS: QuickItem[] = [
  { type: "nav", title: "Home", href: "/" },
  { type: "nav", title: "Meetings", href: "/meetings" },
  { type: "nav", title: "Board", href: "/board" },
  { type: "nav", title: "Inbox", href: "/board/inbox" },
  { type: "nav", title: "Settings · notetaker schedule & connections", href: "/settings" },
  { type: "nav", title: "Skip a meeting (bot schedule)", href: "/settings" },
];

function pretty(slug: string): string {
  return slug.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function GET(req: NextRequest) {
  // 90 days of titles/accounts is team-internal — verified viewers only.
  if (!verifyViewerCookie(req.cookies.get(VIEWER_COOKIE)?.value)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const rows = await readMeetingIndex({
    sinceMs: Date.now() - 90 * 24 * 60 * 60 * 1000,
    limit: 400,
  }).catch(() => []);

  const meetings: QuickItem[] = rows.map((r) => ({
    type: "meeting",
    title: r.title || "(untitled meeting)",
    subtitle: `${r.customer_slug !== "_unsorted" ? pretty(r.customer_slug) + " · " : ""}${fmtDayPT(r.started_at)}`,
    href: `/m/${r.bot_id}`,
    botId: r.bot_id,
  }));

  const accounts: QuickItem[] = [...new Set(rows.map((r) => r.customer_slug))]
    .filter((s) => s && s !== "_unsorted")
    .sort()
    .map((s) => ({
      type: "account",
      title: pretty(s),
      subtitle: "account · meetings",
      href: `/meetings?days=90&account=${encodeURIComponent(pretty(s))}`,
    }));

  return NextResponse.json(
    { ok: true, items: [...NAV_ITEMS, ...accounts, ...meetings] },
    { headers: { "Cache-Control": "private, max-age=120" } },
  );
}
