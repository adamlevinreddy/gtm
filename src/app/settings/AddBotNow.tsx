"use client";

import { useState } from "react";
import { Bot } from "lucide-react";
import { PLUM, BORDER } from "@/lib/tokens";

// "The notetaker missed my meeting" rescue: paste a join URL, bot arrives
// in ~30s. Secret lives server-side in the proxy.
export default function AddBotNow() {
  const [url, setUrl] = useState("");
  const [state, setState] = useState<"idle" | "busy" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (!url.trim() || state === "busy") return;
    setState("busy");
    setError(null);
    try {
      const res = await fetch("/api/board/ui/manual-bot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ meetingUrl: url.trim() }),
      });
      const j = (await res.json()) as { ok?: boolean; error?: string };
      if (!j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setState("sent");
      setUrl("");
      setTimeout(() => setState("idle"), 4000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "something went wrong");
      setState("error");
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
      className="flex flex-wrap items-center gap-2"
    >
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="Paste a Zoom / Meet / Teams join URL…"
        className="min-w-[260px] flex-1 rounded-lg border px-3 py-2 text-sm outline-none focus:ring-2"
        style={{ borderColor: BORDER }}
      />
      <button
        type="submit"
        disabled={state === "busy" || !url.trim()}
        className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold text-white disabled:opacity-40"
        style={{ background: PLUM }}
      >
        <Bot size={14} />
        {state === "busy" ? "Dispatching…" : state === "sent" ? "Bot on its way ✓" : "Send the notetaker"}
      </button>
      {error && <p className="w-full text-xs text-red-600">{error}</p>}
    </form>
  );
}
