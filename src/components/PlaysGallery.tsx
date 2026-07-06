"use client";

import { PLAYS, ALL_PLAY_IDS, playRunPrompt } from "@/lib/plays";
import { askReddy } from "@/components/ChatDock";
import { PLUM, PLUM_TINT, BORDER, INK_2 } from "@/lib/tokens";

// The Plays catalog (read-only). Browse what each play IS and what it actually
// does (its instructions) — not a launch pad. "Use in a new chat" opens a
// session with this play surfaced in the launcher, where the scope (which
// meetings/account are pulled in) is visible before you run it. Running a play
// with meeting context happens from a scoped session (e.g. "Ask about these
// meetings" from the meetings view), not from a blind click here.

export default function PlaysGallery() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {ALL_PLAY_IDS.map((id) => {
        const play = PLAYS[id];
        return (
          <div
            key={id}
            className="flex flex-col gap-2 rounded-xl border bg-white p-4"
            style={{ borderColor: BORDER }}
          >
            <div className="flex items-center gap-2">
              <span className="text-lg leading-none" aria-hidden>
                {play.emoji}
              </span>
              <span className="text-sm font-semibold text-zinc-900">{play.label}</span>
            </div>
            <p className="text-xs leading-relaxed" style={{ color: INK_2 }}>
              {play.blurb}
            </p>
            <details className="text-xs">
              <summary className="cursor-pointer font-medium" style={{ color: PLUM }}>
                What it does
              </summary>
              <p
                className="mt-1.5 whitespace-pre-wrap rounded-md border bg-zinc-50 p-2 text-[11px] leading-relaxed text-zinc-600"
                style={{ borderColor: BORDER }}
              >
                {playRunPrompt(id, {})}
              </p>
            </details>
            <button
              type="button"
              onClick={() => askReddy({ playId: id, title: `${play.emoji} ${play.label}` })}
              className="mt-auto inline-flex w-fit items-center rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors hover:opacity-90"
              style={{ borderColor: PLUM_TINT, background: PLUM_TINT, color: PLUM }}
            >
              Use in a new chat →
            </button>
          </div>
        );
      })}
    </div>
  );
}
