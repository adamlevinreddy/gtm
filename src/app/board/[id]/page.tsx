import { eq, asc } from "drizzle-orm";
import Link from "next/link";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { workItemDrafts } from "@/lib/schema";
import {
  getItem,
  getChildren,
  getActivities,
  columnOf,
  effectiveHighPriority,
} from "@/lib/work-items";
import type { WorkItem, WorkItemActivity } from "@/lib/schema";

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

const STATUS_LABEL: Record<string, string> = {
  triage: "Triage", suggested: "Suggested", approved: "To Do",
  in_progress: "In progress", ready_for_review: "Ready for review",
  blocked: "Blocked", waiting: "Waiting", done: "Done", dismissed: "Dismissed",
};

const ACTIVITY_GLYPH: Record<string, string> = {
  created: "✦", status_change: "→", stage_changed: "→", field_change: "✎",
  assignment: "👤", comment: "💬", logged_activity: "•", bot_run: "🤖",
  bot_draft: "📝", artifact: "📎", email_drafted: "✉️", email_forwarded: "↪",
  email_received: "📥", hubspot_sync: "🔗", due_change: "📅", conflict: "⚠",
  conflict_resolved: "✓", cascade_deferred: "⏸", cascade_skipped: "⏭",
};

function fmtPT(d: Date | null): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short", day: "numeric", year: "numeric",
    hour: "numeric", minute: "2-digit",
  }).format(d) + " PT";
}
function fmtPTDate(d: Date | null): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", month: "short", day: "numeric", year: "numeric",
  }).format(d) + " PT";
}

function statusBadge(item: WorkItem) {
  const col = columnOf(item.status);
  const accent: Record<string, string> = {
    Unsorted: "#8A7C8A", "To Do": PLUM, "Reddy Working": "#3A6B8C",
    "Reddy Waiting": "#B07D2E", Completed: "#3F7D5B",
  };
  const color = col ? accent[col] : "#A84A4A";
  return (
    <span
      className="rounded-md px-2 py-0.5 text-xs font-semibold"
      style={{ background: `${color}1A`, color }}
    >
      {STATUS_LABEL[item.status] ?? item.status}
    </span>
  );
}

function MetaRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] uppercase tracking-wide text-zinc-400">{label}</span>
      <span className="text-sm text-zinc-800">{value}</span>
    </div>
  );
}

function ActivityLine({ a }: { a: WorkItemActivity }) {
  const isComment = a.kind === "comment";
  const glyph = ACTIVITY_GLYPH[a.kind] ?? "•";
  const who = a.actorEmail ? a.actorEmail.split("@")[0] : a.actorKind;
  return (
    <li className="flex gap-2.5">
      <span
        className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px]"
        style={{ background: isComment ? "#F0E8EF" : "#F4F4F5", color: isComment ? PLUM : "#71717a" }}
      >
        {glyph}
      </span>
      <div className="min-w-0 flex-1">
        {isComment ? (
          <div className="rounded-lg border border-zinc-200 bg-white px-3 py-2">
            <p className="whitespace-pre-wrap text-sm text-zinc-800">{a.body}</p>
          </div>
        ) : (
          <p className="text-sm text-zinc-700">{a.body || a.kind.replace(/_/g, " ")}</p>
        )}
        <p className="mt-0.5 text-[11px] text-zinc-400">
          {who} · {fmtPT(a.occurredAt)}
        </p>
      </div>
    </li>
  );
}

