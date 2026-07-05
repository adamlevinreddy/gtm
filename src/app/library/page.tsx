import type { Metadata } from "next";
import { FileText, Download, Folder, ExternalLink } from "lucide-react";
import { listLibraryFiles, latestPointers, type LibraryFile } from "@/lib/library";
import { listSharedDrive, DRIVE_FOLDER_ID } from "@/lib/gdrive";
import { fmtDayPT } from "@/lib/fmt";
import { PLUM, BORDER, BORDER_SOFT, PLUM_TINT } from "@/lib/tokens";
import AppShell, { resolveViewer } from "@/app/AppShell";
import Gate from "@/app/Gate";
import CopyButton from "@/components/CopyButton";
import { Link2 } from "lucide-react";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

export const metadata: Metadata = { title: "Library" };

// /library — the team knowledge base, self-serve (Daybreak Phase 11).
// Pricing sheets, proposals, legal precedent, RFP answers: find and
// download without asking the bot (or Adam).

function fmtSize(n: number | null): string {
  if (!n) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function prettyCat(s: string): string {
  return s.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export default async function LibraryPage() {
  const viewer = await resolveViewer();
  if (!viewer) return <Gate />;

  const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;
  const [files, drive] = await Promise.all([
    pat ? listLibraryFiles(pat).catch(() => []) : Promise.resolve([]),
    listSharedDrive().catch(() => null),
  ]);
  const latest = pat ? await latestPointers(pat, files).catch(() => new Map()) : new Map();

  const byCategory = new Map<string, LibraryFile[]>();
  for (const f of files) {
    (byCategory.get(f.category) ?? byCategory.set(f.category, []).get(f.category)!).push(f);
  }
  const categories = [...byCategory.entries()].sort(([a], [b]) => a.localeCompare(b));
  const base = process.env.PUBLIC_BASE_URL ?? "https://reddy-gtm.com";

  return (
    <AppShell
      active="library"
      viewer={viewer}
      title="Library"
      subtitle="The team knowledge base — pricing, proposals, legal, RFP answers. Click to preview, download, or share."
      maxWidth="max-w-5xl"
    >
      <div className="flex flex-col gap-5">
        {/* Shared Google Drive — everyone already has access; we link out. */}
        <section className="rounded-xl border bg-white" style={{ borderColor: BORDER }}>
          <div className="flex items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: BORDER_SOFT }}>
            <h2 className="text-sm font-semibold" style={{ color: PLUM }}>Google Drive</h2>
            <a
              href={`https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}`}
              target="_blank"
              rel="noreferrer"
              className="ml-auto inline-flex items-center gap-1 text-xs text-zinc-400 no-underline hover:text-zinc-600"
            >
              open folder <ExternalLink size={11} />
            </a>
          </div>
          {drive === null ? (
            <p className="px-4 py-4 text-sm text-zinc-400">
              Drive listing unavailable — the service account&apos;s Google Drive isn&apos;t connected yet
              (run <code>/reddy-connect</code> in Slack as adam@ and connect Google Drive). The{" "}
              <a
                href={`https://drive.google.com/drive/folders/${DRIVE_FOLDER_ID}`}
                target="_blank"
                rel="noreferrer"
                style={{ color: PLUM }}
              >
                shared folder
              </a>{" "}
              still opens directly.
            </p>
          ) : drive.length === 0 ? (
            <p className="px-4 py-4 text-sm text-zinc-400">The shared folder is empty.</p>
          ) : (
            <div>
              {drive.map((f) => (
                <a
                  key={f.id}
                  href={f.webViewLink}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-3 border-b px-4 py-2 no-underline last:border-b-0 hover:bg-zinc-50"
                  style={{ borderColor: "#F1EBF0" }}
                >
                  {f.folder ? (
                    <Folder size={14} className="shrink-0" style={{ color: PLUM }} />
                  ) : (
                    <FileText size={14} className="shrink-0 text-zinc-400" />
                  )}
                  <span className="min-w-0 flex-1 truncate text-sm text-zinc-900">{f.name}</span>
                  {f.modifiedTime && (
                    <span className="shrink-0 text-xs text-zinc-400">{fmtDayPT(f.modifiedTime)}</span>
                  )}
                  <ExternalLink size={12} className="shrink-0 text-zinc-300" />
                </a>
              ))}
            </div>
          )}
          <p className="border-t px-4 py-2 text-xs text-zinc-400" style={{ borderColor: "#F1EBF0" }}>
            Tip: tell the bot “save this in our Drive folder for this customer” and it files the
            deliverable into a customer subfolder here too.
          </p>
        </section>

        {categories.map(([cat, list]) => (
          <section key={cat} className="rounded-xl border bg-white" style={{ borderColor: BORDER }}>
            <div className="flex items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: BORDER_SOFT }}>
              <h2 className="text-sm font-semibold" style={{ color: PLUM }}>{prettyCat(cat)}</h2>
              <span className="text-xs text-zinc-400">{list.length} file{list.length === 1 ? "" : "s"}</span>
            </div>
            <div>
              {list.map((f) => {
                const href = `/api/library/file?path=${encodeURIComponent(f.path)}`;
                return (
                  <div
                    key={f.path}
                    className="group flex items-center gap-3 border-b px-4 py-2 last:border-b-0 hover:bg-zinc-50"
                    style={{ borderColor: "#F1EBF0" }}
                  >
                    <FileText size={14} className="shrink-0 text-zinc-400" />
                    <a href={href} target="_blank" rel="noreferrer" className="min-w-0 flex-1 no-underline">
                      <span className="block truncate text-sm text-zinc-900">
                        {f.name}
                        {latest.has(f.path) && (
                          <span
                            className="ml-1.5 rounded px-1 py-px align-middle text-[9.5px] font-semibold tracking-wide"
                            style={{ background: "#E9F5EE", color: "#3F7D5B" }}
                            title={`Locked as latest${latest.get(f.path)?.account ? ` for ${latest.get(f.path)!.account}` : ""} by ${latest.get(f.path)?.lockedBy ?? "?"}`}
                          >
                            LATEST
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-xs text-zinc-500">
                        {f.subpath && (
                          <span className="mr-1.5 rounded px-1 py-px text-[10.5px]" style={{ background: PLUM_TINT, color: PLUM }}>
                            {f.subpath}
                          </span>
                        )}
                        {f.ext.toUpperCase()}
                        {f.sizeBytes ? ` · ${fmtSize(f.sizeBytes)}` : ""}
                      </span>
                    </a>
                    <span className="flex shrink-0 items-center gap-1.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
                      <CopyButton
                        text={`${base}${href}`}
                        label="Copy link"
                        icon={<Link2 size={12} />}
                        title="Team-only link (viewers must be signed in)"
                      />
                      <a
                        href={`${href}&dl=1`}
                        className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs font-medium text-zinc-600 no-underline transition-colors hover:bg-zinc-50"
                        style={{ borderColor: BORDER }}
                      >
                        <Download size={12} /> Download
                      </a>
                    </span>
                  </div>
                );
              })}
            </div>
          </section>
        ))}
        {categories.length === 0 && (
          <p className="rounded-xl border bg-white px-4 py-10 text-center text-sm text-zinc-400" style={{ borderColor: BORDER }}>
            Nothing in the library yet — files the bot saves (and anything committed under <code>corpora/</code>) appear here.
          </p>
        )}
      </div>
    </AppShell>
  );
}
