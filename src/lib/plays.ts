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
  | "blog"
  | "outreach";

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
  // ONE play for the whole blog motion: it opens by asking what to look at
  // (last week's meetings, Search Console data, a given angle), then researches
  // the chosen lanes and drafts. The BLOG GUARDRAILS (1-14) and the copywriting
  // constitution live in the /api/marketing/chat preamble, which governs every
  // turn; this play carries the workflow.
  blog: {
    id: "blog",
    label: "Write a new blog",
    emoji: "✍️",
    blurb: "The whole blog motion in one play — mine meetings and Search Console for the topic, research the live landscape, draft in Reddy's voice.",
    onCard: false,
    run: () =>
      `Help me write a new blog post for Reddy. The BLOG GUARDRAILS and the copywriting constitution in your instructions apply to everything below.
` +
      `ASK ME FIRST: in ONE short message, ask: "Is there anything specific you'd like me to look at for this blog? I can mine the last week of meetings for topics, check our SEO / Search Console data for winnable queries, work from an angle you already have, or any mix." Then STOP and wait for my answer before researching or drafting. Skip the question only if I already gave you the topic or angle.
` +
      `THEN RESEARCH the lanes my answer calls for (briefly show your reasoning):
` +
      `• MEETINGS: read the last week's transcripts (corpora/success/customers/*/meetings/*/transcript.txt) to learn what leaders keep struggling with. Take the IDEAS only, never a quote, stat, or identity (guardrail 1).
` +
      `• SEARCH DATA (supermetrics MCP): query Google Search Console (sc-domain:reddy.io) per guardrail 10 — the winnable zone is non-brand queries at position 5 to 15 with real impressions, plus question-shaped queries AI engines lift answers from. Ignore CTR on non-brand terms. Name the GSC data behind each pick. For COMPETITOR coverage, pull Semrush Analytics (source id SR) organic keywords — keyword, position, search volume — for the competitor domains in play (zenarate.com and whoever else the topic implicates), and run the gap vs reddy.io: category terms they rank for that we don't are prime targets. Queries are async (data_query, then get_async_query_results), so fire them early and keep working while they run.
` +
      `• LANDSCAPE (WebSearch, then WebFetch to read): what ranks today for each candidate query, and what competitors have published and how they position their features RIGHT NOW — never from memory; their sites and content change. Favor topics with genuine recurring queries AND thin or stale existing results we can beat.
` +
      `• REPEATS + VOICE: read our published posts in the site source (../website-src, client/src/data/blogData.ts and shared/blogMeta.ts, including any not linked on /blog) so we never repeat a topic, and corpora/marketing/ for voice and positioning.
` +
      `RECOMMEND ONE topic (unless I already fixed it): 2 to 3 title options phrased the way people actually search, plus a one-line why-it-wins naming the GSC and landscape evidence. A theme that's great for customers but nobody searches is NOT a good pick; say so.
` +
      `WHEN I SAY GO, draft the full post around ONE clear thesis: lead with Reddy's own point of view, follow the shape of our Buyer's Guide / "10 best" posts (definitional opener, query-shaped H2s, a comparison table where it fits, and a question-shaped liftable FAQ for AI citation per guardrail 11), and cover our FULL product suite where relevant (Simulations, Live Assist, Auto QA, coaching, Reporting), not just simulations. External stats are optional and must follow guardrail 2. Deliver in Markdown in the chat: a working title + 2 to 3 alternates, a one-line SEO meta description, 1 to 3 target keywords, then the full body. Draft here for review and iterate with me; do NOT publish.`,
  },
  // SMYKM outbound sequences across Instantly (email) + HeyReach (LinkedIn).
  // Same surface/model as the blog play; the OUTREACH RULES in the
  // /api/marketing/chat preamble govern every turn (draft-only, explicit
  // approval before any Instantly/HeyReach write).
  outreach: {
    id: "outreach",
    label: "Build an outreach sequence",
    emoji: "📬",
    blurb: "SMYKM outbound across Instantly email + HeyReach LinkedIn — campaign skeleton by type, per-prospect research, drafts, and (on your go) setup in the tools.",
    onCard: false,
    run: () =>
      `Help me build an outbound sequence. FIRST read the constitution: corpora/marketing/outbound/smykm-guide.md (research method + email anatomy), corpora/marketing/outbound/sequence-templates.md (per-campaign-type skeletons), and corpora/marketing/copywriting-guide.md. The OUTREACH RULES in your instructions apply to everything below.
` +
      `ASK ME FIRST, in ONE short message (skip anything I already told you): (1) campaign type — fresh cold outbound, ABM on named accounts, or reviving people we've talked to before; (2) channels — Instantly email, HeyReach LinkedIn, or both; (3) the audience and where the list is — paste names here or upload a CSV/XLSX with the panel on this page (uploads land in corpora/marketing/uploads/); (4) context — the offer or event, CTA, who's sending and in whose voice, plus the sender's authentic ties beyond the inventory in the guide (anything true that could connect to these prospects); (5) what we already know about these accounts' stack and situation (tools they run, prior conversations) so the value prop can subtract instead of recite; (6) any must-hit points or constraints. Then STOP and wait.
` +
      `THEN BUILD, in this order, checking in with me between stages:
` +
      `1) SKELETON: assemble the sequence from sequence-templates.md for my campaign type — every step, day offsets, and each slot marked [TEMPLATED] vs [PERSONALIZED] with merge fields in {{camelCase}}. Show me the skeleton + the templated copy for approval BEFORE researching prospects.
` +
      `2) RESEARCH each prospect per the SMYKM guide: fan out parallel subagents (Task tool), one per prospect, covering the four lanes (own posts FIRST, then human, company, space) plus the CRM. Hard rules: nothing older than ~12 months, no fabrication (label VERIFIED vs inferred), verify they still hold the role. For revival campaigns, start from our meeting transcripts (corpora/success/customers/*/meetings/*/transcript.txt) and HubSpot history: what we discussed, why it stalled, what's changed since.
` +
      `3) DECISION POINTS, before drafting: anything the research turned up that changes the play comes back to me as a QUESTION with options and your recommendation, per the guide's judgment-calls section — role transitions, competitive proof points, stack claims you can't source, missing authentic ties (truth slots), altitude concerns. Never decide silently; never announce a decision you made for me.
` +
      `4) PERSONALIZE: fill each prospect's merge fields ({{smykmSubject}}, {{smykmOpener}}, {{hookCallback}}, and whatever the skeleton needs). Subjects follow the sender-element rule (one element must be mine/Reddy's — research alone never makes the subject). Value props are SUBTRACTIVE: concede what the account already has, pitch the gap and the connective tissue. Where the research surfaced no in-window hook, SAY SO and use the company/space fallback (or the space-lingo move) rather than faking depth.
` +
      `5) DELIVER in the chat: the full sequence (every step, subject + body; LinkedIn connect notes under 300 characters) plus a per-prospect table of hooks and merge-field values with sources, with any [confirm or cut] truth slots called out for my answer. Iterate with me until approved.
` +
      `6) SETUP (only after I explicitly say to): create the campaign in Instantly via the instantly MCP tools — campaign PAUSED, sequence steps in, leads uploaded with their custom variables — and the LinkedIn sequence in HeyReach via the heyreach MCP or the official HeyReach CLI (per your tool notes; if neither works, tell me and deliver the LinkedIn steps as copy). NEVER activate, launch, send, or delete anything. Report back the campaign IDs and links so I can review in the apps and launch myself.`,
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