export default async function WorkItemDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const item = await getItem(id);
  if (!item) notFound();

  const now = new Date();
  const [children, activities, parent, drafts] = await Promise.all([
    getChildren(id),
    getActivities(id),
    item.parentId ? getItem(item.parentId) : Promise.resolve(null),
    db
      .select()
      .from(workItemDrafts)
      .where(eq(workItemDrafts.workItemId, id))
      .orderBy(asc(workItemDrafts.createdAt)),
  ]);

  const high = effectiveHighPriority(item, now);

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-7">
      <div className="mx-auto max-w-3xl">
        {/* breadcrumb */}
        <nav className="mb-4 flex items-center gap-1.5 text-sm text-zinc-400">
          <Link href="/board" className="no-underline hover:underline" style={{ color: "#574B59" }}>Board</Link>
          {parent && (
            <>
              <span>/</span>
              <a href={`/board/${parent.id}`} className="truncate no-underline hover:underline" style={{ color: "#574B59" }}>
                {parent.title}
              </a>
            </>
          )}
          <span>/</span>
          <span className="truncate text-zinc-500">{item.title}</span>
        </nav>

        {/* header */}
        <header
          className="rounded-xl border bg-white p-5"
          style={high ? { borderColor: "#E8C99A", borderLeft: "4px solid #B07D2E" } : { borderColor: "#E4DCE3" }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span
              className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
              style={{ background: "#F0E8EF", color: PLUM }}
            >
              {KIND_LABEL[item.kind] ?? item.kind}
            </span>
            {statusBadge(item)}
            {item.customerSlug && <span className="text-xs text-zinc-500">{item.customerSlug}</span>}
            {high && (
              <span className="rounded px-1.5 py-0.5 text-[10px] font-semibold" style={{ background: "#FCF3E7", color: "#B07D2E" }}>
                HIGH PRIORITY
              </span>
            )}
          </div>
          <h1 className="mt-2 text-xl font-semibold leading-snug tracking-tight text-zinc-900">{item.title}</h1>
          <div className="mt-1.5 flex items-center gap-2 text-sm text-zinc-500">
            <span>{item.ownerEmail ?? "unassigned"}</span>
            {item.botAssigned && <span title="bot co-assigned">🤖 Reddy co-assigned</span>}
          </div>

          {typeof item.payload === "object" && item.payload !== null && "detail" in item.payload && (item.payload as { detail?: string }).detail && (
            <p className="mt-3 whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 text-sm text-zinc-700">
              {(item.payload as { detail?: string }).detail}
            </p>
          )}

          {/* meta */}
          <div className="mt-4 grid grid-cols-2 gap-4 border-t border-zinc-100 pt-4 sm:grid-cols-4">
            <MetaRow label="Created" value={fmtPTDate(item.createdAt)} />
            <MetaRow label="Due" value={item.dueAt ? fmtPTDate(item.dueAt) : "—"} />
            <MetaRow label="In stage since" value={fmtPT(item.stageEnteredAt)} />
            <MetaRow label="Source" value={item.source} />
          </div>
        </header>

        {/* source meeting — watch the recording, read the transcript, ask Claude */}
        {item.source === "post_meeting" && item.sourceRef && (
          <section className="mt-5">
            <Link
              href={`/board/meeting/${item.sourceRef}${item.customerSlug ? `?from=${item.id}&customer=${item.customerSlug}` : `?from=${item.id}`}`}
              className="flex items-center gap-3 rounded-xl border px-4 py-3 no-underline transition-colors hover:bg-white"
              style={{ borderColor: "#E4DCE3", background: "#FBF8FB" }}
            >
              <span className="text-lg">🎥</span>
              <span className="flex flex-col">
                <span className="text-sm font-semibold" style={{ color: PLUM }}>
                  From a meeting — watch the recording &amp; read the transcript
                </span>
                <span className="text-xs text-zinc-500">
                  Open the meeting viewer to play the video, read the transcript, and ask Claude about it.
                </span>
              </span>
              <span className="ml-auto text-sm" style={{ color: PLUM }}>
                Open ↗
              </span>
            </Link>
          </section>
        )}

        {/* draft panel */}
        {drafts.length > 0 && (
          <section className="mt-5">
            <div className="rounded-xl border" style={{ borderColor: "#E4DCE3", background: "#FBF8FB" }}>
              <div className="flex items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: "#EFE5EE" }}>
                <span>📝</span>
                <h2 className="text-sm font-semibold" style={{ color: PLUM }}>Reddy bot first pass — review before sending</h2>
              </div>
              <div className="flex flex-col divide-y" style={{ borderColor: "#EFE5EE" }}>
                {drafts.map((d) => (
                  <article key={d.id} className="px-4 py-3">
                    {d.title && <p className="text-sm font-medium text-zinc-900">{d.title}</p>}
                    {d.body && <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-700">{d.body}</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-zinc-400">
                      {d.kind && <span className="rounded bg-white px-1.5 py-0.5 text-zinc-500">{d.kind}</span>}
                      <span>by {d.producedBy}{d.actedAsEmail ? ` as ${d.actedAsEmail}` : ""}</span>
                      <span>{fmtPT(d.createdAt)}</span>
                      {d.artifactUrl && (
                        <a href={d.artifactUrl} className="no-underline hover:underline" style={{ color: PLUM }} target="_blank" rel="noreferrer">
                          open artifact ↗
                        </a>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            </div>
          </section>
        )}

        {/* subtasks */}
        {children.length > 0 && (
          <section className="mt-5">
            <h2 className="mb-2 text-sm font-semibold text-zinc-900">
              Subtasks <span className="text-zinc-400">· {item.childTotalCount - item.childOpenCount}/{item.childTotalCount} done</span>
            </h2>
            <ul className="flex flex-col gap-1.5">
              {children.map((c) => (
                <li key={c.id} className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white px-3 py-2">
                  <span
                    className="rounded px-1 py-0.5 text-[9px] font-semibold uppercase tracking-wide"
                    style={{ background: "#F0E8EF", color: PLUM }}
                  >
                    {KIND_LABEL[c.kind] ?? c.kind}
                  </span>
                  <a href={`/board/${c.id}`} className="min-w-0 flex-1 truncate text-sm text-zinc-900 no-underline hover:underline">
                    {c.title}
                  </a>
                  {statusBadge(c)}
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* activity feed */}
        <section className="mt-5">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900">Activity</h2>
          {activities.length === 0 ? (
            <p className="rounded-lg border border-dashed border-zinc-200 p-4 text-center text-xs text-zinc-300">No activity yet</p>
          ) : (
            <ol className="flex flex-col gap-3">
              {activities.map((a) => (
                <ActivityLine key={a.id} a={a} />
              ))}
            </ol>
          )}
        </section>
      </div>
    </main>
  );
}
