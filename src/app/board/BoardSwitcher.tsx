"use client";

import { PLUM } from "./ui-shared";

export type BoardTab = {
  key: string;
  name: string;
  open: number;
};

// Top-nav board switcher (GTM / Success / Operations). Switching boards is a
// plain link (server re-renders scoped to the new board). Board-scoped filters
// (assignee/label/customer) are intentionally dropped on switch — they don't
// carry across boards — but the current view (kanban/list) is preserved.
export default function BoardSwitcher({
  boards,
  active,
  view,
}: {
  boards: BoardTab[];
  active: string;
  view: "kanban" | "list";
}) {
  return (
    <nav
      className="inline-flex items-center gap-0.5 rounded-lg border border-zinc-200 bg-white p-0.5"
      aria-label="Boards"
    >
      {boards.map((b) => {
        const isActive = b.key === active;
        const params = new URLSearchParams();
        if (b.key !== "gtm") params.set("board", b.key);
        if (view === "list") params.set("view", "list");
        const href = `/board${params.toString() ? `?${params}` : ""}`;
        return (
          <a
            key={b.key}
            href={href}
            aria-current={isActive ? "page" : undefined}
            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium no-underline transition-colors"
            style={
              isActive
                ? { background: PLUM, color: "#fff" }
                : { color: "#574B59" }
            }
          >
            {b.name}
            <span
              className="rounded-full px-1.5 text-[11px] font-semibold tabular-nums"
              style={
                isActive
                  ? { background: "rgba(255,255,255,0.22)", color: "#fff" }
                  : { background: "#F0E8EF", color: PLUM }
              }
            >
              {b.open}
            </span>
          </a>
        );
      })}
    </nav>
  );
}
