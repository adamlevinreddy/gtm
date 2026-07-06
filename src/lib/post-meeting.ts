// ============================================================================
// POST-MEETING TRIAGE → SUGGEST (confirm-first), routed PER ITEM
//
// A single meeting's action items can span boards (a prospect follow-up → GTM,
// an internal cleanup → Operations, a signed-customer task → Success). So we
// route EACH ITEM to its own board. Claude runs in the sandbox (oneshot): reads
// the transcript + meta, uses board_list to check existing cards, and returns
// strict JSON where every item carries its own boardKey + disposition
// (new / subtask-of-existing / update-existing). We DON'T create anything — we
// post a Slack suggestion grouped by board (owners @-mentioned) and stash the
// proposal in KV. A human replies "@Reddy-GTM confirm"; slack/events injects the
// proposal and the agent creates each item on ITS board. Never throws.
// ============================================================================

import { kv } from "@/lib/kv-client";
import { postToChannel, salesChannel } from "@/lib/slack";
import {
  boardUrl,
  selfBaseUrl,
  resolveBoardId,
  createWorkItem,
  createSubtask,
  logActivity,
  getItem,
  companySlug,
  boardLink,
  type WorkItemKind,
} from "@/lib/work-items";
import { canonicalizeCompany, searchCompaniesByName, hubspotCompanyUrl } from "@/lib/hubspot";
import { isConeOfSilence } from "@/lib/cone-of-silence";
import { isCardMutedForBot } from "@/lib/card-mute";
import { PLAYS, CARD_PLAY_IDS, isPlayId, type PlayId } from "@/lib/plays";

export type AccountLink = { name: string; hubspotUrl: string | null; boardUrl: string };

/**
 * Resolve the distinct companies named on the triaged items to {HubSpot account
 * link, board-filtered link}. We want a HubSpot association even when there is
 * NO deal yet, so we link the COMPANY record: exact-name match first, then a
 * fuzzy CONTAINS fallback. Best-effort + bounded (≤6 companies) — a miss just
 * drops the HubSpot link for that company, never blocks the Slack post.
 * Exported for the end-of-day digest, which reuses the same account links.
 */
export async function resolveAccountLinks(companies: Array<string | null>): Promise<AccountLink[]> {
  const distinct = Array.from(new Set(companies.map((c) => (c ?? "").trim()).filter(Boolean)));
  return Promise.all(
    distinct.slice(0, 6).map(async (name): Promise<AccountLink> => {
      let hit = await canonicalizeCompany(name).catch(() => null);
      if (!hit) hit = (await searchCompaniesByName(name, 1).catch(() => []))[0] ?? null;
      const hubspotUrl = hit ? await hubspotCompanyUrl(hit.id).catch(() => null) : null;
      return { name: hit?.name ?? name, hubspotUrl, boardUrl: boardLink({ customerSlug: companySlug(name) }) };
    })
  );
}

// action_id on the Slack "Confirm & create tasks" button → routed by the
// interactivity endpoint. The button's value carries the meeting botId.
export const CONFIRM_ACTION_ID = "pm_confirm_create";

const VALID_KINDS: readonly WorkItemKind[] = [
  "pricing_proposal", "deck_qbr", "meeting_prep", "prep_custom_demo", "rfp_response",
  "contract_redline", "followup_email", "book_meeting", "reengage_tickler", "recording_link",
  "scheduling", "account_research", "enablement_collateral", "crm_update", "log_to_hubspot",
  "propose_stage_move", "action_items", "generic",
];

const VALID_BOARDS = ["gtm", "success", "operations"] as const;
type BoardKey = (typeof VALID_BOARDS)[number];
type Disposition = "new" | "subtask" | "update";

export type TriageItem = {
  boardKey: BoardKey;
  disposition: Disposition;
  title: string;
  kind: WorkItemKind;
  ownerEmail: string | null;
  company: string | null; // the company/prospect this item is about (HubSpot-resolved when grounded)
  targetId: string | null;
  targetTitle: string | null;
  note: string | null;
  // Per-item idempotency ref. Per-meeting triage leaves this unset (all items
  // share the meeting's botId — a repeat title IS a dup). The end-of-day digest
  // aggregates many meetings under one proposal, so it sets a per-company ref
  // here to keep the (sourceRef, kind, title) unique index from collapsing the
  // same short title across different companies.
  sourceRef?: string;
};

export type TriageResult = {
  meetingType: "internal" | "prospect" | "signed_customer" | "pilot" | "partner";
  meetingTitle: string | null;
  items: TriageItem[];
};

export type ProposeResult = {
  ok: boolean;
  meetingType?: TriageResult["meetingType"];
  proposed: number;
  boards?: string[];
  slackTs?: string;
  skipped?: string;
  error?: string;
};

