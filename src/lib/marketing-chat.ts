// Shared config for the Marketing (Fable) chat surface, so the /marketing page
// and a resumed marketing session (/s/[id]) stay in lock-step — same endpoint
// (Fable + website source), same plays, same "Save to Google Docs" action.
// Client-safe (plain data, no server imports), like plays.ts.

import type { PlayId } from "@/lib/plays";

export const MARKETING_CHAT_ENDPOINT = "/api/marketing/chat";

export const MARKETING_PLAY_IDS: PlayId[] = ["blog"];

export const MARKETING_FOOTER_ACTIONS: Array<{ label: string; emoji?: string; prompt: string }> = [
  {
    label: "Save to Google Docs",
    emoji: "📄",
    prompt:
      "Save the latest COMPLETE blog draft from this conversation to my Google Drive as a Google Doc — a draft for review, do NOT publish anywhere. Use the most recent full version that reflects all my edits (anonymized customers, full product suite, SEO/GEO). FIRST reply with ONE line naming exactly which version you're saving (working title + approx word count) so I can confirm it's the right one; then create the Doc inside a \"Blog drafts\" folder in my Drive (create the folder if it's missing) and reply with the shareable link. If it's genuinely ambiguous which version is final, ask me before creating it. If Google Docs/Drive isn't connected, tell me and point me to Settings → Connect.",
  },
];

/** A session is a Marketing/Fable one when it was started from /marketing. */
export function isMarketingSession(scope: { source?: string } | null | undefined): boolean {
  return scope?.source === "marketing";
}
