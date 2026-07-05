import type { Metadata } from "next";
import Link from "next/link";
import { desc, and, gte, or, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { workItems } from "@/lib/schema";
import { getBoard, type BoardColumns } from "@/lib/work-items";
import { labelsFor } from "@/lib/board-world";
import { PLUM } from "@/lib/tokens";
import AppShell, { resolveViewer } from "@/app/AppShell";
import Gate from "@/app/Gate";
import BoardClient from "@/app/board/BoardClient";
import TasksClient, { type TaskRow } from "./TasksClient";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = { title: "Tasks" };

// /tasks — one status-grouped list with real mutations (Daybreak P14's
// replacement surface). Runs ALONGSIDE /board: nothing is deleted until this
// proves itself in a week of real use. Unlike the kanban, this works
// without drag — including on a phone — and the detail slide-over can
// actually CHANGE things (the old detail page was read-only).

// Module-level (not in render): the purity rule bans Date.now() in
// component bodies, even server ones.
function weekAgoDate(): Date {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
}

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const viewer = await resolveViewer();
  if (!viewer) return <Gate />;
  const { view } = await searchParams;
  const boardView = view === "board";

  const viewTabs = (
    <div className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-white p-0.5">
      {(["list", "board"] as const).map((v) => (
        <Link
          key={v}
          // board=all keeps 409-refetches in BoardClient scoped to ALL boards
          // (it rebuilds its fetch from location.search) — without it a
          // conflict reload would collapse this view to the default board.
          href={v === "list" ? "/tasks" : "/tasks?view=board&board=all"}
          className="rounded-md px-2.5 py-1 text-sm font-medium no-underline"
          style={(boardView ? v === "board" : v === "list") ? { background: PLUM, color: "white" } : { color: "#574B59" }}
        >
          {v === "list" ? "List" : "Board"}
        </Link>
      ))}
    </div>
  );

  if (boardView) {
    // Board view: the familiar drag-and-drop kanban over ALL boards' items —
    // same columns, same optimistic moves, same conflict handling.
    const columns: BoardColumns = await getBoard({});
    const ids = (["Unsorted", "To Do", "Reddy Working", "Reddy Waiting", "Completed"] as const).flatMap((c) =>
      columns[c].map((i) => i.id),
    );
    const labelsByItem = await labelsFor(ids).catch(() => new Map());
    return (
      <AppShell
        active="tasks"
        viewer={viewer}
        title="Tasks"
        subtitle="Drag between columns, or switch to the list for quick edits."
        actions={viewTabs}
      >
        <BoardClient initial={columns} viewerEmail={viewer} labelsByItem={Object.fromEntries(labelsByItem)} />
      </AppShell>
    );
  }

  // Open tasks in full + done from the last 7 days only. No dismissed,
  // no unbounded history pushing live work off the 300-row cap.
  const weekAgo = weekAgoDate();
  const rows = await db
    .select({
      id: workItems.id,
      title: workItems.title,
      status: workItems.status,
      kind: workItems.kind,
      customerSlug: workItems.customerSlug,
      ownerEmail: workItems.ownerEmail,
      botAssigned: workItems.botAssigned,
      sourceRef: workItems.sourceRef,
      version: workItems.version,
      createdAt: workItems.createdAt,
      dueAt: workItems.dueAt,
    })
    .from(workItems)
    .where(
      and(
        ne(workItems.status, "dismissed"),
        or(ne(workItems.status, "done"), gte(workItems.stageEnteredAt, weekAgo)),
      ),
    )
    .orderBy(desc(workItems.createdAt))
    .limit(300)
    .catch(() => []);

  const tasks: TaskRow[] = rows.map((r) => ({
    ...r,
    createdAt: r.createdAt?.toISOString() ?? null,
    dueAt: r.dueAt?.toISOString() ?? null,
  }));

  return (
    <AppShell
      active="tasks"
      viewer={viewer}
      title="Tasks"
      subtitle="Everything the team and the bot are working on — click a task to change it."
      maxWidth="max-w-4xl"
      actions={viewTabs}
    >
      <TasksClient tasks={tasks} viewer={viewer} />
    </AppShell>
  );
}