const IDEMPOTENCY_TTL = 14 * 24 * 3600;
const PROPOSAL_TTL = 7 * 24 * 3600;
const BOARD_LABEL: Record<BoardKey, string> = { gtm: "GTM", success: "Success", operations: "Operations" };
const BOARD_EMOJI: Record<BoardKey, string> = { gtm: "📈", success: "🤝", operations: "🛠️" };

// ----------------------------------------------------------------------------
// Prompt — read the meeting, route EACH ITEM, reconcile vs existing cards.
// ----------------------------------------------------------------------------

export function buildTriagePrompt(botId: string): string {
  return [
    `You are triaging a finished meeting into the Reddy GTM tracking board. You PROPOSE only — a human confirms in Slack before anything is created. Be precise; do not invent commitments.`,
    ``,
    `MEETING BOT ID: ${botId}`,
    ``,
    `STEP 1 — READ THE MEETING (KB is cloned in your sandbox; '_unsorted' is a real slug, so glob):`,
    "  - transcript: `corpora/success/customers/*/meetings/" + botId + "/transcript.txt`",
    "  - metadata (title, attendees+emails): `corpora/success/customers/*/meetings/" + botId + "/meta.json`",
    `Read BOTH. Capture the meeting title and note who the @reddy.io attendees are.`,
    ``,
    `STEP 2 — EXTRACT THE ACTION ITEMS (real commitments / next-steps / owed deliverables only).`,
    ``,
    `STEP 3 — DISAMBIGUATE AMBIGUOUS NAMES VIA HUBSPOT (targeted — do NOT look up every name; that wastes time). You have connected HubSpot tools (search contacts + companies). Only when an action item's phrasing is genuinely AMBIGUOUS about who is involved — most often two adjacent names that could be one-person-at-a-company OR two separate people (e.g. "Stanley, I need to call Regina", "follow up with Dana at Pinnacle") — do a quick HubSpot search to resolve it:`,
    `  - If <Word> is the COMPANY that contact belongs to → keep ONE task ("Call <First Last> (<Company>)").`,
    `  - If <First> and <Word> are BOTH separate CONTACTS (often at the SAME company) → SPLIT into TWO tasks; never invent a "<First> <Word>" person.`,
    `    Worked example: "Stanley, I need to try calling Regina today" → HubSpot shows Stanley Vigil AND Regina Houston are BOTH contacts at AT&T → emit TWO items ("Call Regina Houston (AT&T)" and "Follow up with Stanley Vigil (AT&T)"), NOT "Call Regina at Stanley".`,
    `  - When you resolve a contact, put the full name + company in the title. If HubSpot has no match, keep the raw name and add note:"unresolved in HubSpot — confirm contact".`,
    `  - HARD CAP: at most ~4 HubSpot lookups total, only for the ambiguous items. CLEAR single names (e.g. "Maureen from Best Buy") need NO lookup — leave them as-is. Read-only: never write to HubSpot.`,
    ``,
    `STEP 4 — ROUTE EACH ITEM TO ITS OWN BOARD (items from one meeting span boards; route by what EACH item is about):`,
    `  - "gtm": ANYTHING sales or marketing — INCLUDING sales-ops. Prospecting, demos, pricing, follow-ups, conferences/CCW, lead lists, CRM/HubSpot cleanup, pipeline-review logistics, marketing. If it's sales-related in any way, it is GTM. This is the default.`,
    `  - "success": EXISTING-CUSTOMER work for a SIGNED customer (onboarding, QBR, CS, expansion) — mainly tasks owned by Adam or Oliver for that customer.`,
    `  - "operations": back-office / company ops ONLY — accounting, finance, legal, board meetings, compliance, and tasks owned by Christina Valla. NOT sales ops.`,
    `  So: "re-upload the CCW lead list to HubSpot" → gtm (sales ops, not operations). "QBR prep for <signed customer>" → success. "Send the board deck to the auditors" / a Christina Valla legal task → operations. When unsure → gtm.`,
    ``,
    `STEP 5 — CHECK EXISTING CARDS before deciding disposition. For each board you're routing items to, call board_list({ boardKey, customerSlug? }) to see existing open cards (id, title, kind, status, ownerEmail). Then set each item's disposition:`,
    `  - "update": same work as an existing card → set targetId = that card id, targetTitle = its title, note = the update to log (no new card).`,
    `  - "subtask": a sub-step of an existing in-flight card → set targetId = parent card id, targetTitle = its title.`,
    `  - "new": otherwise.`,
    ``,
    `STEP 6 — RETURN STRICT JSON in a SINGLE fenced \`\`\`json block, nothing after it:`,
    "```json",
    `{`,
    `  "meetingType": "internal" | "prospect" | "signed_customer" | "pilot" | "partner",`,
    `  "meetingTitle": string,`,
    `  "items": [`,
    `    { "boardKey": "gtm"|"success"|"operations", "disposition": "new"|"subtask"|"update", "title": string, "kind": "<one of: ${VALID_KINDS.join(", ")}>", "ownerEmail": string|null, "company": string|null, "targetId": string|null, "targetTitle": string|null, "note": string|null }`,
    `  ]`,
    `}`,
    "```",
    `title = short imperative; ownerEmail = the @reddy.io attendee who clearly owns it (from meta.json), else null. company = the external customer/prospect this specific item is about (a single meeting's items can span different companies — e.g. a lead-list review). Use the HubSpot-resolved company name when you grounded it in STEP 3, else the company named in the item; null for purely internal items with no external company. You MAY call board_list (read-only). Do NOT create/update/move any card.`,
    `CRITICAL: your FINAL message must be ONLY the single fenced \`\`\`json block — no summary, no prose before or after it. The JSON is your entire deliverable.`,
  ].join("\n");
}

