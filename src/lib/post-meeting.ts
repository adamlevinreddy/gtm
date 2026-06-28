// ============================================================================
// POST-MEETING TRIAGE → SUGGEST (confirm-first) → create on confirmation
//
// When a meeting finishes, reconcile() fires /api/proactive/meeting →
// proposeFromMeeting. Claude runs in the runner's sandbox (oneshot): it reads
// the transcript + meta from the cloned KB, picks the board, and — crucially —
// uses the board_list tool to check EXISTING open cards so each action item is
// classified as NEW / SUBTASK-of-existing / UPDATE-existing. It returns strict
// JSON. We DO NOT create anything: we post a Slack SUGGESTION (owners @-mentioned)
// and stash the structured proposal in KV keyed by the message ts. A human then
// replies "@Reddy-GTM confirm" in the thread; slack/events injects the stashed
// proposal and the agent executes it with the board tools (applying corrections).
//
// proposeFromMeeting NEVER throws.
// ============================================================================

import { kv } from "@/lib/kv-client";
import { postToChannel, slackIdForEmail } from "@/lib/slack";
import {
  resolveBoardId,
  boardUrl,
  selfBaseUrl,
  listWorkItems,
  type WorkItemKind,
} from "@/lib/work-items";

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
  disposition: Disposition;
  title: string;
  kind: WorkItemKind;
  ownerEmail: string | null;
  targetId: string | null;     // existing card id for subtask(parent) / update(target)
  targetTitle: string | null;  // for display
  note: string | null;         // the activity body for an 'update'
};

export type TriageResult = {
  boardKey: BoardKey;
  meetingType: "internal" | "prospect" | "signed_customer" | "pilot" | "partner";
  customerSlug: string | null;
  confidence: "high" | "medium" | "low";
  rationale: string;
  meetingTitle: string | null;
  items: TriageItem[];
};

export type ProposeResult = {
  ok: boolean;
  boardKey?: BoardKey;
  meetingType?: TriageResult["meetingType"];
  proposed: number;
  slackTs?: string;
  skipped?: string;
  error?: string;
};

const IDEMPOTENCY_TTL = 14 * 24 * 3600;
const PROPOSAL_TTL = 7 * 24 * 3600;

// ----------------------------------------------------------------------------
// Prompt — read the meeting, pick the board, RECONCILE vs existing cards.
// ----------------------------------------------------------------------------

