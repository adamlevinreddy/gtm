// ============================================================================
// POST-MEETING TRIAGE → BOARD ROUTING + SLACK CONFIRMATION
//
// When a Recall bot finishes a meeting, the lead's reconcile() fires
// /api/proactive/meeting (which calls proposeFromMeeting). We do NOT classify
// deterministically: we run Claude in the owner's per-user sandbox (oneshot),
// which reads the transcript + meta out of the cloned KB, applies Adam's board
// routing rules, and returns strict JSON describing the chosen board + the
// concrete action-item cards. The route then PERSISTS those cards into the
// chosen board's UNSORTED/triage column and posts a Slack confirmation so a
// human can re-route/reassign in the thread.
//
// proposeFromMeeting NEVER throws — it returns a result object (with `skipped`
// or an error baked in) so the calling route's after() can't crash the worker.
// ============================================================================

import { kv } from "@/lib/kv-client";
import { postToChannel } from "@/lib/slack";
import {
  createSuggestions,
  resolveBoardId,
  boardUrl,
  selfBaseUrl,
  type WorkItemKind,
} from "@/lib/work-items";

// The canonical WorkItemKind taxonomy. Kept in sync with the schema enum so we
// can defensively coerce a model-proposed kind back to a valid one.
const VALID_KINDS: readonly WorkItemKind[] = [
  "pricing_proposal",
  "deck_qbr",
  "meeting_prep",
  "prep_custom_demo",
  "rfp_response",
  "contract_redline",
  "followup_email",
  "book_meeting",
  "reengage_tickler",
  "recording_link",
  "scheduling",
  "account_research",
  "enablement_collateral",
  "crm_update",
  "log_to_hubspot",
  "propose_stage_move",
  "action_items",
  "generic",
];

const VALID_BOARDS = ["gtm", "success", "operations"] as const;
type BoardKey = (typeof VALID_BOARDS)[number];

export type TriageItem = {
  title: string;
  kind: WorkItemKind;
  ownerEmail: string | null;
  isFollowUp: boolean;
};

export type TriageResult = {
  boardKey: BoardKey;
  meetingType: "internal" | "prospect" | "signed_customer" | "pilot" | "partner";
  customerSlug: string | null;
  confidence: "high" | "medium" | "low";
  rationale: string;
  items: TriageItem[];
};

export type ProposeResult = {
  ok: boolean;
  boardKey?: BoardKey;
  meetingType?: TriageResult["meetingType"];
  created: number;
  slackTs?: string;
  skipped?: string;
  error?: string;
};

const IDEMPOTENCY_TTL_SECONDS = 14 * 24 * 3600; // 14 days

// ----------------------------------------------------------------------------
// 1. Prompt — tells the sandbox agent how to read the meeting + route it.
// ----------------------------------------------------------------------------

export function buildTriagePrompt(botId: string): string {
  return [
    `You are triaging a finished sales/CS/internal meeting for the Reddy GTM team's tracking board.`,
    ``,
    `MEETING BOT ID: ${botId}`,
    ``,
    `STEP 1 — READ THE MEETING. The KB is cloned in your sandbox. Glob for the meeting files`,
    `(the customer slug is unknown — '_unsorted' is a real slug, so use the wildcard):`,
    "  - transcript: `corpora/success/customers/*/meetings/" + botId + "/transcript.txt`",
    "  - metadata (title, attendees with emails, attribution): `corpora/success/customers/*/meetings/" + botId + "/meta.json`",
    `Read BOTH. Note the directory's customer slug (the path segment between customers/ and /meetings).`,
    ``,
    `STEP 2 — DECIDE THE BOARD using these rules (best-effort; a human confirms after):`,
    `  - INTERNAL-only (all/most attendees are @reddy.io, no external company) → "operations".`,
    `  - SIGNED CUSTOMER (a paying customer; a corpora/success/customers/<slug>/ exists for them,`,
    `    or the transcript clearly reflects an active signed relationship / onboarding / QBR / CS sync) → "success".`,
    `  - SIGNED PILOT (active paid/unpaid pilot) → "success" if it's onboarding/enablement/CS, "gtm" if it's still`,
    `    expansion/sell-through. State why in the rationale.`,
    `  - PROSPECT / UNSIGNED (discovery, eval, pricing, demo — not a customer, not piloting) → "gtm".`,
    `  - PARTNER (BPO/channel like Teleperformance) → "gtm" if it's a sell-with/through motion,`,
    `    "operations" if it's internal partner-ops. State why.`,
    `  Use the KB (which customers are signed), the transcript content, and attendee email domains.`,
    `  When uncertain, pick your best guess and set confidence "low"/"medium" and flag it in the rationale.`,
    ``,
    `STEP 3 — EXTRACT THE ACTION ITEMS as board cards. Capture the real commitments / next-steps /`,
    `owed deliverables only (typically 1–6; an empty array is valid for a pure status meeting). For each:`,
    `  - title: a short imperative card title (e.g. "Send pricing proposal to Acme").`,
    `  - kind: one of ${VALID_KINDS.join(", ")}.`,
    `  - ownerEmail: the @reddy.io attendee who clearly owns it (match the meta.json attendee emails), else null.`,
    `  - isFollowUp: true if it's a follow-up on existing in-flight work, else false.`,
    ``,
    `STEP 4 — RETURN STRICT JSON in a SINGLE fenced \`\`\`json block and nothing else after it.`,
    `Schema (exact keys):`,
    "```json",
    `{`,
    `  "boardKey": "gtm" | "success" | "operations",`,
    `  "meetingType": "internal" | "prospect" | "signed_customer" | "pilot" | "partner",`,
    `  "customerSlug": string | null,`,
    `  "confidence": "high" | "medium" | "low",`,
    `  "rationale": "one sentence",`,
    `  "items": [`,
    `    { "title": string, "kind": "<one of the kinds above>", "ownerEmail": string | null, "isFollowUp": boolean }`,
    `  ]`,
    `}`,
    "```",
    `Do NOT write anything to the board or to disk. Read-only analysis — your JSON is the entire deliverable.`,
  ].join("\n");
}

