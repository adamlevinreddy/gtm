// Seed the v2 board with realistic GTM demo data across all 5 columns,
// incl. a parent→subtask (the pricing → follow-up example), priority, and
// bot-assignment. Idempotent: deletes created_by='seed' first.
//   node --env-file=.env.local scripts/seed-board-v2.mjs
import postgres from "postgres";

const url = process.env.POSTGRES_URL;
if (!url) { console.error("POSTGRES_URL not set"); process.exit(1); }
const sql = postgres(url, { prepare: false });

const ADAM = "adam@reddy.io";
const now = new Date();
const days = (n) => new Date(now.getTime() + n * 86400000);
let rank = 0;
const nextRank = () => (++rank * 100000).toString().padStart(12, "0");

const typeOf = (k) => ({
  followup_email: "followup", book_meeting: "followup", reengage_tickler: "followup",
  crm_update: "crm_update", log_to_hubspot: "crm_update", propose_stage_move: "crm_update",
  meeting_prep: "prep", prep_custom_demo: "prep", account_research: "prep",
}[k] ?? "task");

async function ins(r) {
  const [row] = await sql`INSERT INTO work_items ${sql({
    type: typeOf(r.kind), kind: r.kind, title: r.title, status: r.status,
    source: r.source ?? "manual", owner_kind: "human", owner_email: r.owner ?? null,
    bot_assigned: r.bot ?? false, customer_slug: r.customer ?? null,
    parent_id: r.parentId ?? null, payload: r.payload ?? {}, created_by: "seed",
    high_priority: r.high ?? false, due_at: r.due ?? null, waiting_on: r.waitingOn ?? null,
    board_rank: nextRank(), stage_entered_at: r.stageEntered ?? now,
    started_at: ["in_progress","ready_for_review","blocked","waiting","done"].includes(r.status) ? days(-2) : null,
    completed_at: r.status === "done" ? days(-1) : null,
    created_at: r.createdAt ?? now, updated_at: now,
  })} RETURNING id`;
  return row.id;
}

async function main() {
  await sql`DELETE FROM work_items WHERE created_by = 'seed'`;

  // Parent in Reddy Waiting (the worked example anchor)
  const pricingParent = await ins({
    kind: "pricing_proposal", title: "Acme pricing sent — awaiting response", status: "waiting",
    source: "slack_chat", owner: "charles@reddy.io", customer: "acme", stageEntered: days(-6),
    payload: { detail: "2-yr feature-grid proposal sent 6 days ago" },
  });
  // Subtask auto-created post-meeting into Unsorted (parent = the pricing task)
  await ins({
    kind: "followup_email", title: "Follow up with Adam on Acme pricing", status: "triage",
    source: "post_meeting", owner: ADAM, customer: "acme", parentId: pricingParent,
    payload: { detail: "Internal mtg: Adam to nudge Acme champion on the open proposal" },
  });
  await sql`UPDATE work_items SET child_total_count = 1, child_open_count = 1 WHERE id = ${pricingParent}`;

  const rows = [
    // Unsorted
    { kind: "log_to_hubspot", title: "Log Grubhub QBR notes to HubSpot", status: "suggested", source: "post_meeting", customer: "grubhub", payload: { detail: "Auto-extracted from QBR" } },
    { kind: "rfp_response", title: "Best Buy security questionnaire — 40 questions", status: "triage", source: "post_meeting", customer: "best-buy", owner: "tom@reddy.io" },
    // To Do
    { kind: "pricing_proposal", title: "Build Morgan & Morgan pricing v2", status: "approved", source: "slack_chat", customer: "morgan-morgan", owner: "charles@reddy.io", bot: true, high: false, due: days(3) },
    { kind: "prep_custom_demo", title: "Prep custom demo for Oscar Health (Thu)", status: "approved", source: "slack_chat", customer: "oscar-health", owner: ADAM, high: true },
    // Reddy Working
    { kind: "deck_qbr", title: "Draft Lowe's QBR deck", status: "in_progress", source: "slack_chat", customer: "lowes", owner: ADAM, due: days(10) },
    { kind: "rfp_response", title: "RFP answers for H&R Block (bot drafted)", status: "ready_for_review", source: "slack_chat", customer: "hr-block", owner: "tom@reddy.io", bot: true },
    { kind: "contract_redline", title: "Tapestry MSA redline — blocked on legal", status: "blocked", source: "slack_chat", customer: "tapestry", owner: ADAM, waitingOn: "legal review" },
    // Reddy Waiting
    { kind: "book_meeting", title: "Labcorp — awaiting reply to scheduling poll", status: "waiting", source: "gmail", customer: "labcorp", owner: ADAM, stageEntered: days(-3) },
    // Completed
    { kind: "followup_email", title: "Sent Grubhub recap + next steps", status: "done", source: "slack_chat", customer: "grubhub", owner: ADAM },
    { kind: "recording_link", title: "Sent Lowe's recording link to Amy", status: "done", source: "slack_chat", customer: "lowes", owner: "amyk@reddy.io" },
  ];
  for (const r of rows) await ins(r);

  const [{ count }] = await sql`SELECT count(*)::int FROM work_items`;
  const byStatus = await sql`SELECT status, count(*)::int n FROM work_items GROUP BY status ORDER BY status`;
  console.log(`✓ seeded; ${count} rows total`);
  console.log("  by status:", byStatus.map((r) => `${r.status}=${r.n}`).join("  "));
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
