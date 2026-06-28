// Apply the work_items table (idempotent, additive) + seed demo rows so the
// /board stub and morning digest have something to render.
//
//   node --env-file=.env.local scripts/apply-board.mjs
//
// Re-runnable: the DDL is IF-NOT-EXISTS and seed rows (created_by='seed') are
// deleted then re-inserted. Touches nothing but the new table.
import postgres from "postgres";

const url = process.env.POSTGRES_URL;
if (!url) {
  console.error("POSTGRES_URL not set (run with --env-file=.env.local)");
  process.exit(1);
}
const sql = postgres(url, { prepare: false });

const DDL = `
DO $$ BEGIN CREATE TYPE work_item_type AS ENUM ('followup','crm_update','prep','task'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE work_item_status AS ENUM ('suggested','approved','done','dismissed'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE work_item_source AS ENUM ('post_meeting','cron','manual'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE work_item_owner_kind AS ENUM ('human','bot'); EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS work_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type work_item_type NOT NULL,
  title text NOT NULL,
  status work_item_status NOT NULL DEFAULT 'suggested',
  source work_item_source NOT NULL,
  owner_kind work_item_owner_kind NOT NULL DEFAULT 'human',
  owner_email text,
  account_id uuid REFERENCES accounts(id),
  opportunity_id uuid REFERENCES opportunities(id),
  meeting_id uuid REFERENCES meetings(id),
  customer_slug text,
  source_ref text,
  payload jsonb NOT NULL,
  dismissed_reason text,
  approved_by text,
  approved_at timestamp,
  completed_at timestamp,
  created_by text NOT NULL DEFAULT 'bot',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items (status);
CREATE INDEX IF NOT EXISTS idx_work_items_owner ON work_items (owner_email);
CREATE INDEX IF NOT EXISTS idx_work_items_account ON work_items (account_id);
CREATE INDEX IF NOT EXISTS idx_work_items_meeting ON work_items (meeting_id);
CREATE INDEX IF NOT EXISTS idx_work_items_source_ref ON work_items (source_ref);
CREATE INDEX IF NOT EXISTS idx_work_items_customer_slug ON work_items (customer_slug);
CREATE INDEX IF NOT EXISTS idx_work_items_created ON work_items (created_at);
CREATE INDEX IF NOT EXISTS idx_work_items_completed ON work_items (completed_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_items_dedup ON work_items (source_ref, type, title) WHERE source_ref IS NOT NULL;
`;

// --- PT "yesterday" anchored at 18:00 UTC (safely mid-day PT, DST-proof) ---
const ptToday = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles" }).format(new Date());
const [y, m, d] = ptToday.split("-").map(Number);
const yAnchor = new Date(Date.UTC(y, m - 1, d, 12));
yAnchor.setUTCDate(yAnchor.getUTCDate() - 1);
const yPt = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(yAnchor);
const yesterday = new Date(`${yPt}T18:00:00Z`);
const twoDaysAgo = new Date(yesterday.getTime() - 24 * 3600 * 1000);
const ADAM = "adam@reddy.io";

const SEED = [
  { type: "crm_update", title: "Move Morgan & Morgan to Proposal stage", status: "suggested", source: "post_meeting", owner_email: ADAM, customer_slug: "morgan-morgan", created_at: yesterday,
    payload: { object: "deal", field: "dealstage", currentValue: "Discovery", suggestedValue: "Proposal", rationale: "Pricing aligned on the 2-yr term in yesterday's call" } },
  { type: "followup", title: "Send Grubhub the QA scorecard sample", status: "suggested", source: "post_meeting", owner_email: ADAM, customer_slug: "grubhub", created_at: yesterday,
    payload: { channel: "email", subject: "QA scorecard sample", body: "Sharing the scorecard layout we discussed.", dueHint: "today" } },
  { type: "prep", title: "Prep for Lowe's QBR Thursday", status: "approved", source: "manual", owner_email: ADAM, customer_slug: "lowes", created_at: twoDaysAgo, approved_by: ADAM, approved_at: yesterday,
    payload: { when: "Thu 2pm PT", checklist: ["Pull QA adoption numbers", "Confirm sim completion rate", "Draft expansion ask"] } },
  { type: "task", title: "Confirm Best Buy security review owner", status: "approved", source: "manual", owner_email: ADAM, customer_slug: "best-buy", created_at: twoDaysAgo, approved_by: ADAM, approved_at: twoDaysAgo,
    payload: { detail: "Find the InfoSec POC for the SOC2 review", dueHint: "this week" } },
  { type: "crm_update", title: "Logged H&R Block next step in HubSpot", status: "done", source: "post_meeting", owner_email: ADAM, customer_slug: "hr-block", created_at: twoDaysAgo, completed_at: yesterday,
    payload: { object: "deal", field: "next_step", suggestedValue: "Security questionnaire returned", rationale: "Captured from the kickoff transcript" } },
  { type: "followup", title: "Sent Grubhub recap + next steps", status: "done", source: "post_meeting", owner_email: ADAM, customer_slug: "grubhub", created_at: twoDaysAgo, completed_at: yesterday,
    payload: { channel: "email", subject: "Recap + next steps", body: "Thanks for the time today…" } },
  { type: "task", title: "Old duplicate reminder", status: "dismissed", source: "manual", owner_email: ADAM, created_at: twoDaysAgo, dismissed_reason: "duplicate",
    payload: { detail: "superseded" } },
];

async function main() {
  await sql.unsafe(DDL);
  console.log("✓ work_items table + indexes ensured");

  await sql`DELETE FROM work_items WHERE created_by = 'seed'`;
  for (const r of SEED) {
    await sql`INSERT INTO work_items ${sql({
      type: r.type, title: r.title, status: r.status, source: r.source,
      owner_kind: "human", owner_email: r.owner_email ?? null, customer_slug: r.customer_slug ?? null,
      payload: r.payload, created_by: "seed",
      created_at: r.created_at, updated_at: r.created_at,
      completed_at: r.completed_at ?? null, approved_by: r.approved_by ?? null,
      approved_at: r.approved_at ?? null, dismissed_reason: r.dismissed_reason ?? null,
    })}`;
  }
  const [{ count }] = await sql`SELECT count(*)::int FROM work_items`;
  console.log(`✓ seeded ${SEED.length} demo rows (created_by='seed'); table now has ${count} rows`);
  await sql.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
