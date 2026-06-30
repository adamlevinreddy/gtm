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
import { postToChannel, slackIdForEmail, salesChannel } from "@/lib/slack";
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

type AccountLink = { name: string; hubspotUrl: string | null; boardUrl: string };

/**
 * Resolve the distinct companies named on the triaged items to {HubSpot account
 * link, board-filtered link}. We want a HubSpot association even when there is
 * NO deal yet, so we link the COMPANY record: exact-name match first, then a
 * fuzzy CONTAINS fallback. Best-effort + bounded (≤6 companies) — a miss just
 * drops the HubSpot link for that company, never blocks the Slack post.
 */
async function resolveAccountLinks(companies: Array<string | null>): Promise<AccountLink[]> {
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

// ----------------------------------------------------------------------------
// proposeFromMeeting — triage → SUGGEST in Slack (no creation). Never throws.
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

    if (!opts?.force) {
      const claimed = await kv
        .set(claimKey, new Date().toISOString(), { nx: true, ex: IDEMPOTENCY_TTL })
        .catch(() => "errored");
      if (claimed === null) return { ok: true, proposed: 0, skipped: "already-processed" };
      if (claimed !== "errored") claimedHere = true;
    }

    const runnerEmail = process.env.POST_MEETING_AGENT_EMAIL || "adam@reddy.io";
    const answer = await runOneshot(buildTriagePrompt(botId), runnerEmail, `postmeeting:${botId}`);
    if (!answer) { await releaseClaim(); return { ok: false, proposed: 0, error: "triage agent unavailable or empty" }; }

    const parsed = parseTriage(answer);
    if (!parsed) { await releaseClaim(); return { ok: false, proposed: 0, error: "could not parse triage JSON" }; }

    const owners = Array.from(new Set(parsed.items.map((i) => i.ownerEmail).filter((e): e is string => !!e)));
    const slackIds: Record<string, string | null> = {};
    await Promise.all(owners.map(async (e) => { slackIds[e] = await slackIdForEmail(e); }));

    // Enrich the card with the same links the CRM card carries: a direct
    // recording/transcript link + a per-company HubSpot account link (even with
    // no deal) and board-filtered link. Best-effort — never blocks the post.
    const accounts = await resolveAccountLinks(parsed.items.map((i) => i.company)).catch(() => [] as AccountLink[]);
    const recUrl = `${selfBaseUrl()}/board/meeting/${botId}`;

    let slackTs: string | undefined;
    const channel = salesChannel();
    if (channel) {
      try {
        const res = await postToChannel(channel, buildSuggestionMessage(parsed, slackIds, botId, accounts, recUrl));
        slackTs = res.ts;
      } catch { /* ignore Slack failures */ }
    }
    // Stash the proposal under TWO keys: by message ts (the text-reply
    // "@Reddy-GTM confirm" path looks up via thread_ts) and by botId (the
    // Confirm button carries botId as its value).
    const stored = { botId, ...parsed };
    if (slackTs) {
      await kv.set(`postmeeting:proposal:${slackTs}`, stored, { ex: PROPOSAL_TTL }).catch(() => {});
    }
    await kv.set(proposalKeyForBot(botId), stored, { ex: PROPOSAL_TTL }).catch(() => {});

    const boards = Array.from(new Set(parsed.items.map((i) => i.boardKey)));
    return { ok: true, meetingType: parsed.meetingType, proposed: parsed.items.length, boards, ...(slackTs ? { slackTs } : {}) };
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

      // update → append to the existing card's activity ledger (no new card).
      if (it.disposition === "update" && it.targetId) {
        const target = await getItem(it.targetId);
        if (target) {
          const wrote = await logActivity(it.targetId, {
            kind: "logged_activity",
            actorKind: "human",
            actorEmail,
            body: it.note ?? it.title,
            dedupeKey: `pm:${botId}:upd:${it.targetId}:${it.title}`.slice(0, 180),
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
            sourceRef: botId,
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
        sourceRef: botId,
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

function buildSuggestionMessage(
  parsed: TriageResult,
  slackIds: Record<string, string | null>,
  botId: string,
  accounts: AccountLink[] = [],
  recUrl?: string
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
    { type: "header", text: { type: "plain_text", text: "📋  Post-meeting suggestions", emoji: true } },
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
      const rows = parsed.items.filter((i) => i.boardKey === b).map((i) => rowFor(i, slackIds)).join("\n");
      blocks.push({ type: "divider" });
      blocks.push({
        type: "section",
        text: { type: "mrkdwn", text: `${BOARD_EMOJI[b]} *${BOARD_LABEL[b]} board* · ${parsed.items.filter((i) => i.boardKey === b).length}\n${rows}` },
      });
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
