import { NextRequest, NextResponse } from "next/server";
import { and, desc, gte, ne, or } from "drizzle-orm";
import { db } from "@/lib/db";
import { workItems } from "@/lib/schema";
import { readMeetingIndex } from "@/lib/meeting-index";
import { labeledMeetings, accountRollup } from "@/lib/meeting-accounts";
import { listLibraryFiles } from "@/lib/library";
import { fmtDayPT } from "@/lib/fmt";
import { verifyViewerCookie } from "@/lib/viewer";
import { VIEWER_COOKIE } from "@/lib/team";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Composite index behind ⌘K (Daybreak Phase 7). One read; the client caches it
// and filters LOCALLY — keystrokes never hit the network. Everything the team
// works across is searchable here: nav, accounts, meetings, library files, and
// open tasks.

export type QuickItem = {
  type: "meeting" | "account" | "nav" | "file" | "task";
  title: string;
  subtitle?: string;
  href: string;
  botId?: string;
};

const NAV_ITEMS: QuickItem[] = [
  { type: "nav", title: "Home", href: "/" },
  { type: "nav", title: "Meetings", href: "/meetings" },
  { type: "nav", title: "Sessions · past conversations", href: "/s" },
  { type: "nav", title: "Library · pricing, proposals, legal", href: "/library" },
  { type: "nav", title: "Tasks", href: "/tasks" },
  { type: "nav", title: "Your brief · morning prep", href: "/brief" },
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
  const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [rows, labeled, libFiles, taskRows] = await Promise.all([
    readMeetingIndex({
      sinceMs: Date.now() - 90 * 24 * 60 * 60 * 1000,
      limit: 400,
    }).catch(() => []),
    // Accounts come from the SAME labeler the meetings hub / home / /a use, so
    // the deduped display + slug are identical everywhere (no reimplementation
    // that can drift). Cheap: recentMeetingIndex is the KV fast path.
    pat ? labeledMeetings(pat, 90, 400).catch(() => ({ meetings: [], uncachedEvidence: [] })) : Promise.resolve({ meetings: [], uncachedEvidence: [] }),
    pat ? listLibraryFiles(pat).catch(() => []) : Promise.resolve([]),
    // Open tasks (+ recently-done), matching the /tasks list scope.
    db
      .select({ id: workItems.id, title: workItems.title, status: workItems.status, customerSlug: workItems.customerSlug })
      .from(workItems)
      .where(and(ne(workItems.status, "dismissed"), or(ne(workItems.status, "done"), gte(workItems.stageEnteredAt, weekAgo))))
      .orderBy(desc(workItems.createdAt))
      .limit(250)
      .catch(() => []),
  ]);

  const files: QuickItem[] = libFiles.slice(0, 300).map((f) => ({
    type: "file",
    title: f.name,
    subtitle: `${f.category}${f.subpath ? ` / ${f.subpath}` : ""}`,
    href: `/api/library/file?path=${encodeURIComponent(f.path)}`,
  }));

  const meetings: QuickItem[] = rows.map((r) => ({
    type: "meeting",
    title: r.title || "(untitled meeting)",
    subtitle: `${r.customer_slug !== "_unsorted" ? pretty(r.customer_slug) + " · " : ""}${fmtDayPT(r.started_at)}`,
    href: `/m/${r.bot_id}`,
    botId: r.bot_id,
  }));

  // One entry per company, deduped + displayed + slugged EXACTLY as the
  // meetings hub / home / /a do (accountRollup is the shared source of truth),
  // so a ⌘K account result always lands on the matching /a page. Internal /
  // all-reddy meetings are already excluded by accountRollup.
  const accounts: QuickItem[] = accountRollup(labeled.meetings)
    .map((a) => ({
      type: "account" as const,
      title: a.account,
      subtitle: "account · meetings, deliverables, commitments",
      href: `/a/${a.accountSlug}`,
    }))
    .sort((a, b) => a.title.localeCompare(b.title));

  const tasks: QuickItem[] = taskRows.map((t) => ({
    type: "task",
    title: t.title,
    subtitle: `task · ${t.status.replace(/_/g, " ")}${t.customerSlug ? ` · ${pretty(t.customerSlug)}` : ""}`,
    href: `/tasks?focus=${t.id}`,
  }));

  return NextResponse.json(
    { ok: true, items: [...NAV_ITEMS, ...accounts, ...tasks, ...meetings, ...files] },
    { headers: { "Cache-Control": "private, max-age=120" } },
  );
}