// ----------------------------------------------------------------------------
// Parse
// ----------------------------------------------------------------------------

export function parseTriage(answer: string | null | undefined): TriageResult | null {
  if (!answer || typeof answer !== "string") return null;
  const candidates: string[] = [];
  const fenced = answer.match(/```(?:json)?\s*([\s\S]*?)```/gi);
  if (fenced) for (const b of fenced) candidates.push(b.replace(/```(?:json)?\s*/i, "").replace(/```$/, "").trim());
  // Every balanced {...} run — tolerant of prose + embedded board_list tool
  // output around the real JSON (a naive first-{…last-} slice would merge them).
  candidates.push(...extractBalancedObjects(answer));
  // Prefer a candidate that yields real items; fall back to the first that parses.
  let fallback: TriageResult | null = null;
  for (const c of candidates) {
    const p = tryParse(c);
    if (p && p.items.length > 0) return p;
    if (p && !fallback) fallback = p;
  }
  return fallback;
}

// Return every top-level balanced {...} substring (ignores braces inside strings).
function extractBalancedObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") { depth--; if (depth === 0 && start !== -1) { out.push(text.slice(start, i + 1)); start = -1; } }
  }
  return out;
}

function tryParse(raw: string): TriageResult | null {
  let obj: unknown;
  try { obj = JSON.parse(raw); } catch { return null; }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.items)) return null;

  const items: TriageItem[] = [];
  for (const it of o.items) {
    if (!it || typeof it !== "object") continue;
    const i = it as Record<string, unknown>;
    const title = typeof i.title === "string" ? i.title.trim() : "";
    if (!title) continue;
    const disposition: Disposition =
      i.disposition === "subtask" || i.disposition === "update" ? i.disposition : "new";
    const targetId = typeof i.targetId === "string" && i.targetId.trim() ? i.targetId.trim() : null;
    items.push({
      boardKey: coerceBoard(i.boardKey) ?? "gtm",
      disposition: disposition !== "new" && !targetId ? "new" : disposition,
      title,
      kind: coerceKind(i.kind),
      ownerEmail: typeof i.ownerEmail === "string" && i.ownerEmail.includes("@") ? i.ownerEmail.trim().toLowerCase() : null,
      company: typeof i.company === "string" && i.company.trim() ? i.company.trim() : null,
      targetId,
      targetTitle: typeof i.targetTitle === "string" && i.targetTitle.trim() ? i.targetTitle.trim() : null,
      note: typeof i.note === "string" && i.note.trim() ? i.note.trim() : null,
    });
  }
  return { meetingType: coerceType(o.meetingType), meetingTitle: typeof o.meetingTitle === "string" && o.meetingTitle.trim() ? o.meetingTitle.trim() : null, items };
}

function coerceBoard(v: unknown): BoardKey | null {
  const k = typeof v === "string" ? v.toLowerCase().trim() : "";
  return (VALID_BOARDS as readonly string[]).includes(k) ? (k as BoardKey) : null;
}
function coerceType(v: unknown): TriageResult["meetingType"] {
  const ok = ["internal", "prospect", "signed_customer", "pilot", "partner"];
  return typeof v === "string" && ok.includes(v) ? (v as TriageResult["meetingType"]) : "prospect";
}
function coerceKind(v: unknown): WorkItemKind {
  return typeof v === "string" && (VALID_KINDS as readonly string[]).includes(v) ? (v as WorkItemKind) : "action_items";
}

// ----------------------------------------------------------------------------
// Oneshot
// ----------------------------------------------------------------------------