// ----------------------------------------------------------------------------
// 2. Parse — tolerantly pull the first JSON object out of the agent's answer.
// ----------------------------------------------------------------------------

export function parseTriage(answer: string | null | undefined): TriageResult | null {
  if (!answer || typeof answer !== "string") return null;

  // Prefer a fenced ```json block; fall back to any fenced block; finally to
  // the first balanced {...} run in the raw text.
  const candidates: string[] = [];
  const fenced = answer.match(/```(?:json)?\s*([\s\S]*?)```/gi);
  if (fenced) {
    for (const block of fenced) {
      const inner = block.replace(/```(?:json)?\s*/i, "").replace(/```$/, "");
      candidates.push(inner.trim());
    }
  }
  const firstBrace = answer.indexOf("{");
  const lastBrace = answer.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(answer.slice(firstBrace, lastBrace + 1));
  }

  for (const c of candidates) {
    const parsed = tryParseTriage(c);
    if (parsed) return parsed;
  }
  return null;
}

function tryParseTriage(raw: string): TriageResult | null {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;

  const boardKey = coerceBoardKey(o.boardKey);
  if (!boardKey) return null;

  const meetingType = coerceMeetingType(o.meetingType);
  const confidence = coerceConfidence(o.confidence);
  const customerSlug =
    typeof o.customerSlug === "string" && o.customerSlug.trim() ? o.customerSlug.trim() : null;
  const rationale = typeof o.rationale === "string" ? o.rationale.trim() : "";

  const rawItems = Array.isArray(o.items) ? o.items : [];
  const items: TriageItem[] = [];
  for (const it of rawItems) {
    if (!it || typeof it !== "object") continue;
    const i = it as Record<string, unknown>;
    const title = typeof i.title === "string" ? i.title.trim() : "";
    if (!title) continue;
    items.push({
      title,
      kind: coerceKind(i.kind),
      ownerEmail:
        typeof i.ownerEmail === "string" && i.ownerEmail.includes("@")
          ? i.ownerEmail.trim().toLowerCase()
          : null,
      isFollowUp: i.isFollowUp === true,
    });
  }

  return { boardKey, meetingType, customerSlug, confidence, rationale, items };
}

function coerceBoardKey(v: unknown): BoardKey | null {
  if (typeof v !== "string") return null;
  const k = v.toLowerCase().trim();
  return (VALID_BOARDS as readonly string[]).includes(k) ? (k as BoardKey) : null;
}

function coerceMeetingType(v: unknown): TriageResult["meetingType"] {
  const valid = ["internal", "prospect", "signed_customer", "pilot", "partner"];
  return typeof v === "string" && valid.includes(v)
    ? (v as TriageResult["meetingType"])
    : "prospect";
}

function coerceConfidence(v: unknown): TriageResult["confidence"] {
  return v === "high" || v === "medium" || v === "low" ? v : "low";
}

function coerceKind(v: unknown): WorkItemKind {
  if (typeof v === "string" && (VALID_KINDS as readonly string[]).includes(v)) {
    return v as WorkItemKind;
  }
  return "action_items";
}

// ----------------------------------------------------------------------------
// Oneshot call — run Claude in the runner's sandbox, return the answer text.
// ----------------------------------------------------------------------------

