// Shared config for the Marketing (Fable) chat surface, so the /marketing page
// and a resumed marketing session (/s/[id]) stay in lock-step — same endpoint
// (Fable + website source), same plays, same "Save to Google Docs" action.
// Client-safe (plain data, no server imports), like plays.ts.
//
// The studio is MODE-FIRST: the user picks what they're making before the chat
// opens, and the mode rides a query param into /api/marketing/chat where it
// selects which constitution loads into the preamble (blog guardrails vs
// outreach rules vs both). The mode also persists on the session scope so a
// resumed session keeps its lane.

import type { PlayId } from "@/lib/plays";

export const MARKETING_CHAT_ENDPOINT = "/api/marketing/chat";

export type MarketingMode = "blog" | "outreach" | "other";

export function isMarketingMode(x: unknown): x is MarketingMode {
  return x === "blog" || x === "outreach" || x === "other";
}

/** The chat endpoint with the mode attached (read server-side for the preamble). */
export function marketingChatEndpoint(mode: MarketingMode): string {
  return `${MARKETING_CHAT_ENDPOINT}?mode=${mode}`;
}

export type MarketingModeConfig = {
  label: string;
  emoji: string;
  blurb: string;
  playIds: PlayId[];
  suggestPlay?: PlayId;
  placeholder: string;
  starters: string[];
};

export const MARKETING_MODES: Record<MarketingMode, MarketingModeConfig> = {
  blog: {
    label: "Write a blog",
    emoji: "✍️",
    blurb: "Topic mining from calls + Search Console, live landscape research, a draft in Reddy's voice.",
    playIds: ["blog"],
    suggestPlay: "blog",
    placeholder: "Describe the blog post you want to write…",
    starters: [
      "Suggest this week's blog from our calls and Search Console data.",
      "Draft a post on how contact centers cut ramp time with Reddy.",
      "What have we already published, so we don't repeat ourselves?",
    ],
  },
  outreach: {
    label: "Build an outreach sequence",
    emoji: "📬",
    blurb: "SMYKM outbound across Instantly email + HeyReach LinkedIn — research, drafts, staged campaigns.",
    playIds: ["outreach"],
    suggestPlay: "outreach",
    placeholder: "Describe the campaign — type, audience, channels…",
    starters: [
      "Build a fresh cold sequence — I'll upload the target list.",
      "Draft new SMYKM email templates for an ABM campaign into BPOs.",
      "Which of our live Instantly campaigns are performing best?",
    ],
  },
  other: {
    label: "Other",
    emoji: "🎨",
    blurb: "Anything else marketing — LinkedIn posts, one-pagers, landing copy, campaign analytics.",
    playIds: ["blog", "outreach"],
    placeholder: "What are we making?",
    starters: [
      "Turn our latest blog post into three LinkedIn posts.",
      "Review this copy against our copywriting guide — I'll paste it.",
      "How did our Google Ads and LinkedIn Ads perform last month?",
    ],
  },
};

export const MARKETING_MODE_ORDER: MarketingMode[] = ["blog", "outreach", "other"];

/** All marketing plays (used where a mode isn't known). */
export const MARKETING_PLAY_IDS: PlayId[] = ["blog", "outreach"];

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
