"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PLUM } from "../ui-shared";

export default function MarkAllRead({
  viewer,
  unread,
}: {
  viewer: string;
  unread: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  if (unread === 0) return null;

  const markAll = async () => {
    setBusy(true);
    try {
      await fetch("/api/board/ui/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "readAll", as: viewer }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void markAll()}
      disabled={busy}
      className="rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
      style={{ background: PLUM }}
    >
      {busy ? "Marking…" : `Mark all read (${unread})`}
    </button>
  );
}
