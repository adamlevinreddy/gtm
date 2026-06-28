import {
  getBoard,
  getBoardSummary,
  getDigestData,
  listBoards,
  listWorkItems,
  resolveBoardId,
  effectiveHighPriority,
  columnOf,
  BOARD_COLUMNS,
  type BoardColumns,
  type BoardColumn,
  type BoardSummary,
  type WorkItemKind,
} from "@/lib/work-items";
import type { WorkItem } from "@/lib/schema";
import { cookies } from "next/headers";
import Link from "next/link";
import {
  labelsFor,
  listLabels,
  listViews,
  unreadNotificationCount,
} from "@/lib/board-world";
import { itemIdsForFilters } from "@/lib/board-filter-query";
import BoardClient from "./BoardClient";
import BoardSwitcher, { type BoardTab } from "./BoardSwitcher";
import FilterBar from "./FilterBar";
import { Assignee } from "./Avatar";
import { AgingBadge } from "./AgingBadge";
import { KIND_LABEL, PLUM, dueLabel } from "./ui-shared";
import {
  parseFilters,
  filtersHref,
  UNASSIGNED,
  type BoardFilters,
} from "./filters";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const VIEWER_COOKIE = "board_viewer";

const COLUMN_ACCENT: Record<BoardColumn, string> = {
  Unsorted: "#8A7C8A",
  "To Do": PLUM,
  "Reddy Working": "#3A6B8C",
  "Reddy Waiting": "#B07D2E",
  Completed: "#3F7D5B",
};

type LabelChip = { id: string; name: string; color: string | null };
type LabelMap = Map<string, LabelChip[]>;

// --- shared server-side filtering -------------------------------------------

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
function passesClientSideFilters(
  it: WorkItem,
  f: BoardFilters,
  allowIds: Set<string> | null
): boolean {
  if (f.assignee === UNASSIGNED && it.ownerEmail) return false;
  if (allowIds && !allowIds.has(it.id)) return false;
  if (f.priority) {
    const due = it.dueAt
      ? (it.dueAt instanceof Date ? it.dueAt : new Date(it.dueAt)).getTime() - Date.now() < WEEK_MS
      : false;
    if (!it.highPriority && !due) return false;
  }
  return true;
}

function LabelChips({ labels }: { labels: LabelChip[] }) {
  if (!labels || labels.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {labels.map((l) => (
        <span
          key={l.id}
          className="rounded px-1.5 py-0.5 text-[10px] font-medium"
          style={{
            background: l.color ? `${l.color}22` : "#EEE",
            color: l.color ?? "#555",
            border: `1px solid ${l.color ?? "#DDD"}55`,
          }}
        >
          {l.name}
        </span>
      ))}
    </span>
  );
}

// --- List view ---------------------------------------------------------------

