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
  | "accounts_quiet";

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
      `Draft the post-meeting recap email for ${forMeeting(ctx)} (customer: ${acct(ctx)}). Reddy house style: a warm one-line thanks, a short "here's what we discussed," clear next steps, and a link to the recording. Mint the recording link with a 30-day TTL (ttl=2592000) so external clients can view it for a month. If a next meeting was already scheduled live on the call, reference THAT as the next step — do not invent a "schedule a meeting" task. Match the tone of our recent recap emails (search sent mail for examples, and attach the deck / trust-center link only if it fits what we discussed). Output the ready-to-send email body; do NOT send it — I'll review and send.`,
  },
  recording_link: {
    id: "recording_link",
    label: "30-day recording link",
    emoji: "🔗",
    blurb: "A shareable recording + transcript link, valid 30 days, safe to forward to clients.",
    onCard: true,
    run: (ctx) =>
      `Get the shareable recording + transcript link for ${forMeeting(ctx)} with a 30-day TTL (ttl=2592000) and post it as a clickable Slack link I can forward to external clients.`,
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
