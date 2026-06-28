import {
  getBoard,
  getDigestData,
  type BoardColumns,
  type DigestData,
} from "@/lib/work-items";
import type { WorkItem } from "@/lib/schema";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PLUM = "#773D72";

// ---------------------------------------------------------------------------

const TYPE_LABEL: Record<WorkItem["type"], string> = {
  followup: "Follow-up",
  crm_update: "CRM update",
  prep: "Prep",
  task: "Task",
};

const COLUMNS: { key: keyof BoardColumns; label: string; accent: string; hint: string }[] = [
  { key: "suggested", label: "Suggested", accent: "#B07D2E", hint: "Proposed by the bot — awaiting a human" },
  { key: "approved", label: "Approved", accent: PLUM, hint: "Greenlit — ready to act on" },
  { key: "done", label: "Done", accent: "#3F7D5B", hint: "Completed" },
];

function relTime(d: Date): string {
  const diff = Date.now() - d.getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const days = Math.round(h / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function payloadPreview(item: WorkItem): string | null {
  const p = item.payload as Record<string, unknown> | null;
  if (!p) return null;
  switch (item.type) {
    case "crm_update":
      return `${String(p.object ?? "record")}.${String(p.field ?? "")} → ${String(p.suggestedValue ?? "")}`;
    case "followup":
      return `${String(p.channel ?? "")}${p.dueHint ? ` · ${String(p.dueHint)}` : ""}`;
    case "prep":
      return Array.isArray(p.checklist) ? `${p.checklist.length} item checklist` : null;
    case "task":
      return typeof p.detail === "string" ? p.detail : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------

function Card({ item }: { item: WorkItem }) {
  const preview = payloadPreview(item);
  return (
    <div
      id={`item-${item.id}`}
      className="rounded-lg border border-zinc-200 bg-white p-3 shadow-sm"
    >
      <div className="flex items-center gap-2">
        <span
          className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
          style={{ background: "#F0E8EF", color: PLUM }}
        >
          {TYPE_LABEL[item.type]}
        </span>
        {item.customerSlug && (
          <span className="truncate text-xs text-zinc-500">{item.customerSlug}</span>
        )}
        <span className="ml-auto shrink-0 text-[11px] text-zinc-400">
          {relTime(item.createdAt)}
        </span>
      </div>
      <p className="mt-2 text-sm font-medium leading-snug text-zinc-900">{item.title}</p>
      {preview && (
        <p className="mt-1 font-mono text-[11px] leading-snug text-zinc-500">{preview}</p>
      )}
      <div className="mt-2 flex items-center gap-2 text-[11px] text-zinc-400">
        {item.ownerEmail ? (
          <span>{item.ownerEmail.split("@")[0]}</span>
        ) : (
          <span className="italic">unassigned</span>
        )}
        <span>·</span>
        <span>{item.source.replace("_", " ")}</span>
        {item.status === "suggested" && (
          <span
            className="ml-auto rounded px-1.5 py-0.5 text-[10px] font-medium"
            style={{ background: "#F6EEDD", color: "#8A621F" }}
          >
            not applied
          </span>
        )}
      </div>
    </div>
  );
}

function Column({
  label,
  accent,
  hint,
  items,
}: {
  label: string;
  accent: string;
  hint: string;
  items: WorkItem[];
}) {
  return (
    <section className="flex w-full flex-col gap-3 md:w-80 md:shrink-0">
      <div className="flex items-baseline gap-2 border-b-2 pb-2" style={{ borderColor: accent }}>
        <h2 className="text-sm font-semibold text-zinc-900">{label}</h2>
        <span className="text-xs font-medium text-zinc-400">{items.length}</span>
      </div>
      <p className="-mt-1 text-[11px] text-zinc-400">{hint}</p>
      <div className="flex flex-col gap-2">
        {items.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-200 p-3 text-center text-xs text-zinc-400">
            nothing here
          </p>
        ) : (
          items.map((it) => <Card key={it.id} item={it} />)
        )}
      </div>
    </section>
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
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-xl border border-zinc-200 bg-white px-5 py-4">
      <div className="mr-2">
        <p className="text-xs uppercase tracking-wide text-zinc-400">Yesterday — {d.yesterdayLabel}</p>
        <p className="text-sm text-zinc-600">This is what the 7am digest summarizes</p>
      </div>
      {stat(d.addedYesterday.length, "added")}
      {stat(d.doneYesterday.length, "completed")}
      {stat(d.summary.open, "open")}
      <div className="ml-auto max-w-xs">
        <p className="text-[11px] uppercase tracking-wide text-zinc-400">Focus today</p>
        <p className="text-sm font-medium text-zinc-900">
          {d.focusToday ? d.focusToday.title : "Board is clear"}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

export default async function BoardPage() {
  let board: BoardColumns | null = null;
  let digest: DigestData | null = null;
  let error: string | null = null;
  try {
    [board, digest] = await Promise.all([getBoard(), getDigestData()]);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-8">
      <div className="mx-auto max-w-6xl">
        <header className="mb-6 flex flex-wrap items-center gap-3">
          <div
            className="flex h-9 w-9 items-center justify-center rounded-lg text-lg"
            style={{ background: "#F0E8EF" }}
          >
            🧭
          </div>
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-zinc-900">GTM Tracking Board</h1>
            <p className="text-sm text-zinc-500">
              What the bot is suggesting, what&apos;s greenlit, what&apos;s done.
            </p>
          </div>
          <span
            className="ml-auto rounded-full px-2.5 py-1 text-[11px] font-medium"
            style={{ background: "#F0E8EF", color: PLUM }}
          >
            stub · testing target
          </span>
        </header>

        {error ? (
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-6 text-sm text-amber-900">
            <p className="font-semibold">Board table not reachable yet.</p>
            <p className="mt-1 text-amber-800">
              Apply the <code className="font-mono">work_items</code> migration, then reload.
            </p>
            <pre className="mt-3 overflow-x-auto rounded bg-amber-100/60 p-2 font-mono text-[11px]">
              {error}
            </pre>
          </div>
        ) : (
          <>
            {digest && <RecapBar d={digest} />}
            <div className="mt-6 flex flex-col gap-6 md:flex-row md:overflow-x-auto md:pb-4">
              {COLUMNS.map((c) => (
                <Column
                  key={c.key}
                  label={c.label}
                  accent={c.accent}
                  hint={c.hint}
                  items={board ? board[c.key] : []}
                />
              ))}
            </div>
            {board && board.dismissed.length > 0 && (
              <p className="mt-4 text-xs text-zinc-400">
                + {board.dismissed.length} dismissed
              </p>
            )}
          </>
        )}
      </div>
    </main>
  );
}
