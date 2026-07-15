"use client";

import { useRef, useState } from "react";
import { Upload, FileText, Check, Loader2, ExternalLink } from "lucide-react";
import { PLUM, PLUM_TINT, BORDER, BORDER_SOFT } from "@/lib/tokens";
import MeetingChatStream from "@/components/MeetingChatStream";
import {
  MARKETING_MODES,
  MARKETING_MODE_ORDER,
  MARKETING_FOOTER_ACTIONS,
  marketingChatEndpoint,
  type MarketingMode,
} from "@/lib/marketing-chat";

type LibraryFile = {
  path: string;
  name: string;
  category: string;
  subpath: string;
  sizeBytes: number | null;
  ext: string;
};

function fmtSize(n: number | null): string {
  if (!n && n !== 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const fileHref = (path: string) => `/api/library/file?path=${encodeURIComponent(path)}`;

export default function MarketingClient({ materials }: { materials: LibraryFile[] }) {
  // Mode-first: pick what you're making, THEN the chat opens with that mode's
  // suggested prompts, plays, and server-side context. null = chooser screen.
  const [mode, setMode] = useState<MarketingMode | null>(null);
  const [files, setFiles] = useState<LibraryFile[]>(materials);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<Set<string>>(new Set());
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setBusy(true);
    setNote(null);
    const added = new Set(justAdded);
    for (const file of Array.from(list).slice(0, 20)) {
      setNote(`Saving ${file.name}…`);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/marketing/upload", { method: "POST", body: fd });
        const j = (await res.json().catch(() => null)) as
          | { ok?: boolean; name?: string; path?: string; size?: number; error?: string }
          | null;
        if (!res.ok || !j?.ok || !j.path) {
          setNote(`Couldn't save ${file.name}: ${j?.error || `HTTP ${res.status}`}`);
          continue;
        }
        const entry: LibraryFile = {
          path: j.path,
          name: j.name || file.name,
          category: "marketing",
          subpath: "uploads",
          sizeBytes: j.size ?? file.size,
          ext: (j.name || file.name).split(".").pop()?.toLowerCase() ?? "",
        };
        setFiles((prev) => [entry, ...prev.filter((f) => f.path !== entry.path)]);
        added.add(entry.path);
        setNote(null);
      } catch (err) {
        setNote(`Couldn't save ${file.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    setJustAdded(added);
    setBusy(false);
    if (inputRef.current) inputRef.current.value = "";
  };

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
      {/* The Fable studio: mode chooser first, then the chat primed for that mode */}
      <div
        className="flex h-[calc(100vh-220px)] min-h-[540px] flex-col overflow-hidden rounded-xl border bg-white"
        style={{ borderColor: BORDER }}
      >
        {mode === null ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
            <div className="text-center">
              <h2 className="text-lg font-semibold" style={{ color: PLUM }}>
                What are we making?
              </h2>
              <p className="mt-1 text-sm text-zinc-500">
                Pick a lane and the studio loads the right playbook — or go freeform.
              </p>
            </div>
            <div className="grid w-full max-w-2xl grid-cols-1 gap-3 sm:grid-cols-3">
              {MARKETING_MODE_ORDER.map((m) => {
                const cfg = MARKETING_MODES[m];
                return (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setMode(m)}
                    className="flex flex-col items-center gap-2 rounded-xl border px-4 py-6 text-center transition-colors hover:border-zinc-400"
                    style={{ borderColor: BORDER, background: "#FAFAFA" }}
                  >
                    <span aria-hidden className="text-2xl leading-none">{cfg.emoji}</span>
                    <span className="text-sm font-semibold text-zinc-800">{cfg.label}</span>
                    <span className="text-xs leading-snug text-zinc-500">{cfg.blurb}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <>
            <div
              className="flex shrink-0 items-center justify-between border-b px-4 py-2"
              style={{ borderColor: BORDER_SOFT, background: PLUM_TINT }}
            >
              <span className="text-xs font-medium" style={{ color: PLUM }}>
                {MARKETING_MODES[mode].emoji} {MARKETING_MODES[mode].label}
              </span>
              <button
                type="button"
                onClick={() => setMode(null)}
                className="text-xs text-zinc-400 hover:text-zinc-600"
              >
                ← change (starts a new session)
              </button>
            </div>
            <div className="min-h-0 flex-1">
              <MeetingChatStream
                key={mode}
                unscoped
                endpoint={marketingChatEndpoint(mode)}
                playIds={MARKETING_MODES[mode].playIds}
                {...(MARKETING_MODES[mode].suggestPlay ? { suggestPlay: MARKETING_MODES[mode].suggestPlay } : {})}
                title="Marketing studio · Fable"
                scopeLabel="Fable"
                placeholder={MARKETING_MODES[mode].placeholder}
                persist
                showCost
                sessionScope={{ label: "Marketing", source: "marketing", mode }}
                starters={MARKETING_MODES[mode].starters}
                footerActions={MARKETING_FOOTER_ACTIONS}
              />
            </div>
          </>
        )}
      </div>

      {/* Marketing library + upload */}
      <div className="flex flex-col gap-4">
        <section className="rounded-xl border bg-white" style={{ borderColor: BORDER }}>
          <div className="border-b px-4 py-3" style={{ borderColor: BORDER_SOFT }}>
            <h2 className="text-sm font-semibold" style={{ color: PLUM }}>Add marketing materials</h2>
            <p className="mt-0.5 text-xs text-zinc-500">
              Drop in anything missing — brand docs, briefs, one-sheets, prior posts. Saved to the library and loaded into every future session.
            </p>
          </div>
          <div className="p-4">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void upload(e.dataTransfer.files);
              }}
              disabled={busy}
              className="flex w-full flex-col items-center gap-2 rounded-lg border-2 border-dashed px-4 py-6 text-center transition-colors disabled:opacity-60"
              style={{
                borderColor: dragging ? PLUM : BORDER,
                background: dragging ? PLUM_TINT : "#FAFAFA",
              }}
            >
              {busy ? (
                <Loader2 size={20} className="animate-spin" style={{ color: PLUM }} />
              ) : (
                <Upload size={20} style={{ color: PLUM }} />
              )}
              <span className="text-sm font-medium text-zinc-700">
                {busy ? "Saving…" : "Drop files or click to upload"}
              </span>
              <span className="text-[11px] text-zinc-400">PDF, docs, images, text · up to 6 MB each</span>
            </button>
            <input
              ref={inputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => void upload(e.target.files)}
            />
            {note && <p className="mt-2 text-xs text-zinc-500">{note}</p>}
          </div>
        </section>

        <section className="flex min-h-0 flex-1 flex-col rounded-xl border bg-white" style={{ borderColor: BORDER }}>
          <div className="border-b px-4 py-3" style={{ borderColor: BORDER_SOFT }}>
            <h2 className="text-sm font-semibold" style={{ color: PLUM }}>
              Marketing library{files.length ? ` · ${files.length}` : ""}
            </h2>
            <p className="mt-0.5 text-xs text-zinc-500">What the studio reads from. Prior posts also come from the live site.</p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {files.length === 0 ? (
              <p className="px-2 py-4 text-sm text-zinc-400">
                Nothing here yet — upload materials above, and the studio will also pull from our website.
              </p>
            ) : (
              <ul className="flex flex-col">
                {files.map((f) => (
                  <li key={f.path}>
                    <a
                      href={fileHref(f.path)}
                      target="_blank"
                      rel="noreferrer"
                      className="group flex items-center gap-2 rounded-lg px-2 py-1.5 no-underline hover:bg-zinc-50"
                    >
                      <FileText size={14} className="shrink-0" style={{ color: PLUM }} />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-zinc-800">{f.name}</span>
                      {justAdded.has(f.path) && (
                        <Check size={13} className="shrink-0 text-emerald-600" />
                      )}
                      {f.sizeBytes != null && (
                        <span className="shrink-0 text-[11px] tabular-nums text-zinc-400">{fmtSize(f.sizeBytes)}</span>
                      )}
                      <ExternalLink size={12} className="shrink-0 text-zinc-300 group-hover:text-zinc-500" />
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
