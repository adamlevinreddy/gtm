import Link from "next/link";
import type { Metadata } from "next";
import { inArray, eq, and } from "drizzle-orm";
import { Building2, FileText, Download, ExternalLink } from "lucide-react";
import { db } from "@/lib/db";
import { workItems } from "@/lib/schema";
import { OPEN_STATUSES } from "@/lib/work-items";
import { labeledMeetings } from "@/lib/meeting-accounts";
import { listLibraryFiles, latestPointers } from "@/lib/library";
import { canonicalizeCompany } from "@/lib/hubspot";
import { kv } from "@/lib/kv-client";
import { signedThumbUrl } from "@/lib/mux";
import { fmtDayPT } from "@/lib/fmt";
import { PLUM, PLUM_TINT, BORDER, BORDER_SOFT, OK } from "@/lib/tokens";
import AppShell, { resolveViewer } from "@/app/AppShell";
import Gate from "@/app/Gate";
import MeetingRow, { type MeetingRowData } from "@/components/MeetingRow";
import AccountAsk from "./AccountAsk";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export const metadata: Metadata = { title: "Account" };

// /a/{slug} — accounts as a FILTER over shared components (Daybreak P13):
// cached HubSpot facts, this account's meetings, artifacts, and open
// commitments — zero new data machinery, answerable without the agent.

const pretty = (s: string) => s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

type HubFacts = { id: string; name: string; domain: string | null } | null;

async function hubspotFacts(name: string): Promise<HubFacts> {
  const ck = `acctfacts:v2:${slugify(name)}`;
  // Sentinel wrapper: a cached MISS must be distinguishable from "not
  // cached" (kv returns null for both), or unmatched accounts would hit
  // the HubSpot search API on every render.
  const cached = await kv.get<{ facts: HubFacts }>(ck).catch(() => null);
  if (cached) return cached.facts;
  const c = await canonicalizeCompany(name).catch(() => null);
  const facts: HubFacts = c ? { id: c.id, name: c.name, domain: c.domain ?? null } : null;
  await kv.set(ck, { facts }, { ex: 24 * 3600 }).catch(() => {});
  return facts;
}

