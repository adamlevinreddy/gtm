"use client";

import { SquarePen } from "lucide-react";
import { askReddy } from "@/components/ChatDock";
import { PLUM } from "@/lib/tokens";

// Start a new session straight from the Sessions tab (was only possible from
// the home Ask box). Opens the global dock with a fresh chat — saved to /s the
// moment the first turn lands.
export default function NewSessionButton() {
  return (
    <button
      type="button"
      onClick={() => askReddy({})}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold text-white"
      style={{ background: PLUM }}
    >
      <SquarePen size={14} /> New session
    </button>
  );
}
