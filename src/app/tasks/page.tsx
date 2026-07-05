import type { Metadata } from "next";
import { desc, and, gte, or, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { workItems } from "@/lib/schema";
import AppShell, { resolveViewer } from "@/app/AppShell";
import WelcomeGate from "@/app/WelcomeGate";
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

export default async function TasksPage() {
  const viewer = await resolveViewer();
  if (!viewer) return <WelcomeGate />;

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
      subtitle="Everything the team and the bot are working on — click a task to change it. (The kanban board still exists under Board.)"
      maxWidth="max-w-4xl"
    >
      <TasksClient tasks={tasks} viewer={viewer} />
    </AppShell>
  );
}