async function runOneshot(
  question: string,
  userEmail: string,
  oneshotRequestId: string
): Promise<string | null> {
  const secret = process.env.MCP_INTERNAL_SECRET;
  if (!secret) return null;
  try {
    const res = await fetch(`${selfBaseUrl()}/api/agent/oneshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-reddy-internal": secret },
      body: JSON.stringify({ question, userEmail, oneshotRequestId }),
    });
    const json = (await res.json()) as { ok?: boolean; answer?: string };
    if (json?.ok && typeof json.answer === "string" && json.answer.trim()) {
      return json.answer;
    }
  } catch {
    // swallow — caller treats null as "triage unavailable"
  }
  return null;
}

// ----------------------------------------------------------------------------
// 3. proposeFromMeeting — orchestrate triage → persist → Slack. Never throws.
// ----------------------------------------------------------------------------

export async function proposeFromMeeting(
  botId: string,
  opts?: { force?: boolean }
): Promise<ProposeResult> {
  try {
    if (!botId) return { ok: false, created: 0, error: "missing botId" };

    // Idempotency: first writer wins (nx). Re-running the same botId is a no-op
    // unless force=true (the replay route). KV claim doubles as a lock.
    if (!opts?.force) {
      const claimed = await kv
        .set(`proactive:meeting:${botId}`, new Date().toISOString(), {
          nx: true,
          ex: IDEMPOTENCY_TTL_SECONDS,
        })
        .catch(() => "errored"); // on KV error, don't block the triage
      if (claimed === null) {
        return { ok: true, created: 0, skipped: "already-processed" };
      }
    }

    const runnerEmail = process.env.POST_MEETING_AGENT_EMAIL || "adam@reddy.io";

    const answer = await runOneshot(
      buildTriagePrompt(botId),
      runnerEmail,
      `postmeeting:${botId}`
    );
    if (!answer) {
      return { ok: false, created: 0, error: "triage agent unavailable or empty" };
    }

    const parsed = parseTriage(answer);
    if (!parsed) {
      return { ok: false, created: 0, error: "could not parse triage JSON" };
    }

    const boardId = await resolveBoardId(parsed.boardKey);
    if (!boardId) {
      return {
        ok: false,
        boardKey: parsed.boardKey,
        meetingType: parsed.meetingType,
        created: 0,
        error: `unknown board "${parsed.boardKey}"`,
      };
    }

    let created: Awaited<ReturnType<typeof createSuggestions>> = [];
    if (parsed.items.length > 0) {
      created = await createSuggestions(
        parsed.items.map((i) => ({
          kind: i.kind,
          title: i.title,
          ...(i.ownerEmail ? { ownerEmail: i.ownerEmail } : {}),
        })),
        {
          source: "post_meeting",
          boardId,
          status: "triage",
          sourceRef: botId,
          ...(parsed.customerSlug ? { customerSlug: parsed.customerSlug } : {}),
          createdBy: "bot",
        }
      );
    }

    // Slack confirmation — best-effort. A failed post must not fail the triage.
    let slackTs: string | undefined;
    try {
      const channel = process.env.SALES_TESTING_CHANNEL_ID;
      if (channel) {
        const res = await postToChannel(channel, buildSlackMessage(parsed, created));
        slackTs = res.ts;
      }
    } catch {
      // ignore Slack failures
    }

    return {
      ok: true,
      boardKey: parsed.boardKey,
      meetingType: parsed.meetingType,
      created: created.length,
      ...(slackTs ? { slackTs } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      created: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ----------------------------------------------------------------------------
// Slack message builder.
// ----------------------------------------------------------------------------

const BOARD_LABEL: Record<BoardKey, string> = {
  gtm: "GTM",
  success: "Success",
  operations: "Operations",
};

function buildSlackMessage(
  parsed: TriageResult,
  created: Array<{ id: string; title: string; kind: string; ownerEmail?: string | null }>
): { text: string; blocks: object[] } {
  const link = boardUrl();
  const boardLabel = BOARD_LABEL[parsed.boardKey];
  const customerBit = parsed.customerSlug ? ` · ${parsed.customerSlug}` : "";

  const cardLines = created.length
    ? created
        .map((c) => {
          const owner = c.ownerEmail ? c.ownerEmail.split("@")[0] : "unassigned";
          return `• ${c.title} · _${c.kind}_ · ${owner}`;
        })
        .join("\n")
    : "_No action items extracted — pure status meeting._";

  const headline =
    created.length > 0
      ? `Post-meeting triage → *${boardLabel}* board (${created.length} card${
          created.length === 1 ? "" : "s"
        })`
      : `Post-meeting triage → *${boardLabel}* board (no action items)`;

  const text = `${headline}${customerBit}. ${parsed.rationale}`;

  const blocks: object[] = [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text:
          `${headline}${customerBit}\n` +
          `*Meeting type:* ${parsed.meetingType}  ·  *Confidence:* ${parsed.confidence}\n` +
          `*Why:* ${parsed.rationale || "(no rationale provided)"}`,
      },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: cardLines },
    },
    {
      type: "context",
      elements: [
        { type: "mrkdwn", text: `<${link}|Open the ${boardLabel} board> · cards landed in *Unsorted* for review` },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text:
            "Reply in this thread to re-route or reassign — e.g. " +
            "“@Reddy-GTM move the pricing card to Success and assign Charles.”",
        },
      ],
    },
  ];

  return { text, blocks };
}