async function runOneshot(question: string, userEmail: string, reqId: string): Promise<string | null> {
  const secret = process.env.MCP_INTERNAL_SECRET;
  if (!secret) return null;
  try {
    const res = await fetch(`${selfBaseUrl()}/api/agent/oneshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-reddy-internal": secret },
      // Triage does read + HubSpot grounding + board_list + JSON; let the
      // oneshot route poll well past its 240s interactive default (bounded by
      // its own 800s maxDuration). The poll returns the instant the agent
      // writes its result, so a generous ceiling only costs us on a true hang.
      body: JSON.stringify({ question, userEmail, oneshotRequestId: reqId, pollTimeoutMs: 680_000 }),
    });
    const json = (await res.json()) as { ok?: boolean; answer?: string };
    if (json?.ok && typeof json.answer === "string" && json.answer.trim()) return json.answer;
  } catch { /* swallow */ }
  return null;
}

// ============================================================================
// GENERATIVE POST-MEETING CARD (Arc VII). Instead of auto-extracting a task
// list, a sandbox reads the meeting and CURATES which Plays fit — the card
// offers those as buttons the human chooses to run. Internal / no-play meetings
// stay quiet. Task extraction moves to the end-of-day digest (later phase);
// the triage functions above are kept for that.
// ============================================================================

// One shared prefix; each play button gets a UNIQUE action_id (Slack requires
// action_ids unique within a message) and carries `${playId}|${botId}` in value.
export const PLAY_RUN_ACTION_ID = "pm_play_run";
export const PM_WATCH_ARM_ACTION = "pm_watch_arm";
export const playCardKey = (botId: string) => `postmeeting:playcard:${botId}`;

// A conditional follow-up the curator heard in the meeting ("they'll huddle,
// regroup Monday"), offered as a one-tap "arm" button on the card (Arc VIII P2).
export type WatchSuggestion = {
  signal: "no_reply" | "no_activity" | "time_only";
  inDays: number; // whole days from now until the check
  domain: string | null; // account email domain, for no_reply
  label: string; // "if no reply from Nike by next Mon"
};

export type PlayCuration = {
  meetingType: TriageResult["meetingType"];
  meetingTitle: string | null;
  account: string | null;
  read: string;
  plays: PlayId[];
  followup: WatchSuggestion | null;
};

export function buildPlayCurationPrompt(botId: string): string {
  const catalog = CARD_PLAY_IDS.map((id) => `  - ${id}: ${PLAYS[id].label} — ${PLAYS[id].blurb}`).join("\n");
  return [
    `A meeting just ended. Read it and decide which Reddy GTM "Plays" the team should be offered as one-click buttons. You do NOT run anything or create tasks — you only CHOOSE which plays fit. Be selective: only plays that clearly match what happened.`,
    ``,
    `MEETING BOT ID: ${botId}`,
    `READ THE MEETING (KB is cloned in your sandbox; '_unsorted' is a real slug, so glob):`,
    "  - transcript: `corpora/success/customers/*/meetings/" + botId + "/transcript.txt`",
    "  - metadata (title, attendees+emails): `corpora/success/customers/*/meetings/" + botId + "/meta.json`",
    ``,
    `CLASSIFY:`,
    `  - meetingType: internal | prospect | signed_customer | pilot | partner. "internal" = every attendee is @reddy.io (team sync/standup/pipeline review). Internal meetings get NO plays.`,
    `  - account: the customer/prospect company name (null for internal).`,
    `  - read: ONE sentence — what happened + where it stands / our posture. No fluff.`,
    ``,
    `AVAILABLE PLAYS (choose ONLY from these ids):`,
    catalog,
    ``,
    `CHOOSE the plays that fit, most-relevant first:`,
    `  - External meeting with a real conversation → usually recap_email (first), then recording_link.`,
    `  - Pricing / commercials / cost discussed → pricing.`,
    `  - A contract / NDA / DPA / redline came up → redline.`,
    `  - Complex account / they want the full picture → account_catchup.`,
    `  - A formal RFP / RFI / requirements list → rfp.`,
    `  - Internal, or a pure status call with no external next step → plays: [] (stay quiet).`,
    `  - Do NOT suggest booking a meeting — if a next meeting was set live, that's already handled.`,
    ``,
    `DETECT A CONDITIONAL FOLLOW-UP (optional — only if you clearly hear one):`,
    `  Listen for "they'll go quiet then we reconnect" language — "they're going to huddle internally", "let's regroup Monday", "if I don't hear back by <when>", "circle back in two weeks", "reach out next month". If there's a clear one, propose a "followup" watch the team can arm with one tap:`,
    `    - signal: "no_reply" (we're waiting on THEM to email back — the common case) | "no_activity" (waiting on any movement on the deal) | "time_only" (just a scheduled reminder, no condition).`,
    `    - inDays: whole days from TODAY (Pacific) until the check — Monday ≈ days until next Mon, "two weeks" = 14, "next month" = 30. Your best estimate.`,
    `    - domain: the customer's email domain from meta.json attendees (e.g. "nike.com"), for no_reply; null if unknown.`,
    `    - label: a short human line, e.g. "if no reply from Nike by next Mon".`,
    `  If there's no clear conditional, set "followup": null. NEVER invent one.`,
    ``,
    `Return ONLY a fenced json block, nothing else:`,
    "```json",
    `{ "meetingType": "prospect", "meetingTitle": "...", "account": "Acme or null", "read": "...", "plays": ["recap_email","recording_link"], "followup": { "signal": "no_reply", "inDays": 4, "domain": "acme.com", "label": "if no reply from Acme by Mon" } }`,
    "```",
    `(set "followup": null when nothing conditional was said.)`,
  ].join("\n");
}

const PLAY_MEETING_TYPES = ["internal", "prospect", "signed_customer", "pilot", "partner"] as const;

function coercePlayCuration(o: Record<string, unknown>): PlayCuration {
  const meetingType = (PLAY_MEETING_TYPES as readonly string[]).includes(o.meetingType as string)
    ? (o.meetingType as PlayCuration["meetingType"])
    : "prospect";
  const account =
    typeof o.account === "string" && o.account.trim() && o.account.toLowerCase() !== "null" ? o.account.trim() : null;
  const plays = Array.isArray(o.plays)
    ? [...new Set(o.plays.filter((p): p is PlayId => isPlayId(p) && CARD_PLAY_IDS.includes(p as PlayId)))].slice(0, 5)
    : [];
  return {
    meetingType,
    meetingTitle: typeof o.meetingTitle === "string" ? o.meetingTitle : null,
    account,
    read: typeof o.read === "string" ? o.read.slice(0, 400) : "",
    plays,
    followup: coerceFollowup(o.followup),
  };
}

function coerceFollowup(f: unknown): WatchSuggestion | null {
  if (!f || typeof f !== "object") return null;
  const o = f as Record<string, unknown>;
  const signal = (["no_reply", "no_activity", "time_only"] as string[]).includes(o.signal as string)
    ? (o.signal as WatchSuggestion["signal"])
    : null;
  const inDays = typeof o.inDays === "number" && o.inDays > 0 ? Math.min(Math.round(o.inDays), 90) : null;
  if (!signal || !inDays) return null;
  return {
    signal,
    inDays,
    domain: typeof o.domain === "string" && o.domain.trim() && o.domain.toLowerCase() !== "null" ? o.domain.trim().toLowerCase() : null,
    label: typeof o.label === "string" ? o.label.slice(0, 160) : "",
  };
}

export function parsePlayCuration(answer: string): PlayCuration | null {
  if (!answer || typeof answer !== "string") return null;
  // Same tolerance as parseTriage: try every fenced block AND every balanced
  // {...} run (prose, a leading non-JSON fence, or embedded tool output around
  // the real answer would all defeat a naive first-fence / greedy-brace match).
  const candidates: string[] = [];
  const fenced = answer.match(/```(?:json)?\s*([\s\S]*?)```/gi);
  if (fenced) for (const b of fenced) candidates.push(b.replace(/```(?:json)?\s*/i, "").replace(/```$/, "").trim());
  candidates.push(...extractBalancedObjects(answer));
  let fallback: PlayCuration | null = null;
  for (const c of candidates) {
    let o: unknown;
    try { o = JSON.parse(c); } catch { continue; }
    if (!o || typeof o !== "object") continue;
    const cur = coercePlayCuration(o as Record<string, unknown>);
    // Prefer the candidate the model clearly meant — a recognized meetingType
    // or a real play set; otherwise keep looking, falling back to the first
    // object that parsed at all.
    const recognized = (PLAY_MEETING_TYPES as readonly string[]).includes(String((o as Record<string, unknown>).meetingType));
    if (recognized || cur.plays.length > 0) return cur;
    if (!fallback) fallback = cur;
  }
  return fallback;
}

function buildPlayCard(
  botId: string,
  cur: PlayCuration,
  recUrl: string,
  account: AccountLink | null,
): { text: string; blocks: object[] } {
  const title = cur.meetingTitle ?? "the meeting";
  const acctBits = account
    ? account.hubspotUrl
      ? ` · <${account.hubspotUrl}|HubSpot>`
      : ""
    : "";
  const blocks: object[] = [
    { type: "header", text: { type: "plain_text", text: "📋  Suggested plays", emoji: true } },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `From *${title}*${cur.account ? ` · ${cur.account}${acctBits}` : ""}\n▶ <${recUrl}|Watch recording & read transcript>`,
        },
      ],
    },
  ];
  if (cur.read) blocks.push({ type: "section", text: { type: "mrkdwn", text: `_${cur.read}_` } });

  const elements: object[] = cur.plays.map((id, i) => ({
    type: "button",
    action_id: `${PLAY_RUN_ACTION_ID}:${id}`,
    ...(i === 0 ? { style: "primary" as const } : {}),
    text: { type: "plain_text", text: `${PLAYS[id].emoji} ${PLAYS[id].label}`, emoji: true },
    value: `${id}|${botId}`,
  }));
  // "Open a session" is a url button (the /m Theater Ask tab is scoped to this
  // meeting) — no action_id, so Slack never POSTs it.
  elements.push({
    type: "button",
    text: { type: "plain_text", text: "💬 Open a session", emoji: true },
    url: recUrl,
  });
  blocks.push({ type: "actions", elements });

  // Conditional follow-up the curator heard — offer to arm it (Arc VIII P2).
  if (cur.followup) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `⏰ *Set a conditional follow-up?* _${cur.followup.label || `watch ${cur.account ?? "this account"}`}_ — I'll check, and draft one only if it's warranted.` },
    });
    blocks.push({
      type: "actions",
      elements: [{ type: "button", action_id: PM_WATCH_ARM_ACTION, text: { type: "plain_text", text: "⏰ Arm follow-up watch", emoji: true }, value: botId }],
    });
  }

  blocks.push({
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: "Tap a play to kick it off in this thread — nothing runs until you do. Or open a session to dig in.",
      },
    ],
  });
  return { text: `Suggested plays from ${title}`, blocks };
}

