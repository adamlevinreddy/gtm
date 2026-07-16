"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import MuxPlayer from "@mux/mux-player-react";
import { FileText, Link2, Search, ChevronUp, ChevronDown } from "lucide-react";
import CopyButton from "@/components/CopyButton";

const PLUM = "#773D72";

// Highlight query matches inside a transcript line.
function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"));
  return (
    <>
      {parts.map((p, i) =>
        p.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} className="rounded-sm px-0.5" style={{ background: "#F3D9F0" }}>
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}

type TimedLine = { start: number; speaker: string; text: string };
type Video = {
  kind: "mux" | "lfs" | "none";
  url: string | null;
  muxPlaybackId?: string | null;
  muxTokens?: { playback: string; thumbnail: string; storyboard: string } | null;
};

function fmt(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return (h > 0 ? `${h}:` : "") + `${mm}:${String(s).padStart(2, "0")}`;
}

export default function MeetingPlayerAndTranscript({
  video,
  timed,
  fallback,
  initialT,
  shareUrl,
}: {
  video: Video;
  timed: TimedLine[] | null;
  fallback: string | null;
  /** ?t= deep link — seek here once the media can play (no autoplay). */
  initialT?: number | null;
  /** Canonical /m/{botId} URL — used by "copy link at current time". */
  shareUrl?: string;
}) {
  // One ref for whichever media element renders (MuxPlayer and <video> both
  // expose a settable .currentTime).
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const [active, setActive] = useState(-1);

  // In-transcript search (Daybreak Phase 5): highlight-all, n/N navigation,
  // jump-to-line — find the exact second of an hour-long call in 2 clicks.
  const [query, setQuery] = useState("");
  const [matchIdx, setMatchIdx] = useState(0);
  const lineRefs = useRef<Map<number, HTMLElement>>(new Map());
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [] as number[];
    if (timed && timed.length > 0) {
      return timed
        .map((l, i) => (`${l.speaker}: ${l.text}`.toLowerCase().includes(q) ? i : -1))
        .filter((i) => i >= 0);
    }
    if (fallback) {
      return fallback
        .split(/\r?\n/)
        .map((l, i) => (l.toLowerCase().includes(q) ? i : -1))
        .filter((i) => i >= 0);
    }
    return [];
  }, [query, timed, fallback]);

  const hasJumped = useRef(false);
  const jumpToMatch = (next: number) => {
    if (matches.length === 0) return;
    const idx = ((next % matches.length) + matches.length) % matches.length;
    setMatchIdx(idx);
    hasJumped.current = true;
    lineRefs.current.get(matches[idx])?.scrollIntoView({ block: "center" });
  };

  // ?t= deep link: seek once, as soon as the media is ready. Paused seek —
  // the viewer decides when to press play.
  useEffect(() => {
    if (initialT == null || initialT <= 0) return;
    const el = mediaRef.current;
    if (!el) return;
    const apply = () => {
      try {
        el.currentTime = initialT;
      } catch {
        /* not seekable yet */
      }
    };
    if (el.readyState >= 1) apply();
    el.addEventListener("loadedmetadata", apply, { once: true });
    return () => el.removeEventListener("loadedmetadata", apply);
  }, [initialT, video.kind]);

  const seekTo = (t: number) => {
    const el = mediaRef.current;
    if (!el) return;
    try {
      el.currentTime = Math.max(0, t);
      const p = el.play?.();
      if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(() => {});
    } catch {
      /* ignore */
    }
  };

  // Best-effort active-line highlight as the recording plays. Works for both
  // the native <video> and the Mux element (both dispatch 'timeupdate').
  useEffect(() => {
    const el = mediaRef.current;
    if (!el || !timed || timed.length === 0) return;
    const onTime = () => {
      const t = el.currentTime;
      // last line whose start <= t
      let idx = -1;
      for (let i = 0; i < timed.length; i++) {
        if (timed[i].start <= t) idx = i;
        else break;
      }
      setActive(idx);
    };
    el.addEventListener("timeupdate", onTime);
    return () => el.removeEventListener("timeupdate", onTime);
  }, [timed]);

  return (
    <div className="flex flex-col gap-5">
      {/* recording */}
      <section className="overflow-hidden rounded-xl border bg-black" style={{ borderColor: "#E4DCE3" }}>
        {video.kind === "mux" && video.muxPlaybackId && video.muxTokens ? (
          <MuxPlayer
            ref={mediaRef as never}
            playbackId={video.muxPlaybackId}
            tokens={video.muxTokens}
            streamType="on-demand"
            accentColor={PLUM}
            style={{ aspectRatio: "16 / 9", width: "100%" }}
          />
        ) : video.kind === "lfs" && video.url ? (
           
          <video ref={mediaRef} src={video.url} controls preload="metadata" className="aspect-video w-full bg-black" />
        ) : (
          <div className="flex aspect-video w-full items-center justify-center bg-zinc-900 text-sm text-zinc-400">
            No recording available for this meeting.
          </div>
        )}
      </section>

      {/* transcript */}
      <section className="rounded-xl border bg-white" style={{ borderColor: "#E4DCE3" }}>
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5" style={{ borderColor: "#EFE5EE" }}>
          <FileText size={14} style={{ color: PLUM }} />
          <h2 className="text-sm font-semibold" style={{ color: PLUM }}>Transcript</h2>
          <div className="relative ml-2 min-w-[160px] flex-1 max-w-xs">
            <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-zinc-400" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setMatchIdx(0);
                hasJumped.current = false;
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  if (e.shiftKey) jumpToMatch(matchIdx - 1);
                  else jumpToMatch(hasJumped.current ? matchIdx + 1 : matchIdx);
                }
              }}
              placeholder="Search transcript…"
              className="w-full rounded-md border py-1 pl-6 pr-2 text-xs outline-none focus:ring-1"
              style={{ borderColor: "#E4DCE3" }}
            />
          </div>
          {query.trim() && (
            <span className="flex items-center gap-0.5 text-xs tabular-nums text-zinc-500">
              {matches.length ? `${matchIdx + 1}/${matches.length}` : "0/0"}
              <button type="button" onClick={() => jumpToMatch(matchIdx - 1)} className="rounded p-0.5 hover:bg-zinc-100" aria-label="Previous match">
                <ChevronUp size={13} />
              </button>
              <button type="button" onClick={() => jumpToMatch(matchIdx + 1)} className="rounded p-0.5 hover:bg-zinc-100" aria-label="Next match">
                <ChevronDown size={13} />
              </button>
            </span>
          )}
          <div className="ml-auto flex items-center gap-2">
            {shareUrl && video.kind !== "none" && (
              <CopyButton
                text={() => {
                  const sec = Math.floor(mediaRef.current?.currentTime ?? 0);
                  return sec > 0 ? `${shareUrl}?t=${sec}` : shareUrl;
                }}
                label="Copy link at current time"
                icon={<Link2 size={12} />}
                title="Link opens the video seeked to this moment"
              />
            )}
          </div>
        </div>
        <div className="max-h-[60vh] overflow-y-auto px-2 py-2">
          {timed && timed.length > 0 ? (
            <div className="flex flex-col">
              {timed.map((line, i) => (
                <button
                  key={i}
                  ref={(el) => {
                    if (el) lineRefs.current.set(i, el);
                    else lineRefs.current.delete(i);
                  }}
                  type="button"
                  onClick={() => seekTo(line.start)}
                  className="flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm leading-relaxed transition-colors hover:bg-zinc-50"
                  style={
                    i === active
                      ? { background: "#F0E8EF" }
                      : query.trim() && matches[matchIdx] === i
                        ? { outline: `1px solid ${PLUM}55`, background: "#FBF7FA" }
                        : undefined
                  }
                >
                  <span
                    className="mt-0.5 shrink-0 font-mono text-[11px] tabular-nums"
                    style={{ color: PLUM }}
                  >
                    {fmt(line.start)}
                  </span>
                  <span className="min-w-0">
                    <span className="font-semibold text-zinc-800">
                      <Highlighted text={`${line.speaker}: `} query={query.trim()} />
                    </span>
                    <span className="text-zinc-700">
                      <Highlighted text={line.text} query={query.trim()} />
                    </span>
                  </span>
                </button>
              ))}
            </div>
          ) : fallback ? (
            <div className="space-y-1.5 px-2 py-2 text-sm leading-relaxed text-zinc-700">
              {fallback.split(/\r?\n/).map((l, i) => {
                const setRef = (el: HTMLElement | null) => {
                  if (el) lineRefs.current.set(i, el);
                  else lineRefs.current.delete(i);
                };
                const m = l.match(/^([^:]{1,40}):\s?(.*)$/);
                if (m) {
                  return (
                    <p key={i} ref={setRef}>
                      <span className="font-semibold" style={{ color: PLUM }}>{m[1]}:</span>{" "}
                      <Highlighted text={m[2]} query={query.trim()} />
                    </p>
                  );
                }
                return l.trim() ? (
                  <p key={i} ref={setRef}>
                    <Highlighted text={l} query={query.trim()} />
                  </p>
                ) : (
                  <div key={i} className="h-1.5" />
                );
              })}
            </div>
          ) : (
            <p className="px-2 py-4 text-sm text-zinc-400">No transcript available for this meeting.</p>
          )}
        </div>
      </section>
    </div>
  );
}
