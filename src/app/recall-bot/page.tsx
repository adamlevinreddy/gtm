"use client";

import { useRef, useState } from "react";

// Manual ad-hoc Recall bot dispatcher.
//
// Use case: the calendar integration missed a meeting (last-minute invite,
// third-party calendar, ad-hoc Zoom link in a Slack DM). Drop the meeting
// URL in here and a Reddy Notetaker joins immediately.
//
// Auth: shared secret entered once and cached in localStorage so the
// next visit just works. Server validates RECALL_VIDEO_FETCH_SECRET.

type Result =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "ok"; botId: string; meetingUrl: string }
  | { kind: "err"; message: string };

const SECRET_KEY = "reddy.manualBot.secret";

export default function ManualBotPage() {
  // Secret is uncontrolled — read from localStorage as defaultValue,
  // re-read via ref on submit. Avoids the "setState in effect" rule
  // and keeps SSR happy (localStorage gated behind typeof window).
  const cachedSecret =
    typeof window !== "undefined" ? localStorage.getItem(SECRET_KEY) ?? "" : "";
  const secretRef = useRef<HTMLInputElement>(null);
  const [meetingUrl, setMeetingUrl] = useState("");
  const [botName, setBotName] = useState("");
  const [result, setResult] = useState<Result>({ kind: "idle" });

  async function spawn(e: React.FormEvent) {
    e.preventDefault();
    const secret = secretRef.current?.value ?? "";
    if (!secret || !meetingUrl) return;
    setResult({ kind: "submitting" });
    try {
      const res = await fetch("/api/recall/manual-bot", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-reddy-secret": secret,
        },
        body: JSON.stringify({ meetingUrl, botName: botName || undefined }),
      });
      const json = (await res.json()) as { ok: boolean; botId?: string; error?: string };
      if (!res.ok || !json.ok) {
        setResult({ kind: "err", message: json.error ?? `HTTP ${res.status}` });
        return;
      }
      localStorage.setItem(SECRET_KEY, secret);
      setResult({ kind: "ok", botId: json.botId!, meetingUrl });
      setMeetingUrl("");
    } catch (err) {
      setResult({ kind: "err", message: err instanceof Error ? err.message : String(err) });
    }
  }

  return (
    <main style={styles.main}>
      <div style={styles.card}>
        <h1 style={styles.title}>Send Reddy Notetaker to a meeting</h1>
        <p style={styles.subtitle}>
          Drop a Zoom / Google Meet / Teams link below. The bot joins immediately and the recording + transcript land in the kb when the meeting ends.
        </p>

        <form onSubmit={spawn} style={styles.form}>
          <label style={styles.label}>
            Meeting URL
            <input
              type="url"
              required
              autoFocus
              placeholder="https://zoom.us/j/123… or https://meet.google.com/… or https://teams.microsoft.com/…"
              value={meetingUrl}
              onChange={(e) => setMeetingUrl(e.target.value)}
              style={styles.input}
              disabled={result.kind === "submitting"}
            />
          </label>

          <label style={styles.label}>
            Bot name <span style={styles.hint}>(optional — defaults to &quot;Reddy Notetaker&quot;)</span>
            <input
              type="text"
              placeholder="Reddy Notetaker"
              value={botName}
              onChange={(e) => setBotName(e.target.value)}
              style={styles.input}
              disabled={result.kind === "submitting"}
            />
          </label>

          <label style={styles.label}>
            Access secret
            <input
              ref={secretRef}
              type="password"
              required
              placeholder="paste RECALL_VIDEO_FETCH_SECRET"
              defaultValue={cachedSecret}
              style={styles.input}
              disabled={result.kind === "submitting"}
            />
            <span style={styles.hint}>cached in this browser after a successful spawn</span>
          </label>

          <button
            type="submit"
            disabled={result.kind === "submitting" || !meetingUrl}
            style={{
              ...styles.button,
              ...(result.kind === "submitting" || !meetingUrl ? styles.buttonDisabled : {}),
            }}
          >
            {result.kind === "submitting" ? "Sending bot…" : "Send bot to meeting"}
          </button>
        </form>

        {result.kind === "ok" && (
          <div style={{ ...styles.banner, ...styles.bannerOk }}>
            <strong>Bot dispatched.</strong>
            <div style={{ marginTop: 4, fontSize: 13 }}>
              bot_id: <code>{result.botId}</code>
            </div>
            <div style={{ marginTop: 2, fontSize: 13 }}>
              meeting: <code>{result.meetingUrl.slice(0, 80)}{result.meetingUrl.length > 80 ? "…" : ""}</code>
            </div>
          </div>
        )}
        {result.kind === "err" && (
          <div style={{ ...styles.banner, ...styles.bannerErr }}>
            <strong>Failed.</strong>
            <div style={{ marginTop: 4, fontSize: 13 }}>{result.message}</div>
          </div>
        )}

        <div style={styles.footer}>
          Recording + transcript flow through the same pipeline as calendar-scheduled bots — they land in <code>corpora/success/customers/_unsorted/meetings/{"{bot_id}"}/</code> by default and re-attribute when domains match HubSpot.
        </div>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  main: {
    minHeight: "100vh",
    background: "#0a0a0a",
    color: "#fff",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "2rem",
  },
  card: {
    background: "#141414",
    border: "1px solid #222",
    borderRadius: 16,
    width: "100%",
    maxWidth: 540,
    padding: "2rem",
  },
  title: { fontSize: "1.4rem", margin: "0 0 0.5rem 0", fontWeight: 600 },
  subtitle: { color: "#b3b3b3", lineHeight: 1.55, margin: "0 0 1.5rem 0", fontSize: 14 },
  form: { display: "flex", flexDirection: "column", gap: "1rem" },
  label: { display: "flex", flexDirection: "column", gap: 6, fontSize: 13, color: "#ccc" },
  input: {
    background: "#0a0a0a",
    border: "1px solid #2a2a2a",
    borderRadius: 8,
    padding: "10px 12px",
    color: "#fff",
    fontSize: 14,
    fontFamily: "inherit",
    outline: "none",
  },
  hint: { color: "#666", fontSize: 12, fontWeight: 400 },
  button: {
    background: "#10b981",
    color: "#0a0a0a",
    border: "none",
    borderRadius: 8,
    padding: "12px 16px",
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    marginTop: 4,
  },
  buttonDisabled: { background: "#333", color: "#777", cursor: "not-allowed" },
  banner: {
    marginTop: "1rem",
    padding: "12px 14px",
    borderRadius: 8,
    fontSize: 14,
  },
  bannerOk: { background: "#0e2a1c", border: "1px solid #155233", color: "#a7f3d0" },
  bannerErr: { background: "#2a0e0e", border: "1px solid #5a1f1f", color: "#fecaca" },
  footer: {
    marginTop: "1.5rem",
    paddingTop: "1rem",
    borderTop: "1px solid #222",
    color: "#888",
    fontSize: 12,
    lineHeight: 1.55,
  },
};
