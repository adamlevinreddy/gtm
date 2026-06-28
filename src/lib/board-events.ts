import { selfBaseUrl, type WorkItemKind } from "@/lib/work-items";
import type { WorkItem } from "@/lib/schema";

/**
 * Kinds the bot takes a first pass at automatically (draft-only). These fire a
 * detached bot-run the moment the card lands in "Reddy Working" assigned to the
 * bot. Everything customer-facing or legally sensitive is HUMAN_ONLY.
 */
export const BOT_FIRST_PASS_KINDS: WorkItemKind[] = [
  "pricing_proposal",
  "enablement_collateral",
  "rfp_response",
  "followup_email",
  "meeting_prep",
  "account_research",
  "recording_link",
  "scheduling",
  "propose_stage_move",
  "crm_update",
  "log_to_hubspot",
];

export const HUMAN_ONLY: WorkItemKind[] = [
  "deck_qbr",
  "contract_redline",
  "book_meeting",
];

function isBotFirstPass(kind: WorkItemKind): boolean {
  return BOT_FIRST_PASS_KINDS.includes(kind);
}

/**
 * Decide whether `after` just crossed the edge that should kick off a bot first
 * pass, and if so POST a fire-and-forget trigger to /api/board/bot-run. Never
 * awaits the response body and never throws — the mutation route stays fast and
 * the worker run is fully decoupled.
 *
 * The fire-worthy EDGE is any of:
 *  - status transitioned INTO in_progress, or
 *  - botAssigned flipped false→true while already in_progress, or
 *  - botTaskRevision bumped while already in_progress (a re-kick / retry)
 * AND the item is bot-assigned, has an owner email, is a BOT_FIRST_PASS kind,
 * and is currently in_progress.
 */
export async function maybeFire(
  before: WorkItem | null,
  after: WorkItem,
  origin: string
): Promise<void> {
  try {
    // Target state must hold regardless of which edge triggered it.
    if (
      !after.botAssigned ||
      !after.ownerEmail ||
      after.status !== "in_progress" ||
      !isBotFirstPass(after.kind)
    ) {
      return;
    }

    const enteredInProgress =
      (before?.status ?? null) !== "in_progress" && after.status === "in_progress";
    const botJustAssigned =
      !(before?.botAssigned ?? false) && after.botAssigned === true;
    const revisionBumped =
      (before?.botTaskRevision ?? -1) !== after.botTaskRevision;

    const fireWorthy = enteredInProgress || botJustAssigned || revisionBumped;
    if (!fireWorthy) return;

    const secret = process.env.BOARD_API_SECRET;
    if (!secret) return;

    // Fire-and-forget. keepalive lets the request survive the function returning;
    // we deliberately do NOT await the body (or even the response on the happy path).
    void fetch(`${selfBaseUrl()}/api/board/bot-run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-board-secret": secret,
      },
      body: JSON.stringify({
        itemId: after.id,
        taskRevision: after.botTaskRevision,
        origin,
      }),
      keepalive: true,
    }).catch(() => {
      /* fire-and-forget — bot-run is also re-triggerable on the next mutation */
    });
  } catch {
    /* never let event-firing break a mutation */
  }
}
