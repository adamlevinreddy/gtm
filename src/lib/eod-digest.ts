import { kv } from "@/lib/kv-client";
import { postToChannel, salesChannel, slackIdForEmail } from "@/lib/slack";
import { recentMeetingIndex } from "@/lib/recall-index";
import { ptDate, companySlug } from "@/lib/work-items";
import { isConeOfSilence } from "@/lib/cone-of-silence";
import { runAgentAnswer } from "@/lib/proactive-run";
import {
  parseTriage,
  buildSuggestionMessage,
  proposalKeyForBot,
  resolveAccountLinks,
  type StoredProposal,
  type AccountLink,
} from "@/lib/post-meeting";

// End-of-day task digest (Arc VII). Task extraction moved OFF the per-meeting
// path (that moment is now the generative Play card) to ONE confirm-first digest
// at day's end. It reuses the preserved triage toolkit — one agent pass reads
// today's meetings and returns the SAME TriageResult JSON parseTriage expects,
// then buildSuggestionMessage posts the SAME "Confirm & create tasks" card whose
// button the interactivity route already handles. The card's confirm value is a
// digest id (used only as a proposal key), so executeProposal works unchanged.
//
// Two things make it "de-duped + not silly" (the whole reason for the move):
// the prompt has the agent board_list every target board and drop existing work,
// and skip meeting-booking tasks (a next meeting set live on the call is already
// handled).

const PROPOSAL_TTL = 7 * 24 * 3600;
const MAX_MEETINGS = 20;

type DigestMeeting = { botId: string; title: string; customer: string };

export function buildEodDigestPrompt(meetings: DigestMeeting[]): string {
  const list = meetings
    .map((m) => `  - bot_id ${m.botId} — ${m.title}${m.customer ? ` (${m.customer})` : ""}`)
    .join("\n");
  return [
    `You are building the Reddy GTM team's END-OF-DAY task digest. Several meetings happened today; extract the concrete follow-up tasks worth tracking, across ALL of them, into ONE combined list. You PROPOSE only — a human clicks Confirm in Slack before anything is created. Be precise; do not invent commitments.`,
    ``,
    `TODAY'S MEETINGS (read each transcript by bot_id):`,
    list,
    ``,
    `KB is cloned in your sandbox; '_unsorted' is a real slug, so glob:`,
    "  - transcript: `corpora/success/customers/*/meetings/<bot_id>/transcript.txt`",
    "  - metadata (title, attendees+emails): `corpora/success/customers/*/meetings/<bot_id>/meta.json`",
    ``,
    `RULES:`,
    `  - SKIP internal meetings entirely (every attendee is @reddy.io — standups, pipeline reviews). No tasks from those.`,
    `  - Extract ONLY real external commitments / owed deliverables / clear next steps — not everything discussed.`,
    `  - DO NOT propose "schedule a meeting" / "book a follow-up" when a next meeting was ALREADY set on the call — that's handled. Skip calendar-booking tasks in general.`,
    `  - DE-DUP against what's already tracked: for each board you'd add to, call board_list({ boardKey, customerSlug? }) and DROP anything already an open card — or set disposition "update"/"subtask" against it (targetId = that card id). Never recreate work that exists.`,
    `  - Disambiguate ambiguous names via HubSpot (read-only, ≤4 lookups total): two adjacent names may be one-person-at-a-company OR two separate people (e.g. "Stanley, call Regina") — resolve, and never invent a "<First> <Word>" person.`,
    `  - Route EACH item to its board by what the item is about: "gtm" = anything sales/marketing incl. sales-ops (default); "success" = signed-customer CS/onboarding/QBR/expansion (usually Adam or Oliver); "operations" = back-office only (accounting/finance/legal/board/compliance/Christina Valla).`,
    ``,
    `RETURN STRICT JSON in a SINGLE fenced \`\`\`json block, nothing after it:`,
    "```json",
    `{`,
    `  "meetingType": "prospect",`,
    `  "meetingTitle": "Today's meetings",`,
    `  "items": [`,
    `    { "boardKey": "gtm"|"success"|"operations", "disposition": "new"|"subtask"|"update", "title": string, "kind": "<one of: pricing_proposal, deck_qbr, meeting_prep, prep_custom_demo, rfp_response, contract_redline, followup_email, book_meeting, reengage_tickler, recording_link, scheduling, account_research, enablement_collateral, crm_update, log_to_hubspot, propose_stage_move, action_items, generic>", "ownerEmail": string|null, "company": string|null, "targetId": string|null, "targetTitle": string|null, "note": string|null }`,
    `  ]`,
    `}`,
    "```",
    `title = short imperative; ownerEmail = the @reddy.io attendee who clearly owns it, else null; company = the external customer/prospect this item is about (null for internal-only). If there are genuinely no external follow-ups across all of today's meetings, return items: []. Your FINAL message must be ONLY the fenced json block — no prose before or after it.`,
  ].join("\n");
}