export function buildTriagePrompt(botId: string): string {
  return [
    `You are triaging a finished meeting into the Reddy GTM tracking board. You PROPOSE only — a human confirms in Slack before anything is created. Be precise; do not invent commitments.`,
    ``,
    `MEETING BOT ID: ${botId}`,
    ``,
    `STEP 1 — READ THE MEETING (the KB is cloned in your sandbox; '_unsorted' is a real slug, so glob):`,
    "  - transcript: `corpora/success/customers/*/meetings/" + botId + "/transcript.txt`",
    "  - metadata (title, attendees+emails, attribution): `corpora/success/customers/*/meetings/" + botId + "/meta.json`",
    `Read BOTH. Capture the meeting title.`,
    ``,
    `STEP 2 — PICK THE BOARD (best-effort; a human confirms after):`,
    `  - INTERNAL-only (all/most attendees @reddy.io, no external company) → "operations".`,
    `  - SIGNED CUSTOMER (paying; a corpora/success/customers/<slug>/ exists, or the transcript shows an active signed relationship / onboarding / QBR / CS sync) → "success".`,
    `  - SIGNED PILOT (active pilot WITH a signed contract) → "success" if onboarding/enablement/CS, else "gtm". If the contract is NOT yet signed (still in procurement/negotiation), it is NOT signed → "gtm". State this in the rationale.`,
    `  - PROSPECT / UNSIGNED (discovery, eval, pricing, demo) → "gtm".`,
    `  - PARTNER (BPO/channel) → "gtm" for sell-with/through, "operations" for internal partner-ops.`,
    `  Set confidence and explain the board choice in one sentence.`,
    ``,
    `STEP 3 — CHECK EXISTING CARDS. Call the board_list tool for the chosen board, e.g. board_list({ boardKey: "<board>", customerSlug: "<slug if known>" }). Study the returned open cards (each has id, title, kind, status, ownerEmail). You will reconcile every action item against them.`,
    ``,
    `STEP 4 — EXTRACT ACTION ITEMS and choose a DISPOSITION for each (only real commitments / next-steps / owed deliverables; 0 is valid for a pure status meeting):`,
    `  - "update": this is the SAME work as an existing open card → don't create anything; we'll log an activity/note on it. Set targetId = that card's id, targetTitle = its title, and note = the concrete update to record.`,
    `  - "subtask": this is a sub-step of an existing in-flight card → set targetId = the parent card's id and targetTitle = its title (we'll create it under that parent).`,
    `  - "new": none of the above → a fresh top-level card.`,
    `  For each: title (short imperative), kind (one of ${VALID_KINDS.join(", ")}), ownerEmail (the @reddy.io attendee who clearly owns it from meta.json, else null).`,
    ``,
    `STEP 5 — RETURN STRICT JSON in a SINGLE fenced \`\`\`json block, nothing after it:`,
    "```json",
    `{`,
    `  "boardKey": "gtm" | "success" | "operations",`,
    `  "meetingType": "internal" | "prospect" | "signed_customer" | "pilot" | "partner",`,
    `  "customerSlug": string | null,`,
    `  "confidence": "high" | "medium" | "low",`,
    `  "rationale": "one sentence on the board choice",`,
    `  "meetingTitle": string,`,
    `  "items": [`,
    `    { "disposition": "new"|"subtask"|"update", "title": string, "kind": "<kind>", "ownerEmail": string|null, "targetId": string|null, "targetTitle": string|null, "note": string|null }`,
    `  ]`,
    `}`,
    "```",
    `You MAY call board_list (read-only). Do NOT create, update, or move any card — proposing the JSON is your entire job.`,
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
  const boardKey = coerceBoard(o.boardKey);
  if (!boardKey) return null;
  const items: TriageItem[] = [];
  for (const it of Array.isArray(o.items) ? o.items : []) {
    if (!it || typeof it !== "object") continue;
    const i = it as Record<string, unknown>;
    const title = typeof i.title === "string" ? i.title.trim() : "";
    if (!title) continue;
    const disposition: Disposition =
      i.disposition === "subtask" || i.disposition === "update" ? i.disposition : "new";
    const targetId = typeof i.targetId === "string" && i.targetId.trim() ? i.targetId.trim() : null;
    items.push({
      disposition: disposition !== "new" && !targetId ? "new" : disposition, // a subtask/update with no target is just new
      title,
      kind: coerceKind(i.kind),
      ownerEmail: typeof i.ownerEmail === "string" && i.ownerEmail.includes("@") ? i.ownerEmail.trim().toLowerCase() : null,
      targetId,
      targetTitle: typeof i.targetTitle === "string" && i.targetTitle.trim() ? i.targetTitle.trim() : null,
      note: typeof i.note === "string" && i.note.trim() ? i.note.trim() : null,
    });
  }
  return {
    boardKey,
    meetingType: coerceType(o.meetingType),
    customerSlug: typeof o.customerSlug === "string" && o.customerSlug.trim() ? o.customerSlug.trim() : null,
    confidence: o.confidence === "high" || o.confidence === "medium" || o.confidence === "low" ? o.confidence : "low",
    rationale: typeof o.rationale === "string" ? o.rationale.trim() : "",
    meetingTitle: typeof o.meetingTitle === "string" && o.meetingTitle.trim() ? o.meetingTitle.trim() : null,
    items,
  };
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

    // resolve owner emails → slack ids for @-mentions (best-effort)
    const owners = Array.from(new Set(parsed.items.map((i) => i.ownerEmail).filter((e): e is string => !!e)));
    const slackIds: Record<string, string | null> = {};
    await Promise.all(owners.map(async (e) => { slackIds[e] = await slackIdForEmail(e); }));

    // post the SUGGESTION (nothing created yet)
    let slackTs: string | undefined;
    const channel = process.env.SALES_TESTING_CHANNEL_ID;
    if (channel) {
      try {
        const res = await postToChannel(channel, buildSuggestionMessage(parsed, slackIds));
        slackTs = res.ts;
      } catch { /* ignore Slack failures */ }
    }

    // stash the structured proposal so the confirm reply (slack/events) can execute it
    if (slackTs) {
      await kv
        .set(`postmeeting:proposal:${slackTs}`, { botId, ...parsed }, { ex: PROPOSAL_TTL })
        .catch(() => {});
    }

    return { ok: true, boardKey: parsed.boardKey, meetingType: parsed.meetingType, proposed: parsed.items.length, ...(slackTs ? { slackTs } : {}) };
  } catch (err) {
    return { ok: false, proposed: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// ----------------------------------------------------------------------------
// Slack suggestion message
// ----------------------------------------------------------------------------

const BOARD_LABEL: Record<BoardKey, string> = { gtm: "GTM", success: "Success", operations: "Operations" };

function ownerTag(email: string | null, slackIds: Record<string, string | null>): string {
  if (!email) return "_unassigned_";
  const id = slackIds[email];
  return id ? `<@${id}>` : email.split("@")[0];
}

function buildSuggestionMessage(
  parsed: TriageResult,
  slackIds: Record<string, string | null>
): { text: string; blocks: object[] } {
  const boardLabel = BOARD_LABEL[parsed.boardKey];
  const link = `${boardUrl()}?board=${parsed.boardKey}`;
  const title = parsed.meetingTitle ? `*${parsed.meetingTitle}*` : "the meeting";
  const customerBit = parsed.customerSlug ? ` · ${parsed.customerSlug}` : "";

  const lines = parsed.items.length
    ? parsed.items.map((it, n) => {
        const owner = ownerTag(it.ownerEmail, slackIds);
        if (it.disposition === "update")
          return `${n + 1}. ✎ *Update* "${it.targetTitle ?? "existing card"}" — log: ${it.note ?? it.title} · ${owner}`;
        if (it.disposition === "subtask")
          return `${n + 1}. ↳ *Subtask* under "${it.targetTitle ?? "existing card"}" · ${it.title} · _${it.kind}_ · ${owner}`;
        return `${n + 1}. 🆕 *New* · ${it.title} · _${it.kind}_ · ${owner}`;
      }).join("\n")
    : "_No action items found — looks like a pure status meeting._";

  const headline = `:clipboard: Suggestions from ${title} → *${boardLabel}* board${customerBit}`;
  const text = `${headline} — ${parsed.items.length} proposed (nothing created yet). ${parsed.rationale}`;

  const blocks: object[] = [
    { type: "section", text: { type: "mrkdwn", text: `${headline}\n*Meeting type:* ${parsed.meetingType}  ·  *Confidence:* ${parsed.confidence}\n*Why this board:* ${parsed.rationale || "(none)"}` } },
    { type: "section", text: { type: "mrkdwn", text: `*Proposed — nothing created yet:*\n${lines}` } },
    { type: "context", elements: [{ type: "mrkdwn", text: `<${link}|Preview the ${boardLabel} board>` }] },
    {
      type: "context",
      elements: [{
        type: "mrkdwn",
        text:
          parsed.items.length
            ? "Reply *“@Reddy-GTM confirm”* to create these, or tell me what to change (board, owner, drop an item, make it a subtask). Nothing is created until you confirm."
            : "Nothing to create. Reply if you'd like me to add a task anyway.",
      }],
    },
  ];
  return { text, blocks };
}
