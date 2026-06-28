import {
  getBoard,
  getDigestData,
  listWorkItems,
  effectiveHighPriority,
  columnOf,
  BOARD_COLUMNS,
  type BoardColumns,
  type BoardColumn,
  type DigestData,
} from "@/lib/work-items";
import BoardClient from "./BoardClient";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PLUM = "#773D72";

const KIND_LABEL: Record<string, string> = {
  pricing_proposal: "Pricing", deck_qbr: "QBR deck", meeting_prep: "Prep",
  prep_custom_demo: "Demo prep", rfp_response: "RFP", contract_redline: "Redline",
  followup_email: "Follow-up", book_meeting: "Book mtg", reengage_tickler: "Re-engage",
  recording_link: "Recording", scheduling: "Scheduling", account_research: "Research",
  enablement_collateral: "Enablement", crm_update: "CRM", log_to_hubspot: "HubSpot note",
  propose_stage_move: "Stage move", action_items: "Action", generic: "Task",
};

const COLUMN_ACCENT: Record<BoardColumn, string> = {
  Unsorted: "#8A7C8A",
  "To Do": PLUM,
  "Reddy Working": "#3A6B8C",
  "Reddy Waiting": "#B07D2E",
  Completed: "#3F7D5B",
};

function dueLabel(d: Date): { text: string; cls: string } {
  const diff = d.getTime() - Date.now();
  const days = Math.round(diff / 86400000);
  const text = `due ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  if (diff < 0) return { text: `${text} · overdue`, cls: "text-red-700" };
  if (diff < 7 * 86400000) return { text, cls: "text-amber-700" };
  return { text, cls: "text-zinc-400" };
}

async function ListView({ now, owner, customer }: { now: Date; owner?: string; customer?: string }) {
  const items = await listWorkItems({ ownerEmail: owner, customerSlug: customer });
  const titleById = new Map(items.map((i) => [i.id, i.title]));
  const groups = BOARD_COLUMNS.map((col) => ({ col, rows: items.filter((i) => columnOf(i.status) === col) }));
  return (
    <div className="mt-5 overflow-x-auto rounded-xl border border-zinc-200 bg-white">
      <table className="w-full text-sm">
        {groups.map(({ col, rows }) => (
          <tbody key={col}>
            <tr style={{ background: "#F7F4F7" }}>
              <td colSpan={4} className="px-3 py-1.5 text-xs font-semibold uppercase tracking-wide" style={{ color: COLUMN_ACCENT[col] }}>
                {col} <span className="text-zinc-400">· {rows.length}</span>
              </td>
            </tr>
            {rows.map((it) => {
                const high = effectiveHighPriority(it, now);
                return (
                  <tr key={it.id} className="border-t border-zinc-100" style={high ? { background: "#FCF3E7" } : undefined}>
                    <td className="px-3 py-1.5">
                      {it.parentId && <span className="text-zinc-300">↳ </span>}
                      <a href={`/board/${it.id}`} className="font-medium text-zinc-900 no-underline">{it.title}</a>
                      {it.parentId && titleById.get(it.parentId) && (
                        <span className="ml-1 text-[11px] text-zinc-400">· of {titleById.get(it.parentId)}</span>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-xs text-zinc-500">{KIND_LABEL[it.kind] ?? it.kind}</td>
                    <td className="px-2 py-1.5 text-xs text-zinc-500">{it.customerSlug ?? ""}{it.botAssigned ? " 🤖" : ""}</td>
                    <td className="px-2 py-1.5 text-right text-xs">
                      {it.ownerEmail ? <span className="text-zinc-500">{it.ownerEmail.split("@")[0]}</span> : <span className="text-zinc-300">unassigned</span>}
                      {it.dueAt && <span className={`ml-2 ${dueLabel(it.dueAt).cls}`}>{dueLabel(it.dueAt).text}</span>}
                    </td>
                  </tr>
                );
              })}
          </tbody>
        ))}
      </table>
    </div>
  );
}

function RecapBar({ d }: { d: DigestData }) {
  const stat = (n: number, label: string) => (
    <div className="flex flex-col">
      <span className="text-lg font-semibold tabular-nums text-zinc-900">{n}</span>
      <span className="text-[11px] uppercase tracking-wide text-zinc-400">{label}</span>
    </div>
  );
  return (
    <div className="flex flex-wrap items-center gap-x-7 gap-y-3 rounded-xl border border-zinc-200 bg-white px-5 py-3.5">
      {stat(d.summary.open, "open")}
      {stat(d.summary.byColumn["Reddy Working"], "working")}
      {stat(d.summary.byColumn["Reddy Waiting"], "waiting")}
      {stat(d.summary.done, "done")}
      <div className="ml-auto max-w-sm">
        <p className="text-[11px] uppercase tracking-wide text-zinc-400">Focus today</p>
        <p className="text-sm font-medium text-zinc-900">{d.focusToday ? d.focusToday.title : "Board is clear"}</p>
      </div>
    </div>
  );
}

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const view = sp.view === "list" ? "list" : "kanban";
  const owner = typeof sp.owner === "string" ? sp.owner : undefined;
  const customer = typeof sp.customer === "string" ? sp.customer : undefined;
  const now = new Date();

  let board: BoardColumns | null = null;
  let digest: DigestData | null = null;
  let error: string | null = null;
  try {
    [board, digest] = await Promise.all([getBoard({ ownerEmail: owner, customerSlug: customer }), getDigestData(now)]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const tab = (v: string, label: string) => {
    const params = new URLSearchParams();
    if (v === "list") params.set("view", "list");
    if (owner) params.set("owner", owner);
    if (customer) params.set("customer", customer);
    const href = `/board${params.toString() ? `?${params}` : ""}`;
    const active = view === v;
    return (
      <a href={href} className="rounded-md px-2.5 py-1 text-sm no-underline" style={active ? { background: PLUM, color: "#fff" } : { color: "#574B59" }}>{label}</a>
    );
  };

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-7">
      <div className="mx-auto max-w-7xl">
        <header className="mb-5 flex flex-wrap items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg text-lg" style={{ background: "#F0E8EF" }}>🗂️</div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-zinc-900">GTM Board{owner ? ` · ${owner.split("@")[0]}` : ""}{customer ? ` · ${customer}` : ""}</h1>
            <p className="text-sm text-zinc-500">Move work through Slack or here. The link is always on.</p>
          </div>
          <div className="ml-auto flex items-center gap-1 rounded-lg border border-zinc-200 bg-white p-0.5">
            {tab("kanban", "Board")}
            {tab("list", "List")}
          </div>
        </header>

        {error ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
            <p className="font-semibold">Board not reachable.</p>
            <pre className="mt-2 overflow-x-auto rounded bg-amber-100/60 p-2 font-mono text-[11px]">{error}</pre>
          </div>
        ) : (
          <>
            {digest && <RecapBar d={digest} />}
            {view === "kanban" && board ? (
              <BoardClient initial={board} viewerEmail={owner} />
            ) : (
              <ListView now={now} owner={owner} customer={customer} />
            )}
            {board && board.dismissedCount > 0 && (
              <p className="mt-3 text-xs text-zinc-400">+ {board.dismissedCount} archived (dismissed)</p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