export type EodDigestResult = {
  ok: boolean;
  meetings: number;
  proposed: number;
  skipped?: string;
  slackTs?: string;
  error?: string;
};

export async function runEodDigest(opts: { digestId: string }): Promise<EodDigestResult> {
  try {
    const pat = process.env.PRICING_LIBRARY_GITHUB_PAT ?? "";
    const today = ptDate(new Date());
    // Today's transcribed meetings (recentMeetingIndex looks back from PT
    // midnight; keep only those whose PT day is today).
    const all = await recentMeetingIndex(pat, 1, 100).catch(() => []);
    const todays = all.filter(
      (m) => m.bot_id && m.has_transcript && m.started_at && ptDate(new Date(m.started_at)) === today,
    );
    if (todays.length === 0) return { ok: true, meetings: 0, proposed: 0, skipped: "no-meetings" };

    // Drop confidential (cone-of-silence) meetings before the agent ever sees them.
    const eligible: typeof todays = [];
    for (const m of todays.slice(0, MAX_MEETINGS)) {
      if (await isConeOfSilence(m.bot_id).catch(() => false)) continue;
      eligible.push(m);
    }
    if (eligible.length === 0) return { ok: true, meetings: 0, proposed: 0, skipped: "all-confidential" };

    const meetings: DigestMeeting[] = eligible.map((m) => ({
      botId: m.bot_id,
      title: m.title ?? "(untitled)",
      customer: m.account_canonical || m.customer_slug || "",
    }));

    const answer = await runAgentAnswer(buildEodDigestPrompt(meetings), {
      requestId: opts.digestId,
      // Under the cron's 800s, leaving room for the oneshot's own cold-start
      // (before polling) AND the post-processing below (owner Slack-id lookups,
      // HubSpot account links, the Slack post).
      pollTimeoutMs: 600_000,
    });
    if (!answer) return { ok: false, meetings: meetings.length, proposed: 0, error: "digest agent unavailable or empty" };

    const parsed = parseTriage(answer);
    if (!parsed || parsed.items.length === 0) {
      return { ok: true, meetings: meetings.length, proposed: 0, skipped: "no-items" };
    }
    parsed.meetingTitle = parsed.meetingTitle || `Today's meetings — ${today}`;

    // Per-company sourceRef so the (sourceRef, kind, title) unique index doesn't
    // silently collapse the same short title (e.g. "Send pricing") across two
    // different companies in one digest. Per-meeting triage leaves this unset.
    parsed.items.forEach((it, i) => {
      it.sourceRef = `${opts.digestId}:${companySlug(it.company) || `i${i}`}`;
    });

    // Store under the digest id so the existing Confirm button (value = the id,
    // used only as a proposal key) resolves + executes it unchanged.
    const stored: StoredProposal = { botId: opts.digestId, ...parsed };
    await kv.set(proposalKeyForBot(opts.digestId), stored, { ex: PROPOSAL_TTL }).catch(() => {});

    // Owner @-mentions + per-company HubSpot/board links (same as per-meeting).
    const owners = Array.from(new Set(parsed.items.map((i) => i.ownerEmail).filter((e): e is string => !!e)));
    const slackIds: Record<string, string | null> = {};
    for (const e of owners) slackIds[e] = await slackIdForEmail(e).catch(() => null);
    const accounts: AccountLink[] = await resolveAccountLinks(parsed.items.map((i) => i.company)).catch(() => []);

    const channel = salesChannel();
    let slackTs: string | undefined;
    if (channel) {
      try {
        // headerText reframes the card's header block for the digest; the text
        // is the Slack notification/fallback line.
        const msg = buildSuggestionMessage(parsed, slackIds, opts.digestId, accounts, undefined, "🌇  End-of-day task digest");
        const res = await postToChannel(channel, {
          text: `🌇 End-of-day task digest — ${parsed.items.length} suggested task${parsed.items.length === 1 ? "" : "s"} from ${meetings.length} meeting${meetings.length === 1 ? "" : "s"} today (nothing created yet).`,
          blocks: msg.blocks,
        });
        slackTs = res.ts;
        // Mirror by-ts so a text-reply confirm path can resolve it too.
        if (slackTs) await kv.set(`postmeeting:proposal:${slackTs}`, stored, { ex: PROPOSAL_TTL }).catch(() => {});
      } catch {
        /* ignore Slack failures — the proposal is stored and replayable */
      }
    }

    return { ok: true, meetings: meetings.length, proposed: parsed.items.length, ...(slackTs ? { slackTs } : {}) };
  } catch (err) {
    return { ok: false, meetings: 0, proposed: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