export default async function AccountPage({ params }: { params: Promise<{ slug: string }> }) {
  const viewer = await resolveViewer();
  if (!viewer) return <Gate />;

  const { slug: rawSlug } = await params;
  const slug = slugify(decodeURIComponent(rawSlug));
  const display = pretty(slug);

  const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;
  const [labeled, facts, files, tasks] = await Promise.all([
    pat ? labeledMeetings(pat, 90, 400) : Promise.resolve({ meetings: [], uncachedEvidence: [] }),
    hubspotFacts(display),
    pat ? listLibraryFiles(pat).catch(() => []) : Promise.resolve([]),
    db
      .select({ id: workItems.id, title: workItems.title, status: workItems.status, ownerEmail: workItems.ownerEmail })
      .from(workItems)
      .where(and(eq(workItems.customerSlug, slug), inArray(workItems.status, [...OPEN_STATUSES])))
      .limit(20)
      .catch(() => []),
  ]);

  // This account's meetings: slug match OR canonical-label match.
  const meetings = labeled.meetings.filter(
    (m) => slugify(m.customer_slug) === slug || slugify(m.account) === slug,
  );
  const rows: MeetingRowData[] = meetings.map((m) => ({
    botId: m.bot_id,
    title: m.title,
    slug: m.customer_slug,
    account: m.account,
    isInternal: m.isInternal,
    startedAt: m.started_at,
    endedAt: m.ended_at,
    attendees: m.attendees.map((a) => a.name || a.email || "").filter(Boolean),
    hasTranscript: m.has_transcript,
    hasVideo: m.has_video,
    thumbUrl: signedThumbUrl(m.mux_playback_id),
    tasks: [],
  }));

  // Deliverable dirs are TITLE slugs ("advensus-pricing-proposal"), not
  // account slugs — match the account as a hyphen-delimited token so
  // normally-titled files actually surface here.
  const artifacts = files.filter((f) => {
    if (f.category !== "deliverables") return false;
    const dir = f.subpath.split("/")[0] ?? "";
    return dir === slug || `-${dir}-`.includes(`-${slug}-`);
  });
  const latest = pat && artifacts.length ? await latestPointers(pat, artifacts).catch(() => new Map()) : new Map();

  const chatIds = meetings.filter((m) => m.has_transcript).map((m) => m.bot_id);
  const shareBase = process.env.PUBLIC_BASE_URL ?? "https://gtm-jet.vercel.app";
  const sparse = meetings.length < 3;

  return (
    <AppShell
      active="meetings"
      viewer={viewer}
      title={facts?.name ?? display}
      subtitle={
        facts?.domain ? `${facts.domain} · ${meetings.length} meeting${meetings.length === 1 ? "" : "s"} in 90 days` : `${meetings.length} meeting${meetings.length === 1 ? "" : "s"} in 90 days`
      }
      actions={
        <>
          {facts?.id && (
            <a
              href={`https://app.hubspot.com/contacts/39896015/record/0-2/${facts.id}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg border bg-white px-2.5 py-1.5 text-sm text-zinc-600 no-underline hover:border-zinc-300"
              style={{ borderColor: BORDER }}
            >
              <ExternalLink size={13} /> HubSpot
            </a>
          )}
          <AccountAsk account={facts?.name ?? display} botIds={chatIds} />
        </>
      }
      maxWidth="max-w-5xl"
    >
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        {/* meetings */}
        <section className="lg:col-span-2">
          <div className="overflow-hidden rounded-xl border bg-white" style={{ borderColor: BORDER }}>
            <div className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: BORDER_SOFT }}>
              <h2 className="text-sm font-semibold" style={{ color: PLUM }}>Meetings</h2>
              <Link href={`/meetings?days=90&account=${encodeURIComponent(display)}`} className="text-xs text-zinc-400 no-underline hover:text-zinc-600">
                open in meetings →
              </Link>
            </div>
            {rows.map((m) => (
              <MeetingRow key={m.botId} m={m} shareBase={shareBase} />
            ))}
            {rows.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-zinc-400">
                No meetings tagged to this account in the last 90 days.
              </p>
            )}
          </div>
          {sparse && rows.length > 0 && (
            <p className="mt-2 px-1 text-xs text-zinc-400">
              Thin history — not enough data for momentum signals yet.
            </p>
          )}
        </section>

        {/* right rail: commitments + artifacts */}
        <div className="flex flex-col gap-5">
          <section className="rounded-xl border bg-white" style={{ borderColor: BORDER }}>
            <div className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: BORDER_SOFT }}>
              <h2 className="text-sm font-semibold" style={{ color: PLUM }}>Open commitments</h2>
              <Link href={`/board?customer=${slug}`} className="text-xs text-zinc-400 no-underline hover:text-zinc-600">
                board →
              </Link>
            </div>
            <div className="divide-y" style={{ borderColor: "#F4EEF3" }}>
              {tasks.map((t) => (
                <Link key={t.id} href={`/board/${t.id}`} className="block px-4 py-2 no-underline hover:bg-zinc-50">
                  <p className="truncate text-sm text-zinc-900">{t.title}</p>
                  <p className="text-xs text-zinc-500">
                    {t.status.replace(/_/g, " ")}
                    {t.ownerEmail ? ` · ${t.ownerEmail.split("@")[0]}` : ""}
                  </p>
                </Link>
              ))}
              {tasks.length === 0 && (
                <p className="px-4 py-5 text-center text-sm text-zinc-400">Nothing open.</p>
              )}
            </div>
          </section>

          <section className="rounded-xl border bg-white" style={{ borderColor: BORDER }}>
            <div className="flex items-center justify-between border-b px-4 py-2.5" style={{ borderColor: BORDER_SOFT }}>
              <h2 className="text-sm font-semibold" style={{ color: PLUM }}>Deliverables</h2>
              <Link href="/library" className="text-xs text-zinc-400 no-underline hover:text-zinc-600">
                library →
              </Link>
            </div>
            <div className="divide-y" style={{ borderColor: "#F4EEF3" }}>
              {artifacts.map((f) => {
                const href = `/api/library/file?path=${encodeURIComponent(f.path)}`;
                return (
                  <div key={f.path} className="flex items-center gap-2 px-4 py-2">
                    <FileText size={13} className="shrink-0 text-zinc-400" />
                    <a href={href} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-sm text-zinc-900 no-underline hover:underline">
                      {f.name}
                    </a>
                    {latest.has(f.path) && (
                      <span className="shrink-0 rounded px-1 py-px text-[9.5px] font-semibold" style={{ background: "#E9F5EE", color: OK }}>
                        LATEST
                      </span>
                    )}
                    <a href={`${href}&dl=1`} className="shrink-0 text-zinc-400 hover:text-zinc-700" aria-label={`Download ${f.name}`}>
                      <Download size={13} />
                    </a>
                  </div>
                );
              })}
              {artifacts.length === 0 && (
                <p className="px-4 py-5 text-center text-sm text-zinc-400">
                  No saved deliverables yet — files the bot builds land here when locked.
                </p>
              )}
            </div>
          </section>

          {!facts && (
            <p className="flex items-center gap-1.5 px-1 text-xs text-zinc-400">
              <Building2 size={12} /> Not matched to a HubSpot company yet.
            </p>
          )}
        </div>
      </div>
    </AppShell>
  );
}
