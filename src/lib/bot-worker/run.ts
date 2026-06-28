import { and, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { kv } from "@/lib/kv-client";
import {
  workItemBotAttempts,
  workItemDrafts,
  type WorkItem,
} from "@/lib/schema";
import {
  getItem,
  logActivity,
  transitionStatus,
  itemUrl,
  selfBaseUrl,
} from "@/lib/work-items";
import { postToChannel } from "@/lib/slack";

// ---------------------------------------------------------------------------
// First-pass prompts per kind. Every prompt is DRAFT-ONLY: the worker runs
// Claude in the owner's per-user sandbox, but the guardrail forbids anything
// customer-facing or any HubSpot write. The board UI is where a human reviews
// and (separately) sends.
// ---------------------------------------------------------------------------

const HARD_GUARDRAIL =
  "\n\n--- GUARDRAIL ---\nThis is a FIRST PASS for human review — produce a DRAFT only. " +
  "Never send anything customer-facing (no emails sent, no messages delivered, no calendar invites issued). " +
  "Never write to HubSpot or any CRM. Do not call any tool that performs an irreversible or external-facing action. " +
  "Return only the drafted content for a human to review and send.";

function firstPassPrompt(item: WorkItem): string {
  const title = item.title;
  const customer = item.customerSlug ? ` (customer: ${item.customerSlug})` : "";
  const base = `You are doing a first-pass DRAFT for a sales work item titled "${title}"${customer}.`;
  let body: string;
  switch (item.kind) {
    case "pricing_proposal":
      body =
        "Draft a pricing proposal: recommended tier(s), price points, and the rationale tied to what we know about this account. Flag any numbers you are unsure of for the human to confirm.";
      break;
    case "enablement_collateral":
      body =
        "Draft the enablement collateral (one-pager / talk track / battlecard as appropriate). Use Reddy's canonical positioning. Note any assets the human must attach.";
      break;
    case "rfp_response":
      body =
        "Draft answers to the RFP. For each question give a clear, accurate response grounded in Reddy capabilities; mark anything that needs SME/legal review.";
      break;
    case "followup_email":
      body =
        "Draft a follow-up email (subject + body). Make it specific to the last interaction. Do NOT send it — leave it as a draft for the human to review and send.";
      break;
    case "meeting_prep":
      body =
        "Draft a meeting-prep brief: attendees, account/opportunity context, recent signals, suggested agenda, and the key questions to ask.";
      break;
    case "account_research":
      body =
        "Draft an account-research summary: company overview, org/contacts, recent signals, fit hypothesis, and recommended next plays.";
      break;
    case "recording_link":
      body =
        "Draft the recording-link summary: locate the relevant call recording reference and write a short summary + the key moments. Do not email it out.";
      break;
    case "scheduling":
      body =
        "Draft the scheduling proposal: propose specific time slots and a short message the human can send. Do NOT actually book or send anything.";
      break;
    case "propose_stage_move":
      body =
        "Draft a recommendation for whether to move this opportunity's stage, with the evidence for/against. Do NOT write the change to HubSpot — propose only.";
      break;
    case "crm_update":
      body =
        "Draft the CRM update content (the fields/notes that should be written) for human review. Do NOT write anything to the CRM.";
      break;
    case "log_to_hubspot":
      body =
        "Draft the activity/note that should be logged to HubSpot for human review. Do NOT write it to HubSpot.";
      break;
    default:
      body =
        "Produce a useful first-pass draft toward completing this item, for human review.";
  }
  return `${base}\n\n${body}${HARD_GUARDRAIL}`;
}

// ---------------------------------------------------------------------------
// Oneshot call (runs Claude in the owner's per-user sandbox AS the owner).
// ---------------------------------------------------------------------------

type OneshotResult = {
  ok: boolean;
  answer?: string;
  references?: Array<{ label: string; url: string; type: string }>;
  error?: string;
};

async function callOneshot(
  question: string,
  userEmail: string,
  oneshotRequestId: string
): Promise<OneshotResult> {
  const secret = process.env.MCP_INTERNAL_SECRET;
  if (!secret) return { ok: false, error: "MCP_INTERNAL_SECRET not set" };
  try {
    const res = await fetch(`${selfBaseUrl()}/api/agent/oneshot`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-reddy-internal": secret,
      },
      body: JSON.stringify({ question, userEmail, oneshotRequestId }),
    });
    const json = (await res.json().catch(() => null)) as OneshotResult | null;
    if (!res.ok || !json) {
      return { ok: false, error: `oneshot http ${res.status}` };
    }
    return json;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// runBotPass — the detached worker. Idempotent per (itemId, taskRevision) via a
// KV NX lock + the unique-where-not-failed attempts index. Never throws.
// ---------------------------------------------------------------------------

export async function runBotPass(
  itemId: string,
  taskRevision: number
): Promise<void> {
  let attemptId: string | null = null;
  let actedAsEmail: string | null = null;
  let lockKey: string | null = null;
  let acquired = false;
  const oneshotRequestId = `botworker:${itemId}:rev:${taskRevision}`;

  try {
    // (a) KV NX lock — bail if another worker already claimed this revision.
    lockKey = `botworker:item:${itemId}:rev:${taskRevision}`;
    const got = await kv.set(lockKey, "1", { nx: true, ex: 900 });
    if (got === null) return; // already claimed (another worker holds the lock)
    acquired = true;

    // (b) re-read + eligibility recheck.
    const item = await getItem(itemId);
    if (!item) return;
    if (
      item.status !== "in_progress" ||
      !item.botAssigned ||
      !item.ownerEmail ||
      item.botTaskRevision !== taskRevision
    ) {
      return;
    }
    actedAsEmail = item.ownerEmail;

    // No existing non-failed attempt at this revision (running or succeeded).
    const existing = await db
      .select()
      .from(workItemBotAttempts)
      .where(
        and(
          eq(workItemBotAttempts.workItemId, itemId),
          eq(workItemBotAttempts.taskRevision, taskRevision),
          ne(workItemBotAttempts.status, "failed")
        )
      )
      .limit(1);
    if (existing[0]) return;

    // (c) insert the running attempt. The unique-where-not-failed index is the
    // real race guard — if two workers slip past the checks above, the second
    // insert violates the index and we bail.
    try {
      const inserted = await db
        .insert(workItemBotAttempts)
        .values({
          workItemId: itemId,
          taskRevision,
          status: "running",
          actedAsEmail,
          oneshotRequestId,
        })
        .returning();
      attemptId = inserted[0]?.id ?? null;
    } catch {
      return; // lost the unique-index race
    }
    if (!attemptId) return;

    await logActivity(itemId, {
      kind: "bot_run",
      actorKind: "bot",
      actorEmail: actedAsEmail,
      body: `Bot first pass started (rev ${taskRevision}).`,
      meta: { taskRevision, oneshotRequestId },
    });

    // (d) run the first pass in the owner's sandbox.
    const result = await callOneshot(
      firstPassPrompt(item),
      actedAsEmail,
      oneshotRequestId
    );

    if (result.ok && result.answer) {
      // (e) success: persist draft → log → transition ready_for_review →
      // mark attempt succeeded → Slack ping.
      const draftRows = await db
        .insert(workItemDrafts)
        .values({
          workItemId: itemId,
          kind: item.kind,
          title: item.title,
          body: result.answer,
          producedBy: "bot",
          actedAsEmail,
          externalRef: result.references
            ? { references: result.references }
            : null,
        })
        .returning();
      const draftId = draftRows[0]?.id ?? null;

      await logActivity(itemId, {
        kind: "bot_draft",
        actorKind: "bot",
        actorEmail: actedAsEmail,
        body: `First-pass draft ready for review.`,
        meta: { taskRevision, draftId, oneshotRequestId },
      });

      // Read a fresh version before the CAS transition.
      const fresh = await getItem(itemId);
      if (fresh) {
        await transitionStatus(itemId, fresh.version, "ready_for_review", {
          kind: "bot",
          email: actedAsEmail,
        });
      }

      await db
        .update(workItemBotAttempts)
        .set({ status: "succeeded", draftId, finishedAt: new Date() })
        .where(eq(workItemBotAttempts.id, attemptId));

      const channel = process.env.SALES_TESTING_CHANNEL_ID;
      if (channel) {
        await postToChannel(channel, {
          text: `First pass ready on ${item.title} — review at ${itemUrl(
            itemId
          )} · I drafted only, you send`,
        }).catch(() => {});
      }
    } else {
      // (f) failure: mark attempt failed (frees the unique index for a retry),
      // bounce the card back to approved for a bounded re-kick.
      await db
        .update(workItemBotAttempts)
        .set({
          status: "failed",
          error: result.error ?? "oneshot returned no answer",
          finishedAt: new Date(),
        })
        .where(eq(workItemBotAttempts.id, attemptId));

      await logActivity(itemId, {
        kind: "bot_run",
        actorKind: "bot",
        actorEmail: actedAsEmail,
        body: `Bot first pass failed: ${result.error ?? "no answer"}.`,
        meta: { taskRevision, oneshotRequestId, failed: true },
      });

      const fresh = await getItem(itemId);
      if (fresh && fresh.status === "in_progress") {
        await transitionStatus(itemId, fresh.version, "approved", {
          kind: "system",
        });
      }
    }
  } catch (err) {
    // Last-resort: never throw out of the detached worker. Best-effort mark the
    // attempt failed so the revision can be retried.
    try {
      if (attemptId) {
        await db
          .update(workItemBotAttempts)
          .set({
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
            finishedAt: new Date(),
          })
          .where(eq(workItemBotAttempts.id, attemptId));
      }
    } catch {
      /* swallow */
    }
  } finally {
    // Release the run lock so a failed attempt (e.g. a cold-start timeout) can be
    // retried immediately once the sandbox is warm. Success is independently
    // guarded by the unique-attempt index + the eligibility recheck, so freeing
    // the lock on success is harmless. Only release a lock we actually took.
    if (acquired && lockKey) await kv.del(lockKey).catch(() => {});
  }
}
