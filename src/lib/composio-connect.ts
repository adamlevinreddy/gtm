// Shared connect-flow logic used by both the `/reddy-connect` slash command
// and the `@Reddy-GTM set me up` app_mention shortcut.

import { WebClient } from "@slack/web-api";
import {
  initiateConnection,
  getConnectionStatus,
  availableToolkits,
  type ToolkitSlug,
} from "@/lib/composio";
import { isConnected as isGranolaConnected } from "@/lib/granola";

// Public-facing base URL for OAuth redirect links embedded in Slack messages.
// Must match the host Granola's DCR client was registered against.
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ?? process.env.REDDY_GTM_BASE_URL ?? "https://gtm-jet.vercel.app";

export async function resolveSlackEmailForConnect(userId: string, slack: WebClient): Promise<string | null> {
  try {
    const res = await slack.users.info({ user: userId });
    return res.user?.profile?.email ?? null;
  } catch (err) {
    console.error(`[composio-connect] users.info failed for ${userId}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// Build a Slack mrkdwn message offering OAuth links for every toolkit the
// user hasn't connected yet. If everything is already connected, returns a
// "you're good" confirmation instead.
export async function buildConnectMessage(userEmail: string): Promise<string> {
  const toolkits = availableToolkits();
  const [status, granolaConnected] = await Promise.all([
    getConnectionStatus(userEmail).catch((err) => {
      console.error(`[composio-connect] status check failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }),
    isGranolaConnected(userEmail).catch(() => false),
  ]);

  const missing = toolkits.filter((t) => !status || !status[t.slug]);
  const granolaAuthUrl = `${PUBLIC_BASE_URL}/api/oauth/granola/start?email=${encodeURIComponent(userEmail)}`;

  if (toolkits.length === 0 && granolaConnected) {
    return "*You're all set.* Granola is connected; no other services are configured yet.";
  }
  if (toolkits.length === 0 && !granolaConnected) {
    return [
      "No Composio toolkits are configured yet. You can still connect Granola directly:",
      `• <${granolaAuthUrl}|Connect Granola>`,
    ].join("\n");
  }

  if (missing.length === 0 && granolaConnected) {
    return `*You're all set.* Everything available is connected:\n${toolkits.map((t) => `• ${t.label}`).join("\n")}\n• Granola`;
  }

  const groups: Partial<Record<"google" | "work" | "company", typeof missing>> = {};
  for (const t of missing) {
    (groups[t.category] ||= []).push(t);
  }

  const lines: string[] = [
    "*Let's get you set up.* Click each link once — Composio handles the OAuth handshake, and you'll never have to do it again (unless you revoke access).",
    "",
  ];
  const sectionLabel: Record<"google" | "work" | "company", string> = {
    google: "Google Workspace",
    work: "Work tools",
    company: "Company accounts (only if you have access)",
  };

  for (const cat of ["google", "work", "company"] as const) {
    const items = groups[cat];
    if (!items || items.length === 0) continue;
    lines.push(`*${sectionLabel[cat]}*`);
    for (const t of items) {
      try {
        const { redirectUrl } = await initiateConnection(userEmail, t.slug);
        lines.push(`• <${redirectUrl}|Connect ${t.label}>`);
      } catch (err) {
        lines.push(`• ${t.label} — _setup error: ${err instanceof Error ? err.message : String(err)}_`);
      }
    }
    lines.push("");
  }

  // Meeting-side integrations (outside Composio). Recall calendar
  // doesn't expose a public "is this user connected" check on the
  // workspace token, so we always show the link — clicking it on an
  // already-connected calendar is idempotent on Recall's side.
  const recallAuthUrl = `${PUBLIC_BASE_URL}/api/oauth/recall-calendar/start?email=${encodeURIComponent(userEmail)}`;
  lines.push("*Meetings*");
  if (!granolaConnected) {
    lines.push(`• <${granolaAuthUrl}|Connect Granola>`);
  }
  lines.push(`• <${recallAuthUrl}|Connect Recall Calendar> _— Reddy Notetaker auto-joins meetings on your calendar and posts the recording + transcript to the team's KB_`);
  lines.push("");

  // Surface what's already connected so users don't re-click.
  const alreadyConnected = toolkits.filter((t) => status && status[t.slug]);
  const alreadyLabels = alreadyConnected.map((t) => t.label);
  if (granolaConnected) alreadyLabels.push("Granola");
  if (alreadyLabels.length > 0) {
    lines.push(`_Already connected: ${alreadyLabels.join(", ")}_`);
  }

  lines.push("");
  lines.push(":lock_with_ink_pen: *Thread privacy:* once connected, anyone who mentions me in the same thread can use *your* authenticated tools. React :end: or say `@Reddy-GTM end thread` to close the session when you're done.");

  return lines.join("\n");
}

// Heuristic for "@Reddy-GTM set me up" style mentions. Returns true if the
// message looks like a setup / connection request (short-circuit the agent).
export function isSetupIntent(normalizedText: string): boolean {
  const t = normalizedText.toLowerCase().trim();
  if (!t) return false;
  const phrases = [
    "set me up",
    "set up my",
    "connect me",
    "connect my accounts",
    "connect my account",
    "onboard me",
    "get me connected",
    "link my accounts",
    "/reddy-connect",
  ];
  return phrases.some((p) => t.includes(p));
}

export type { ToolkitSlug };
