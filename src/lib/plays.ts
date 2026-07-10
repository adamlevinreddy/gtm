// The Play catalog (Arc VII). A "Play" is a templated GTM workflow the team
// repeats — recap emails, pricing, RFPs, redlines, etc. Each Play knows how to
// RUN (the instruction the agent executes, scoped to a meeting/account) and how
// to DISPLAY (label + emoji for the post-meeting card and the gallery).
//
// The post-meeting card doesn't hard-code which Plays to show — a sandbox reads
// the meeting and picks the relevant ones from `id`s below (see the curator in
// post-meeting.ts). This registry is the single source of truth for both the
// card buttons and (later) the web/Slack Plays gallery, so the same Plays and
// instructions exist on every surface.

export type PlayId =
  | "recap_email"
  | "recording_link"
  | "pricing"
  | "rfp"
  | "account_catchup"
  | "redline"
  | "collateral"
  | "accounts_quiet"
  | "blog_suggest"
  | "blog_post";

export type PlayContext = { botId?: string; account?: string };

export type Play = {
  id: PlayId;
  label: string; // button / gallery text
  emoji: string;
  blurb: string; // one line — tooltip / gallery description
  /** Can the post-meeting card suggest this Play? (curator picks from these.) */
  onCard: boolean;
  /** The instruction the agent runs when this Play is triggered. Scoped to the
   *  meeting/account it was launched from. Written to be run in the Slack lane
   *  (the agent posts its own result to the thread) or a web session. */
  run: (ctx: PlayContext) => string;
};

const forMeeting = (ctx: PlayContext) =>
  ctx.botId
    ? `the meeting (bot_id ${ctx.botId})`
    : // Launched without a meeting (e.g. from the Plays gallery) — have the
      // agent pin it down first rather than guessing.
      "the meeting in question — if it isn't clear which meeting, ask me for the meeting or customer first";
const acct = (ctx: PlayContext) => ctx.account || "this account";