/** The play-button handler reads this to build the run prompt with the account. */
export type PlayCardStash = { botId: string; account: string | null; followup?: WatchSuggestion | null };
export async function getPlayCardStash(botId: string): Promise<PlayCardStash | null> {
  return (await kv.get<PlayCardStash>(playCardKey(botId)).catch(() => null)) ?? null;
}

// ----------------------------------------------------------------------------
// proposeFromMeeting — read the meeting → SUGGEST PLAYS in Slack. Never throws.
// ----------------------------------------------------------------------------

export async function proposeFromMeeting(botId: string, opts?: { force?: boolean }): Promise<ProposeResult> {
  const claimKey = `proactive:meeting:${botId}`;
  let claimedHere = false;
  // Release the idempotency claim on any failure so a re-trigger (or retry) can
  // run again — otherwise a transient timeout would block this meeting's triage
  // for the full IDEMPOTENCY_TTL. Success keeps the claim (post-once semantics).
  const releaseClaim = async () => {
    if (claimedHere) await kv.del(claimKey).catch(() => {});
  };
  try {
    if (!botId) return { ok: false, proposed: 0, error: "missing botId" };

    // Cone of silence — a confidential meeting is never slacked, even via the
    // backstop cron or a forced replay.
    if (await isConeOfSilence(botId)) return { ok: true, proposed: 0, skipped: "cone-of-silence" };

    // Card muted for this meeting/series (a Settings toggle). The bot still
    // recorded — the meeting is searchable — we just don't push the card.
    // Checked before the idempotency claim so un-muting + a forced replay can
    // still post later.
    if (await isCardMutedForBot(botId)) return { ok: true, proposed: 0, skipped: "card-muted" };

    if (!opts?.force) {
      const claimed = await kv
        .set(claimKey, new Date().toISOString(), { nx: true, ex: IDEMPOTENCY_TTL })
        .catch(() => "errored");
      if (claimed === null) return { ok: true, proposed: 0, skipped: "already-processed" };
      if (claimed !== "errored") claimedHere = true;
    }

    const runnerEmail = process.env.POST_MEETING_AGENT_EMAIL || "adam@reddy.io";
    const answer = await runOneshot(buildPlayCurationPrompt(botId), runnerEmail, `postmeeting:${botId}`);
    if (!answer) { await releaseClaim(); return { ok: false, proposed: 0, error: "curation agent unavailable or empty" }; }

    const cur = parsePlayCuration(answer);
    if (!cur) { await releaseClaim(); return { ok: false, proposed: 0, error: "could not parse curation JSON" }; }

    // Internal meetings, and meetings where nothing fits (no plays AND no
    // conditional follow-up), stay QUIET — no card. (Task extraction moved to
    // the end-of-day digest; the per-meeting moment is the play card, opt-in.)
    if (cur.meetingType === "internal" || (cur.plays.length === 0 && !cur.followup)) {
      return { ok: true, meetingType: cur.meetingType, proposed: 0, skipped: cur.meetingType === "internal" ? "internal" : "no-plays" };
    }

    // One HubSpot account link for the card header. Best-effort.
    const accounts = await resolveAccountLinks([cur.account]).catch(() => [] as AccountLink[]);
    const recUrl = `${selfBaseUrl()}/m/${botId}`;

    // Stash the account BEFORE posting the card so a button clicked the instant
    // the card lands still resolves its account (the play-button handler reads
    // this to scope each run prompt).
    await kv.set(playCardKey(botId), { botId, account: cur.account, followup: cur.followup }, { ex: PROPOSAL_TTL }).catch(() => {});

    let slackTs: string | undefined;
    const channel = salesChannel();
    if (channel) {
      try {
        const res = await postToChannel(channel, buildPlayCard(botId, cur, recUrl, accounts[0] ?? null));
        slackTs = res.ts;
      } catch { /* ignore Slack failures */ }
    }

    return { ok: true, meetingType: cur.meetingType, proposed: cur.plays.length, ...(slackTs ? { slackTs } : {}) };
  } catch (err) {
    await releaseClaim();
    return { ok: false, proposed: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// ----------------------------------------------------------------------------
// Confirm → create. The Slack "Confirm & create tasks" button (and the text
// "@Reddy-GTM confirm" reply) resolve to executeProposal, which creates each
// item DETERMINISTICALLY by its disposition — no agent round-trip. Every item
// is stamped sourceRef=botId so it links back to the source meeting and the
// (sourceRef, kind, title) unique index makes a double-confirm idempotent.
// ----------------------------------------------------------------------------

export type StoredProposal = { botId: string } & TriageResult;

export function proposalKeyForBot(botId: string): string {
  return `postmeeting:proposal:bot:${botId}`;
}

export async function getStoredProposal(botId: string): Promise<StoredProposal | null> {
  if (!botId) return null;
  return (await kv.get<StoredProposal>(proposalKeyForBot(botId)).catch(() => null)) ?? null;
}

export type ExecuteResult = {
  ok: boolean;
  created: number;
  subtasks: number;
  updated: number;
  skipped: number;
  errors: string[];
};

export async function executeProposal(
  proposal: StoredProposal,
  actorEmail: string
): Promise<ExecuteResult> {
  const res: ExecuteResult = { ok: true, created: 0, subtasks: 0, updated: 0, skipped: 0, errors: [] };
  const botId = proposal.botId;
  for (const it of proposal.items) {
    try {
      const payload = it.note ? { detail: it.note } : undefined;
      // Tag the card with the company it's about (a meeting spans companies),
      // so it shows under the board's Company filter + the company board link.
      const customerSlug = companySlug(it.company);
      // Per-item ref when set (digest), else the proposal's botId (per-meeting).
      const sourceRef = it.sourceRef ?? botId;

      // update → append to the existing card's activity ledger (no new card).
      if (it.disposition === "update" && it.targetId) {
        const target = await getItem(it.targetId);
        if (target) {
          const wrote = await logActivity(it.targetId, {
            kind: "logged_activity",
            actorKind: "human",
            actorEmail,
            body: it.note ?? it.title,
            dedupeKey: `pm:${sourceRef}:upd:${it.targetId}:${it.title}`.slice(0, 180),
          });
          if (wrote) res.updated += 1;
          else res.skipped += 1;
          continue;
        }
        // target deleted between propose and confirm → fall through to create
      }

      // subtask → child of the existing card.
      if (it.disposition === "subtask" && it.targetId) {
        const parent = await getItem(it.targetId);
        if (parent) {
          const child = await createSubtask(it.targetId, {
            title: it.title,
            kind: it.kind,
            status: "approved",
            source: "post_meeting",
            ownerEmail: it.ownerEmail ?? null,
            sourceRef,
            customerSlug,
            payload,
            createdBy: actorEmail,
          });
          if (child) res.subtasks += 1;
          else res.skipped += 1;
          continue;
        }
        // parent gone → fall through to create a standalone card
      }

      // new (or fallback) → fresh card on its own board.
      const created = await createWorkItem({
        title: it.title,
        kind: it.kind,
        status: "approved",
        source: "post_meeting",
        boardId: await resolveBoardId(it.boardKey),
        ownerEmail: it.ownerEmail ?? null,
        sourceRef,
        customerSlug,
        payload,
        createdBy: actorEmail,
      });
      if (created) res.created += 1;
      else res.skipped += 1;
    } catch (err) {
      res.errors.push(`${it.title}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  res.ok = res.errors.length === 0;
  return res;
}

// ----------------------------------------------------------------------------
// Slack suggestion — grouped by board (table-like), owners @-mentioned.
// ----------------------------------------------------------------------------

function ownerTag(email: string | null, slackIds: Record<string, string | null>): string {
  if (!email) return "_unassigned_";
  const id = slackIds[email];
  return id ? `<@${id}>` : `@${email.split("@")[0]}`;
}

function rowFor(it: TriageItem, slackIds: Record<string, string | null>): string {
  const owner = ownerTag(it.ownerEmail, slackIds);
  if (it.disposition === "update")
    return `• ✎ *update* "${it.targetTitle ?? "existing"}" — ${it.note ?? it.title} · ${owner}`;
  if (it.disposition === "subtask")
    return `• ↳ *subtask* of "${it.targetTitle ?? "existing"}" · ${it.title} · _${it.kind}_ · ${owner}`;
  return `• 🆕 ${it.title} · _${it.kind}_ · ${owner}`;
}

// Exported for the planned end-of-day task digest, which reuses the triage
// toolkit (buildTriagePrompt → parseTriage → this) to post one confirm-first
// card for the day's meetings. The per-meeting card no longer posts tasks —
// it curates Plays — but the confirm handler in slack/interactivity is still
// wired for this path.
export function buildSuggestionMessage(
  parsed: TriageResult,
  slackIds: Record<string, string | null>,
  botId: string,
  accounts: AccountLink[] = [],
  recUrl?: string,
  headerText = "📋  Post-meeting suggestions",
): { text: string; blocks: object[] } {
  const title = parsed.meetingTitle ?? "the meeting";
  const boardsWithItems = (VALID_BOARDS as readonly BoardKey[]).filter((b) =>
    parsed.items.some((i) => i.boardKey === b)
  );

  const text = `Post-meeting suggestions from ${title} — ${parsed.items.length} task${
    parsed.items.length === 1 ? "" : "s"
  } across ${boardsWithItems.map((b) => BOARD_LABEL[b]).join(", ") || "—"} (nothing created yet).`;

  const ctx = `From *${title}* · ${parsed.items.length} task${parsed.items.length === 1 ? "" : "s"} · nothing created until you confirm`;

  const blocks: object[] = [
    { type: "header", text: { type: "plain_text", text: headerText, emoji: true } },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: recUrl ? `${ctx}\n▶ <${recUrl}|Watch recording & read transcript>` : ctx,
      }],
    },
  ];

  // Account context — link each company to its HubSpot record (even with no
  // deal) and to the board filtered for it, mirroring the CRM card's links.
  if (accounts.length) {
    blocks.push({
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: accounts
          .map((a) =>
            a.hubspotUrl
              ? `🏢 *${a.name}* · <${a.hubspotUrl}|HubSpot> · <${a.boardUrl}|board>`
              : `🏢 *${a.name}* · <${a.boardUrl}|board>`
          )
          .join("\n"),
      }],
    });
  }

  if (parsed.items.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_No action items found — looks like a pure status meeting._" } });
  } else {
    for (const b of boardsWithItems) {
      const boardItems = parsed.items.filter((i) => i.boardKey === b);
      const rowStrs = boardItems.map((i) => rowFor(i, slackIds));
      blocks.push({ type: "divider" });
      // Slack caps a section's text at 3000 chars; a busy digest can put enough
      // rows on one board to exceed that, so chunk them across sections.
      let buf = `${BOARD_EMOJI[b]} *${BOARD_LABEL[b]} board* · ${boardItems.length}`;
      for (const r of rowStrs) {
        if (`${buf}\n${r}`.length > 2800) {
          blocks.push({ type: "section", text: { type: "mrkdwn", text: buf } });
          buf = r;
        } else {
          buf = `${buf}\n${r}`;
        }
      }
      blocks.push({ type: "section", text: { type: "mrkdwn", text: buf } });
    }
    // Primary CTA = an interactive Confirm button (no `url`, so Slack POSTs a
    // block_actions payload to the interactivity endpoint). The per-board
    // "Open <Board>" links are demoted to secondary url-buttons alongside it —
    // they remain as shareable always-on links to each board.
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: CONFIRM_ACTION_ID,
          style: "primary" as const,
          text: { type: "plain_text", text: "✅ Confirm & create tasks", emoji: true },
          value: botId,
        },
        ...boardsWithItems.map((b) => ({
          type: "button",
          text: { type: "plain_text", text: `Open ${BOARD_LABEL[b]}`, emoji: true },
          url: `${boardUrl()}?board=${b}`,
        })),
      ],
    });
  }

  blocks.push({
    type: "context",
    elements: [{
      type: "mrkdwn",
      text:
        parsed.items.length
          ? "Click *Confirm & create tasks* to create these on their boards — or reply to say what to change (move an item to another board, reassign, drop it, make it a subtask). Nothing is created until you confirm."
          : "Nothing to create. Reply if you'd like me to add a task anyway.",
    }],
  });

  return { text, blocks };
}
