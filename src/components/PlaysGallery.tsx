"use client";

import { PLAYS, ALL_PLAY_IDS, playRunPrompt } from "@/lib/plays";
import { askReddy } from "@/components/ChatDock";
import { PLUM, PLUM_TINT, BORDER, INK_2 } from "@/lib/tokens";

// The Plays gallery (Arc VII). The same PLAYS registry that powers the
// post-meeting Slack card, browsable on the web: click a play to run it in the
// Ask Reddy dock. The session it opens is tagged "Play: <label>" so it shows up
// filtered under Plays in /s. Meeting-scoped plays (recap, recording link)
// launched cold will ask which meeting; the rest ask for the specifics they
// need.

export default function PlaysGallery() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {ALL_PLAY_IDS.map((id) => {
        const play = PLAYS[id];
        return (
          <button
            key={id}
            type="button"
            onClick={() =>
              askReddy({
                question: playRunPrompt(id, {}),
                title: `${play.emoji} ${play.label}`,
                scopeLabel: `Play · ${play.label}`,
                sessionScope: { label: `Play: ${play.label}`, source: "play" },
              })
            }
            className="flex flex-col gap-2 rounded-xl border bg-white p-4 text-left transition-colors hover:bg-zinc-50 focus:outline-none focus:ring-2"
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
            <span
              className="mt-1 inline-flex w-fit items-center rounded px-1.5 py-0.5 text-[11px] font-medium"
              style={{ background: PLUM_TINT, color: PLUM }}
            >
              Run play →
            </span>
          </button>
        );
      })}
    </div>
  );
}