export const PLAYS: Record<PlayId, Play> = {
  recap_email: {
    id: "recap_email",
    label: "Draft recap email",
    emoji: "✉️",
    blurb: "A ready-to-send recap: thanks, what we discussed, next steps, 30-day recording link.",
    onCard: true,
    run: (ctx) =>
      `Draft a SHORT follow-up email for ${forMeeting(ctx)} (customer: ${acct(ctx)}), in Adam's voice — first person, warm but direct, the way a busy founder actually writes. Keep it to ~3–5 sentences: a one-line open, a line or two on what we discussed / the agreed next step, the recording, and a brief sign-off. NO long recap, NO bullet-point essay, NO corporate filler — err short.
` +
      `VOICE: mirror how Adam really writes — pull a couple of his recent sent follow-up/recap emails from Gmail (in:sent) and match his greeting, brevity, phrasing, and sign-off. If you can't read his mail, still keep it short and plain-spoken.
` +
      `RECORDING: mint the link (30-day TTL, ttl=2592000) and ALWAYS present it as a hyperlink on the text "Meeting recording" — NEVER paste the raw URL. In an email use an HTML body with <a href="URL">Meeting recording</a>; in Slack use <URL|Meeting recording>.
` +
      `If a next meeting was already booked live on the call, reference THAT — don't add a "let's find time" line. Link the deck / trust-center page only if it clearly fits. Output the ready-to-send draft; do NOT send — I'll review.`,
  },
  recording_link: {
    id: "recording_link",
    label: "30-day recording link",
    emoji: "🔗",
    blurb: "A shareable recording + transcript link, valid 30 days, safe to forward to clients.",
    onCard: true,
    run: (ctx) =>
      `Get the shareable recording + transcript link for ${forMeeting(ctx)} (30-day TTL, ttl=2592000) and post it as a hyperlink on the text "Meeting recording" (Slack: <URL|Meeting recording>) — not a raw URL — so it's clean to forward to external clients.`,
  },
  pricing: {
    id: "pricing",
    label: "Start pricing",
    emoji: "💰",
    blurb: "Build/revise a pricing sheet from the account's meetings, modeled on a reference deal.",
    onCard: true,
    run: (ctx) =>
      `Start a pricing proposal for ${acct(ctx)} using our meetings + HubSpot context and the pricing skill. If it isn't obvious which existing sheet to model on (e.g. HGV, Tapestry, Dow Jones), ask me before building — then produce the branded sheet with justification.`,
  },
  rfp: {
    id: "rfp",
    label: "RFP response",
    emoji: "📋",
    blurb: "Assemble an RFP/RFI response — exec summary, features, implementation, SLAs, pricing.",
    onCard: true,
    run: (ctx) =>
      `Kick off an RFP/RFI response for ${acct(ctx)}. Ask me to paste or upload the buyer's requirements, then assemble the response — executive summary, recommended services + features, implementation plan, SLAs, and itemized pricing — from our answer bank and prior RFP responses.`,
  },
  account_catchup: {
    id: "account_catchup",
    label: "Catch me up",
    emoji: "🧭",
    blurb: "The full picture on an account: conversations, competition, promises, what's open.",
    onCard: true,
    run: (ctx) =>
      `Catch me up on ${acct(ctx)}: the conversations so far, what they're evaluating us against, which products they want, what we've promised, and what's still open — using meetings, HubSpot, and any behind-the-scenes email.`,
  },
  redline: {
    id: "redline",
    label: "Redline contract",
    emoji: "✍️",
    blurb: "Review an inbound agreement against our corpus and return a redline with our positions.",
    onCard: true,
    run: (ctx) =>
      `Review the inbound agreement for ${acct(ctx)} against our executed contract corpus and return a redline assessment with our standard positions (follow the legal skill). Ask me to share the document if I haven't already.`,
  },
  collateral: {
    id: "collateral",
    label: "Find collateral",
    emoji: "📎",
    blurb: "Surface the right existing deck / one-sheet / trust-center link from the library.",
    onCard: false,
    run: (ctx) =>
      `Find and share the right existing Reddy collateral for ${acct(ctx)} — deck, one-sheet, or trust/privacy-center link — from the library. Ask which if it's ambiguous.`,
  },
  accounts_quiet: {
    id: "accounts_quiet",
    label: "Accounts going quiet",
    emoji: "🌙",
    blurb: "Qualified deals that could move but haven't had a touch in ~3 weeks.",
    onCard: false,
    run: () =>
      `Find our qualified deals / SQLs that could move but haven't had a touch in ~3 weeks, with context on any behind-the-scenes email — the accounts slipping through the cracks. Rank by how warm they were and what would re-open them.`,
  },
  // Marketing surface (not a post-meeting card). Launched from /marketing, where
  // it runs on Fable with the website source cloned + the marketing corpus.
  // The instruction is tuned from a real session so the FIRST answer is already
  // SEO-vetted — no need to re-prompt for search-fit, full-suite, or anonymizing.
  blog_suggest: {
    id: "blog_suggest",
    label: "Suggest this week's blog",
    emoji: "🗞️",
    blurb: "Mine this week's calls for a NEW, SEO/GEO-winnable blog topic we haven't covered — then draft it.",
    onCard: false,
    run: () =>
      `Suggest a new blog post based on the THEMES from our customer conversations this week. Follow the BLOG GUARDRAILS in your instructions (calls are for topics + context only, never reproduced; Reddy's POV leads; one thesis; no competitor size knocks; no em dashes). Work in this order and show your reasoning briefly:
` +
      `1) THEMES: read this week's meeting transcripts (corpora/success/customers/*/meetings/*/transcript.txt) to learn what leaders keep struggling with. Take the IDEAS only, never a quote, stat, or identity.
` +
      `2) RULE OUT REPEATS: read our published posts from the site source (../website-src, e.g. client/src/data/blogData.ts and shared/blogMeta.ts, including any not linked on /blog) and exclude anything we've already written. We want NEW content.
` +
      `3) SEO / GEO IS THE BAR (not internal resonance): judge each candidate by what people actually search or ask an LLM (check the real landscape with WebFetch). Favor topics with genuine recurring queries AND thin existing results we can beat. A theme that's great for customers but nobody searches is NOT a good pick; say so.
` +
      `4) RECOMMEND ONE, with 2 to 3 title options phrased the way people actually search, plus a one-line why-it-wins (search demand + how we out-rank what's there today).
` +
      `WHEN I SAY GO (or if I already gave you the angle), draft the full post around ONE clear thesis: lead with Reddy's own point of view, follow the shape of our Buyer's Guide / "10 best" posts (definitional opener, query-shaped H2s, a comparison table, an FAQ block for the GEO play), and cover our FULL product suite where relevant (Simulations, Live Assist, Auto QA, coaching, Reporting), not just simulations. External stats are optional and must follow guardrail 2. Deliver in Markdown with title + alternates, an SEO meta description, and target keywords. Draft in the chat for review; do NOT publish.`,
  },
  blog_post: {
    id: "blog_post",
    label: "Create a new blog post",
    emoji: "✍️",
    blurb: "Draft a Reddy blog post in our voice — grounded in the site, our marketing library, and real customer calls.",
    onCard: false,
    run: () =>
      `Let's create a new blog post for Reddy. Follow the BLOG GUARDRAILS in your instructions (calls for topics + context only, never reproduced; Reddy's POV leads; one clear thesis; no competitor size knocks; consistent customer naming; no em dashes). First, in ONE short message, ask me what it should be about (topic/angle, audience, must-hit points) unless I've already told you. Then draft it:
` +
      `• VOICE + FRESHNESS: ground it in Reddy's real voice and positioning. Read our marketing materials under corpora/marketing/, and look at our CURRENT website (source cloned at ../website-src, read the product/marketing pages and the existing blog posts in client/src/data/blogData.ts) so you match our tone, keep claims accurate, and don't repeat a post we've already published.
` +
      `• SUBSTANCE: build the piece on ONE thesis grounded in Reddy's point of view. Use customer conversations only to understand the problem, never to quote, cite a stat, or attribute anything (guardrail 1).
` +
      `• DELIVER (Markdown, in the chat): a working title + 2 to 3 alternates, a one-line SEO meta description, 1 to 3 suggested target keywords, then the full body with clear H2/H3 structure carrying the thesis. Sharp and concrete, no fluff.
` +
      `Show me the draft here for review and iterate with me. Do NOT publish anything.`,
  },
};

export const ALL_PLAY_IDS = Object.keys(PLAYS) as PlayId[];
export const CARD_PLAY_IDS = ALL_PLAY_IDS.filter((id) => PLAYS[id].onCard);

export function isPlayId(x: unknown): x is PlayId {
  return typeof x === "string" && x in PLAYS;
}

/** The instruction to run for a Play, scoped to a meeting/account. */
export function playRunPrompt(id: PlayId, ctx: PlayContext): string {
  return PLAYS[id].run(ctx);
}