function ListView({
  items,
  now,
  labelsByItem,
}: {
  items: WorkItem[];
  now: Date;
  labelsByItem: LabelMap;
}) {
  const titleById = new Map(items.map((i) => [i.id, i.title]));
  const groups = BOARD_COLUMNS.map((col) => ({
    col,
    rows: items.filter((i) => columnOf(i.status) === col),
  }));
  return (
    <div className="mt-4 overflow-x-auto rounded-xl border border-zinc-200 bg-white">
      <table className="w-full text-sm">
        {groups.map(({ col, rows }) => (
          <tbody key={col}>
            <tr style={{ background: "#F7F4F7" }}>
              <td
                colSpan={5}
                className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide"
                style={{ color: COLUMN_ACCENT[col] }}
              >
                {col} <span className="text-zinc-400">· {rows.length}</span>
              </td>
            </tr>
            {rows.map((it) => {
              const high = effectiveHighPriority(it, now);
              return (
                <tr
                  key={it.id}
                  className="border-t border-zinc-100"
                  style={high ? { background: "#FCF3E7" } : undefined}
                >
                  <td className="px-3 py-1.5">
                    {it.parentId && <span className="text-zinc-300">↳ </span>}
                    <a
                      href={`/board/${it.id}`}
                      className="font-medium text-zinc-900 no-underline hover:underline"
                    >
                      {it.title}
                    </a>
                    {it.parentId && titleById.get(it.parentId) && (
                      <span className="ml-1 text-[11px] text-zinc-400">
                        · of {titleById.get(it.parentId)}
                      </span>
                    )}
                    <span className="ml-2">
                      <LabelChips labels={labelsByItem.get(it.id) ?? []} />
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-xs text-zinc-500">
                    {KIND_LABEL[it.kind] ?? it.kind}
                  </td>
                  <td className="px-2 py-1.5 text-xs text-zinc-500">
                    {it.customerSlug ?? ""}
                  </td>
                  <td className="px-2 py-1.5 text-xs">
                    <Assignee
                      email={it.ownerEmail}
                      botAssigned={it.botAssigned}
                      size={16}
                    />
                  </td>
                  <td className="px-2 py-1.5 text-right text-xs">
                    <span className="inline-flex items-center gap-2">
                      <AgingBadge item={it} now={now} />
                      {it.dueAt && (
                        <span className={dueLabel(it.dueAt).cls}>
                          {dueLabel(it.dueAt).text}
                        </span>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr className="border-t border-zinc-100">
                <td colSpan={5} className="px-3 py-2 text-xs text-zinc-300">
                  nothing here
                </td>
              </tr>
            )}
          </tbody>
        ))}
      </table>
    </div>
  );
}

// --- Recap bar (board-scoped) ------------------------------------------------

function RecapBar({
  summary,
  focusTitle,
}: {
  summary: BoardSummary;
  focusTitle: string | null;
}) {
  const stat = (n: number, label: string) => (
    <div className="flex flex-col">
      <span className="text-lg font-semibold tabular-nums text-zinc-900">{n}</span>
      <span className="text-[11px] uppercase tracking-wide text-zinc-400">{label}</span>
    </div>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-7 gap-y-3 rounded-xl border border-zinc-200 bg-white px-5 py-3.5">
      {stat(summary.open, "open")}
      {stat(summary.byColumn["Reddy Working"], "working")}
      {stat(summary.byColumn["Reddy Waiting"], "waiting")}
      {stat(summary.done, "done")}
      <div className="ml-auto max-w-sm">
        <p className="text-[11px] uppercase tracking-wide text-zinc-400">Focus today</p>
        <p className="text-sm font-medium text-zinc-900">
          {focusTitle ?? "Board is clear"}
        </p>
      </div>
    </div>
  );
}

// --- Page --------------------------------------------------------------------

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const filters = parseFilters(sp);
  const now = new Date();

  // viewer identity for "My work" + saved views ownership
  const cookieStore = await cookies();
  const asParam = typeof sp.as === "string" ? sp.as : undefined;
  const viewer =
    asParam ||
    cookieStore.get(VIEWER_COOKIE)?.value ||
    process.env.BOARD_DEFAULT_VIEWER ||
    "adam@reddy.io";

  let boards: BoardTab[] = [];
  let board: BoardColumns | null = null;
  let listItems: WorkItem[] = [];
  let summary: BoardSummary | null = null;
  let focusTitle: string | null = null;
  let labelsByItem: LabelMap = new Map();
  let labelOptions: { id: string; name: string; color: string | null }[] = [];
  let savedViews: { id: string; name: string; shared: boolean; spec: unknown }[] = [];
  let owners: string[] = [];
  let unread = 0;
  let error: string | null = null;

  try {
    const boardId = await resolveBoardId(filters.board);

    // assignee resolution → BoardFilter.ownerEmail (or unassigned post-filter)
    let ownerEmail: string | undefined;
    if (filters.mine) ownerEmail = viewer;
    else if (filters.assignee && filters.assignee !== UNASSIGNED)
      ownerEmail = filters.assignee;

    const kindFilter: WorkItemKind[] | undefined = filters.kind
      ? [filters.kind as WorkItemKind]
      : undefined;

    const allowIds = filters.label
      ? new Set(await itemIdsForFilters({ labelId: filters.label }))
      : null;

    // Per-board summary + boards list + the world reads, in parallel.
    const [boardRows, allBoards, digest, allLabels, views] = await Promise.all([
      filters.view === "list"
        ? listWorkItems({
            boardId: boardId ?? undefined,
            ownerEmail,
            customerSlug: filters.customer,
            kind: kindFilter,
          })
        : getBoard({
            boardId: boardId ?? undefined,
            ownerEmail,
            customerSlug: filters.customer,
            kind: kindFilter,
          }),
      listBoards(),
      getDigestData(now),
      listLabels(),
      listViews(viewer),
    ]);

    labelOptions = allLabels.map((l) => ({ id: l.id, name: l.name, color: l.color }));
    savedViews = views.map((v) => ({
      id: v.id,
      name: v.name,
      shared: v.shared,
      spec: v.spec,
    }));
    focusTitle = digest.focusToday ? digest.focusToday.title : null;

    // per-board open counts for the switcher
    const summaries = await Promise.all(
      allBoards.map(async (b) => ({
        key: b.key,
        name: b.name,
        summary: await getBoardSummary(b.id),
      }))
    );
    boards = summaries.map((s) => ({ key: s.key, name: s.name, open: s.summary.open }));
    summary =
      summaries.find((s) => s.key === filters.board)?.summary ??
      (boardId ? await getBoardSummary(boardId) : await getBoardSummary());

    // Gather the rows we'll render, apply the post-fetch filters, collect labels
    // + distinct owners (owners = every assignee on this board, unfiltered).
    let rendered: WorkItem[];
    if (filters.view === "list") {
      rendered = (boardRows as WorkItem[]).filter((it) =>
        passesClientSideFilters(it, filters, allowIds)
      );
      listItems = rendered;
    } else {
      const bc = boardRows as BoardColumns;
      const next = { ...bc } as BoardColumns;
      const flat: WorkItem[] = [];
      for (const col of BOARD_COLUMNS) {
        next[col] = bc[col].filter((it) =>
          passesClientSideFilters(it, filters, allowIds)
        );
        flat.push(...next[col]);
      }
      board = next;
      rendered = flat;
    }

    // distinct owners across the WHOLE board (not the filtered subset) so the
    // dropdown always offers every assignee. One light read.
    const ownerPool = await listWorkItems({ boardId: boardId ?? undefined });
    owners = Array.from(
      new Set(ownerPool.map((i) => i.ownerEmail).filter((e): e is string => !!e))
    ).sort((a, b) => a.localeCompare(b));

    labelsByItem = await labelsFor(rendered.map((i) => i.id));
    unread = await unreadNotificationCount(viewer);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const activeBoardName =
    boards.find((b) => b.key === filters.board)?.name ?? "GTM Board";

  const tab = (v: "kanban" | "list", label: string) => {
    const href = filtersHref({ ...filters, view: v });
    const active = filters.view === v;
    return (
      <a
        href={href}
        className="rounded-md px-2.5 py-1 text-sm no-underline"
        style={active ? { background: PLUM, color: "#fff" } : { color: "#574B59" }}
      >
        {label}
      </a>
    );
  };

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-7">
      <div className="mx-auto max-w-7xl">
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-lg text-lg"
            style={{ background: "#F0E8EF" }}
          >
            🗂️
          </div>
          <div className="mr-2">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-900">
              {activeBoardName}
            </h1>
            <p className="text-sm text-zinc-500">
              Move work through Slack or here. The link is always on.
            </p>
          </div>

          {boards.length > 0 && (
            <BoardSwitcher boards={boards} active={filters.board} view={filters.view} />
          )}

          <div className="ml-auto flex items-center gap-3">
            <Link
              href="/board/inbox"
              className="relative rounded-md border border-zinc-200 bg-white px-2.5 py-1.5 text-sm text-zinc-600 no-underline hover:border-zinc-300"
              title="Notifications"
            >
              Inbox
              {unread > 0 && (
                <span
                  className="ml-1 rounded-full px-1.5 text-[11px] font-semibold tabular-nums text-white"
                  style={{ background: PLUM }}
                >
                  {unread}
                </span>
              )}
            </Link>
            <div className="flex items-center gap-1 rounded-lg border border-zinc-200 bg-white p-0.5">
              {tab("kanban", "Board")}
              {tab("list", "List")}
            </div>
          </div>
        </header>

        {error ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
            <p className="font-semibold">Board not reachable.</p>
            <pre className="mt-2 overflow-x-auto rounded bg-amber-100/60 p-2 font-mono text-[11px]">
              {error}
            </pre>
          </div>
        ) : (
          <>
            {summary && <RecapBar summary={summary} focusTitle={focusTitle} />}

            <FilterBar
              filters={filters}
              owners={owners}
              labels={labelOptions}
              views={savedViews}
              viewer={viewer}
            />

            {filters.view === "kanban" && board ? (
              <BoardClient
                initial={board}
                viewerEmail={viewer}
                labelsByItem={Object.fromEntries(labelsByItem)}
              />
            ) : (
              <ListView items={listItems} now={now} labelsByItem={labelsByItem} />
            )}

            {board && board.dismissedCount > 0 && (
              <p className="mt-3 text-xs text-zinc-400">
                + {board.dismissedCount} archived (dismissed)
              </p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
