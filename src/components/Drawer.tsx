"use client";

import { useEffect, type ReactNode } from "react";
import { X } from "lucide-react";
import { BORDER_SOFT } from "@/lib/tokens";

// Right slide-over panel — the home for chat sessions and previews so page
// state (filters, scroll) and conversation state can never destroy each
// other. Esc or scrim click closes.
export default function Drawer({
  open,
  onClose,
  title,
  children,
  width = "max-w-xl",
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  width?: string;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Consume the key: document-bubble fires BEFORE window-bubble, so
        // stopping here keeps ChatDock's window listener from ALSO
        // minimizing on the same press.
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      <button
        type="button"
        aria-label="Close panel"
        onClick={onClose}
        className="absolute inset-0 h-full w-full cursor-default bg-black/25 backdrop-blur-[1px]"
      />
      <div
        className={`absolute inset-y-0 right-0 flex w-full ${width} flex-col bg-white shadow-2xl`}
      >
        <div className="flex items-center gap-2 border-b px-4 py-3" style={{ borderColor: BORDER_SOFT }}>
          <div className="min-w-0 flex-1 text-sm font-semibold text-zinc-900">{title}</div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-zinc-400 hover:bg-zinc-100 hover:text-zinc-700"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </div>
  );
}
