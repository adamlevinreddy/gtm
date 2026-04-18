// Shared connect-flow logic used by both the `/reddy-connect` slash command
// and the `@Reddy-GTM set me up` app_mention shortcut.

import { WebClient } from "@slack/web-api";
import {
  initiateConnection,
  getConnectionStatus,
  availableToolkits,
  type ToolkitSlug,
} from "@/lib/composio";

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
  if (toolkits.length === 0) {
    return "No services are configured yet. Ask the Reddy-GTM admin to add auth configs in Composio.";
  }

  const status = await getConnectionStatus(userEmail).catch((err) => {
    console.error(`[composio-connect] status check failed: ${err instanceof Error ? err.message : err}`);
    return null;
  });

  const missing = toolkits.filter((t) => !status || !status[t.slug]);

  if (missing.length === 0) {
    return `*You're all set.* Everything available is connected:\n${toolkits.map((t) => `• ${t.label}`).join("\n")}`;
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

  // Surface what's already connected so users don't re-click.
  const alreadyConnected = toolkits.filter((t) => status && status[t.slug]);
  if (alreadyConnected.length > 0) {
    lines.push(`_Already connected: ${alreadyConnected.map((t) => t.label).join(", ")}_`);
  }

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
