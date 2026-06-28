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
import { postToChannel, slackIdForEmail } from "@/lib/slack";
import { boardUrl, selfBaseUrl, type WorkItemKind } from "@/lib/work-items";

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
  targetId: string | null;
  targetTitle: string | null;
  note: string | null;
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
    `STEP 3 — ROUTE EACH ITEM TO ITS OWN BOARD. Items from ONE meeting can span boards — route by what EACH item is about, not by the meeting overall:`,
    `  - "gtm": the item is about a PROSPECT / unsigned lead / pilot whose contract isn't signed (discovery, demo, pricing, outreach, follow-up with a not-yet-customer).`,
    `  - "success": the item is about a SIGNED CUSTOMER (a corpora/success/customers/<slug>/ exists, or it's onboarding / QBR / CS / expansion for a paying customer).`,
    `  - "operations": the item is PURELY INTERNAL (CRM cleanup, internal scheduling, process, enablement that isn't tied to one external account).`,
    `  Example: in an internal lead-triage meeting, "follow up with prospect X" → gtm, "re-upload the lead list to HubSpot" → operations, "QBR prep for <signed customer>" → success.`,
    ``,
    `STEP 4 — CHECK EXISTING CARDS before deciding disposition. For each board you're routing items to, call board_list({ boardKey, customerSlug? }) to see existing open cards (id, title, kind, status, ownerEmail). Then set each item's disposition:`,
    `  - "update": same work as an existing card → set targetId = that card id, targetTitle = its title, note = the update to log (no new card).`,
    `  - "subtask": a sub-step of an existing in-flight card → set targetId = parent card id, targetTitle = its title.`,
    `  - "new": otherwise.`,
    ``,
    `STEP 5 — RETURN STRICT JSON in a SINGLE fenced \`\`\`json block, nothing after it:`,
    "```json",
    `{`,
    `  "meetingType": "internal" | "prospect" | "signed_customer" | "pilot" | "partner",`,
    `  "meetingTitle": string,`,
    `  "items": [`,
    `    { "boardKey": "gtm"|"success"|"operations", "disposition": "new"|"subtask"|"update", "title": string, "kind": "<one of: ${VALID_KINDS.join(", ")}>", "ownerEmail": string|null, "targetId": string|null, "targetTitle": string|null, "note": string|null }`,
    `  ]`,
    `}`,
    "```",
    `title = short imperative; ownerEmail = the @reddy.io attendee who clearly owns it (from meta.json), else null. You MAY call board_list (read-only). Do NOT create/update/move any card — the JSON is your entire job.`,
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
  const f = answer.indexOf("{"), l = answer.lastIndexOf("}");
  if (f !== -1 && l > f) candidates.push(answer.slice(f, l + 1));
  for (const c of candidates) {
    const p = tryParse(c);
    if (p) return p;
  }
  return null;
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
      body: JSON.stringify({ question, userEmail, oneshotRequestId: reqId }),
    });
    const json = (await res.json()) as { ok?: boolean; answer?: string };
    if (json?.ok && typeof json.answer === "string" && json.answer.trim()) return json.answer;
  } catch { /* swallow */ }
  return null;
}

// ----------------------------------------------------------------------------
// proposeFromMeeting — triage → SUGGEST in Slack (no creation). Never throws.
// ----------------------------------------------------------------------------

export async function proposeFromMeeting(botId: string, opts?: { force?: boolean }): Promise<ProposeResult> {
  try {
    if (!botId) return { ok: false, proposed: 0, error: "missing botId" };

    if (!opts?.force) {
      const claimed = await kv
        .set(`proactive:meeting:${botId}`, new Date().toISOString(), { nx: true, ex: IDEMPOTENCY_TTL })
        .catch(() => "errored");
      if (claimed === null) return { ok: true, proposed: 0, skipped: "already-processed" };
    }

    const runnerEmail = process.env.POST_MEETING_AGENT_EMAIL || "adam@reddy.io";
    const answer = await runOneshot(buildTriagePrompt(botId), runnerEmail, `postmeeting:${botId}`);
    if (!answer) return { ok: false, proposed: 0, error: "triage agent unavailable or empty" };

    const parsed = parseTriage(answer);
    if (!parsed) return { ok: false, proposed: 0, error: "could not parse triage JSON" };

    const owners = Array.from(new Set(parsed.items.map((i) => i.ownerEmail).filter((e): e is string => !!e)));
    const slackIds: Record<string, string | null> = {};
    await Promise.all(owners.map(async (e) => { slackIds[e] = await slackIdForEmail(e); }));

    let slackTs: string | undefined;
    const channel = process.env.SALES_TESTING_CHANNEL_ID;
    if (channel) {
      try {
        const res = await postToChannel(channel, buildSuggestionMessage(parsed, slackIds));
        slackTs = res.ts;
      } catch { /* ignore Slack failures */ }
    }
    if (slackTs) {
      await kv.set(`postmeeting:proposal:${slackTs}`, { botId, ...parsed }, { ex: PROPOSAL_TTL }).catch(() => {});
    }

    const boards = Array.from(new Set(parsed.items.map((i) => i.boardKey)));
    return { ok: true, meetingType: parsed.meetingType, proposed: parsed.items.length, boards, ...(slackTs ? { slackTs } : {}) };
  } catch (err) {
    return { ok: false, proposed: 0, error: err instanceof Error ? err.message : String(err) };
  }
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

function buildSuggestionMessage(
  parsed: TriageResult,
  slackIds: Record<string, string | null>
): { text: string; blocks: object[] } {
  const title = parsed.meetingTitle ?? "the meeting";
  const boardsWithItems = (VALID_BOARDS as readonly BoardKey[]).filter((b) =>
    parsed.items.some((i) => i.boardKey === b)
  );

  const text = `Post-meeting suggestions from ${title} — ${parsed.items.length} task${
    parsed.items.length === 1 ? "" : "s"
  } across ${boardsWithItems.map((b) => BOARD_LABEL[b]).join(", ") || "—"} (nothing created yet).`;

  const blocks: object[] = [
    { type: "header", text: { type: "plain_text", text: "📋  Post-meeting suggestions", emoji: true } },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text: `From *${title}* · ${parsed.items.length} task${parsed.items.length === 1 ? "" : "s"} · nothing created until you confirm`,
      }],
    },
  ];

  if (parsed.items.length === 0) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "_No action items found — looks like a pure status meeting._" } });
  } else {
    for (const b of boardsWithItems) {
      const rows = parsed.items.filter((i) => i.boardKey === b).map((i) => rowFor(i, slackIds)).join("\n");
      blocks.push({ type: "divider" });
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `${BOARD_EMOJI[b]} *${BOARD_LABEL[b]} board* · ${parsed.items.filter((i) => i.boardKey === b).length}\n${rows}` },
      });
    }
    blocks.push({
      type: "actions",
      elements: boardsWithItems.map((b) => ({
        type: "button",
        text: { type: "plain_text", text: `Open ${BOARD_LABEL[b]}`, emoji: true },
        url: `${boardUrl()}?board=${b}`,
        ...(b === boardsWithItems[0] ? { style: "primary" as const } : {}),
      })),
    });
  }

  blocks.push({
    type: "context",
    elements: [{
      type: "mrkdwn",
      text:
        parsed.items.length
          ? "Reply *“@Reddy-GTM confirm”* to create these on their boards — or say what to change (move an item to another board, reassign, drop it, make it a subtask). Nothing is created until you confirm."
          : "Nothing to create. Reply if you'd like me to add a task anyway.",
    }],
  });

  return { text, blocks };
}
