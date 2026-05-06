# GTM Data Model -- Business Overview

## What We're Building

The Reddy GTM database is the operational backbone that connects conference list uploads through company classification, contact enrichment, persona tagging, sequence enrollment, and HubSpot CRM sync. Today it stores classification decisions (which companies are vendors, BPOs, or prospects). The expanded schema adds first-class tracking for individual people, enrichment status, sales pipeline deals, intent signals, meeting intelligence, engagement activity tracking, email sending infrastructure health, and a complete audit trail of everything synced to HubSpot. Supabase Postgres is the working system; HubSpot is the downstream destination.

---

## Tables (18 total)

### 1. Companies (existing -- preserved as-is)

**What it stores:** Every company that has been classified through the review pipeline. Each row records a classification decision: exclude (vendor/competitor), tag (BPO/media), or prospect (potential buyer).

**Who creates records:** The commit step of the human review flow. When a reviewer accepts or rejects Claude's classification, the decision is written here.

**Why it exists separately from Accounts:** This table is the classification reference list. It answers "is this company a vendor or a prospect?" The 305 rows here (201 exclusions, 101 tags, 3 prospects) are the foundation that every future conference list is matched against. It does not store enrichment data, deal pipeline data, or HubSpot sync state -- that belongs on the Accounts table.

**No columns are removed.** The existing schema is fully preserved.

---

### 2. Company Aliases (existing -- preserved as-is)

**What it stores:** Alternate spellings and names for companies in the Companies table, used for fuzzy matching during classification.

**Example:** "NICE" might have aliases "NICE inContact", "NICE CXone", "NICE Systems".

**Known gap:** The current codebase reads aliases but never writes them. A future improvement should auto-generate aliases from conference list variations.

---

### 3. Categories (existing -- preserved as-is)

**What it stores:** The master list of classification category definitions -- the 10 exclusion categories (ccaas, ai_voice, etc.) and 2 tag categories (bpo, media).

**Who creates records:** Manual seed or migration script. Not auto-populated by the application.

---

### 4. Accounts (new)

**What it stores:** Companies as sales targets -- a richer entity than the classification-only Companies table. An Account tracks enrichment data (industry, employee count, tech stack, funding), ABM tiering (Tier 1/2/3), account status (Target through Customer), intent scores from Bombora/Clay, structured Claygent research output, and all external system IDs (HubSpot, Apollo, Common Room).

**New in this version:** `intent_score` for Bombora rollup data, `clay_research` for structured Claygent output, `referred_by_account_id` for tracking which customer referred this account (self-referential FK), and `referral_date` for when the referral was made. These additions support the customer expansion and deep enrichment workflows.

**Relationship to Companies:** A prospect in the Companies table may become an Account when promoted to the active sales pipeline. The link is stored as `classification_company_id` on the Account. Many Accounts will have no matching Companies row (accounts sourced from Apollo, Common Room, or ABM targeting may never go through classification).

**Who creates records:** Conference pipeline enrichment, Apollo/Clay enrichment, Common Room signal processing, ABM targeting workflows.

**HubSpot sync:** Bidirectional. Account properties sync to HubSpot Company records. The `hubspot_company_id` column links them.

---

### 5. Contacts (new)

**What it stores:** Individual people -- the attendees from conference lists, enriched prospects from Apollo/Clay, website visitors identified by Common Room. Each contact has demographic data (name, email, title, phone, LinkedIn), classification data (persona, buying role, seniority), pipeline data (sequence status, lead source, outreach priority), enrichment metadata, email deliverability status, employment history, job change detection, and LinkedIn outreach status.

**New in this version:** `email_status` (enum: valid, risky, invalid, bounced, unknown) for nuanced deliverability tracking beyond the binary `email_verified` boolean. `employment_history` (JSON) for storing Apollo employment history. `previous_company_name` and `job_change_detected_at` for detecting when contacts change jobs during re-enrichment. `linkedin_outreach_status` (enum) for tracking HeyReach outreach state. `disqualification_reason` changed from free text to a proper enum (competitor, wrong_role, wrong_company_size, bad_fit, other) to match HubSpot expectations.

**Why this matters:** Today, individual attendees only exist in Vercel KV and expire after 7 days. This table makes them permanent. You can query "show me all L&D personas we've seen across all conferences" or "which contacts at Company X have been sequenced."

**Relationship to Accounts:** Each contact has a primary `account_id` linking to their company. A contact also stores `company_name` directly (denormalized) so most reads don't need a join.

**Relationship to Companies (classification):** Contacts at excluded/tagged companies are flagged via `is_competitor` and `is_disqualified` booleans derived from the Companies classification.

**HubSpot sync:** Contacts push to HubSpot with persona, seniority, lead source, sequence status, and all enrichment fields. Email is the primary match key.

---

### 6. Conferences (new)

**What it stores:** Metadata about each conference or event -- name, dates, location, type (in-person, virtual, hybrid), and notes. This is the anchor for tracking which lists came from which events.

**Who creates records:** Created when a conference attendee list is first processed. Can also be created manually.

**Example:** "CCW Las Vegas 2026", June 16-19, Las Vegas, in-person.

---

### 7. Conference Lists (new)

**What it stores:** Each uploaded CSV file linked to a conference. Tracks the file name, upload timestamp, who uploaded it, list type (pre-conference or post-conference), total contact count, and processing status.

**New in this version:** `processing_status` (enum: pending, processing, completed, failed) tracks the pipeline state of each list upload. This was described in the original overview but missing from the technical schema.

**Relationship to Conferences:** Each list belongs to one conference.

**Relationship to Contacts:** The `list_contacts` junction table connects which contacts came from which list.

**Why this matters:** Today the `source` field on Companies is a free-text string like "ccw-2026-pre.csv". This table gives that structure, enabling queries like "how many new prospects came from CCW 2026?"

---

### 8. List Contacts (new -- junction table)

**What it stores:** The many-to-many relationship between conference lists and contacts. A contact can appear on multiple lists (same person at different conferences). Each row also stores the original title as it appeared on that specific list (titles may differ across lists).

**New in this version:** `met_at_conference` (boolean, default false) tracks whether a contact was physically met at the event. This gets set when a contact appears on a post-conference list cross-referenced against the pre-conference list. It drives different sequence routing: "met" contacts get a warmer follow-up sequence, "did not meet" contacts get a standard outreach sequence.

---

### 9. Enrichment Runs (new)

**What it stores:** A log of every enrichment operation -- which contact or account was enriched, by which source (Apollo, Clay, manual), when, whether it succeeded, and a snapshot of what data was returned.

**Why this matters:** Enrichment costs money (Apollo credits, Clay credits). This table answers "have we already enriched this person?" and "when was this data last refreshed?" It also stores the raw enrichment payload as JSON for debugging and audit purposes.

---

### 10. Opportunities (new)

**What it stores:** Deals in the MEDDPIC Opportunity Pipeline. Each opportunity tracks the six MEDDPIC qualification criteria (Metrics, Economic Buyer, Decision Criteria, Decision Process, Identify Pain, Champion) with both a status enum and free-text detail for each. Also tracks deal health score, stage, amount, and risk indicators.

**New in this version:** `last_activity_date` (timestamp) is a denormalized rollup from the `contact_activities` table. It gets updated whenever a contact activity (email reply, meeting, call, etc.) is logged for a contact associated with this opportunity. This replaces the need to call the HubSpot API during every deal health scoring run to determine activity recency.

**Relationship to Accounts:** Each opportunity belongs to one account.

**Pipeline stages:** Target Identified, Outreach Active, Discovery, Qualification In Progress, Fully Qualified, Disqualified.

**HubSpot sync:** Bidirectional. MEDDPIC fields, deal health score, and stage sync to HubSpot's Opportunity Pipeline.

**Design decision -- MEDDPIC on the deal:** The six MEDDPIC status/detail pairs live directly on the opportunity row (12 columns). This avoids a separate MEDDPIC table and extra joins. Since every opportunity has exactly one set of MEDDPIC data, denormalization is the right call.

---

### 11. Deals (new)

**What it stores:** Deals in the Closing Pipeline -- post-qualification. When all six MEDDPIC criteria are validated, an opportunity converts to a deal. Deals track procurement status, security questionnaire progress, contract type, budget confirmation, close confidence, and win/loss data.

**Relationship to Opportunities:** Each deal links back to the opportunity it was converted from.

**Relationship to Accounts:** Each deal also has a direct `account_id` for simple queries.

**HubSpot sync:** Bidirectional. Deal properties sync to HubSpot's Deal Pipeline.

---

### 12. Contact Deal Roles (new -- junction table)

**What it stores:** Which contacts are involved in which opportunities, and what role they play on the buying committee (Champion, Economic Buyer, Technical Evaluator, Decision Maker, Coach, Blocker, End User, Legal/Procurement, Executive Sponsor).

**Why this matters:** Multi-threading is a core strategy. This table answers "who is the champion on the Acme deal?" and "is this opportunity single-threaded?"

---

### 13. Signals (new)

**What it stores:** Intent signals from Common Room, website visits, G2 research activity, job postings, funding events, and other buying indicators. Each signal is linked to an account and optionally to a contact.

**New in this version:** `external_id` for deduplication of Common Room signals. A unique index on `(source, external_id)` where `external_id` is not null prevents duplicate signal rows when the same event is reported multiple times.

**Who creates records:** Inbound webhooks from Common Room, periodic pulls from Bombora/G2, manual entry.

**Why this matters:** Signals drive prioritization. "Company X just posted 3 QA manager jobs and visited our pricing page" is a strong buying signal.

---

### 14. Sync Log (new)

**What it stores:** An audit trail of every sync operation between Supabase and an external system (HubSpot, Apollo, Clay, Common Room). Records what entity was synced, in which direction, whether it succeeded, and what changed.

**New in this version:** `retry_count` and `next_retry_at` for built-in retry tracking. Failed syncs can now be identified and retried without re-querying all failed rows -- the `next_retry_at` timestamp enables a simple cron-based retry pattern.

**Why this matters:** When something looks wrong in HubSpot, you can trace back to exactly when and what was synced. Also enables retry logic for failed syncs.

---

### 15. Agent Runs (new)

**What it stores:** A log of every Claude agent execution -- classification runs, persona tagging, meeting briefs, deal health scoring, etc. Tracks which agent, what inputs were provided, what outputs were produced, how long it took, and whether it succeeded.

**Why this matters:** Agent executions cost money (AI Gateway credits) and affect data quality. This table enables debugging ("why did this contact get tagged as unknown?") and cost tracking.

---

### 16. Meetings (new)

**What it stores:** Meeting records from Granola transcripts, Apollo Conversation Intelligence, or manual entry. Each meeting stores the full transcript, a summary (from Granola or Claude), structured attendee data, and Claude-extracted intelligence: MEDDPIC updates, competitive intelligence (competitors mentioned, objections raised, buying signals detected), action items, and pre-meeting briefs.

**Who creates records:** The post-meeting follow-up agent processes Granola transcripts and stores the meeting data. The pre-meeting brief agent writes the brief text before the meeting occurs. Manual meetings can be entered by sales reps.

**Why this matters:** Before this table, Granola transcripts were read in real-time via MCP but never persisted. Historical meeting data was lost after each agent run. Now you can query "what objections has Company X raised across all meetings?" or "show me all action items from last week's meetings."

**Relationship to Accounts/Opportunities:** Each meeting links to an account and optionally to an opportunity. A meeting can be a discovery call with no deal yet, or a late-stage negotiation tied to a specific opportunity.

**Key columns:**
- `transcript` -- Full Granola transcript text
- `summary` -- Granola or Claude-generated meeting summary
- `meddpic_extractions` -- Structured JSON with MEDDPIC status updates extracted by Claude
- `competitive_intel` -- JSON with `{competitors: [], objections: [], buying_signals: []}`
- `action_items` -- JSON array of extracted action items
- `brief_text` -- Pre-meeting brief generated by Claude before the meeting
- `source` -- "granola", "apollo_ci", or "manual"

**HubSpot sync:** Meeting records sync to HubSpot as engagement activities via `hubspot_meeting_id`.

---

### 17. Contact Activities (new)

**What it stores:** Individual engagement events per contact: email opens, clicks, replies, bounces, meetings, calls, LinkedIn messages, LinkedIn connections, website visits, and other activities. Each activity has a type, date, source system, and a flexible JSON metadata payload.

**Who creates records:** Apollo sequence engagement data (opens, clicks, replies, bounces), HubSpot activity webhooks, Common Room website visit signals, and the meeting intelligence agent (logging meeting participation).

**Why this matters:** This table is the foundation for two critical capabilities:
1. **Deal health scoring** -- The "last activity recency" factor (20% weight) now queries directly from Supabase instead of calling the HubSpot API during every weekly scoring run.
2. **Contact engagement history** -- Sales reps can see a full timeline of engagement per contact: "this person opened 3 emails, clicked 1, and attended 2 meetings."

**Relationship to Contacts:** Every activity belongs to one contact. Activities cascade-delete when a contact is deleted.

**Relationship to Opportunities:** Activities can optionally link to a deal, enabling per-deal activity rollups. When an activity is logged for a contact on a deal, the `opportunities.last_activity_date` denormalized field is updated.

**Key activity types:** email_open, email_click, email_reply, email_bounce, meeting, call, linkedin_message, linkedin_connection, website_visit, other.

---

### 18. Sending Accounts (new)

**What it stores:** Email sending mailboxes tracked for Instantly warmup status and health. Each row represents one sending email address used for cold outreach, with its current warmup status, health score, daily send limit, and provider information.

**Who creates records:** Manual registration when new sending mailboxes are added to Instantly. Warmup status and health scores are updated periodically via the Instantly API.

**Why this matters:** Before sequence enrollment, the system needs to verify that sending mailboxes are warmed and healthy. This table answers "which mailboxes are ready for cold outreach?" and "what is the total daily sending capacity across all accounts?"

**Key columns:**
- `warmup_status` -- not_started, active, paused, complete
- `health_score` -- 0-100 from Instantly
- `daily_send_limit` -- Maximum emails per day for this mailbox
- `instantly_account_id` -- Links to the Instantly API

---

## How Data Flows

### Conference List Pipeline (Current + Extended)

1. An attendee list CSV is uploaded to Slack.
2. The system parses it into company-title pairs.
3. **Companies** are matched against the existing Companies table (exclusions, tags, known prospects).
4. Unknown companies are sent to Claude for classification. Accepted decisions are committed to the **Companies** table.
5. **(New)** A **Conference** record is created (or matched to an existing one). A **Conference List** record captures the upload metadata. The list's `processing_status` tracks progress through the pipeline.
6. **(New)** Each attendee becomes a **Contact** row. The contact-to-list link is stored in **List Contacts**, including the `met_at_conference` flag for post-conference cross-referencing.
7. **(New)** Contacts are persona-classified (L&D, QA, Ops, etc.) and the persona is stored directly on the Contact.
8. **(New)** Contacts at prospect companies are enriched via Apollo. The enrichment result is logged in **Enrichment Runs** and the contact's fields (including `email_status`, `employment_history`) are updated.
9. **(New)** Enriched contacts are synced to HubSpot. The sync is logged in **Sync Log** (with retry tracking if it fails).
10. **(New)** For Tier 1/2 accounts, an **Opportunity** is created in the MEDDPIC pipeline. Contacts are linked to the opportunity via **Contact Deal Roles**.

### Website Visitor Pipeline (New)

1. Common Room detects a website visitor and sends a webhook.
2. A **Signal** is created in the signals table (with `external_id` for deduplication).
3. The company is classified. If it is a prospect, an **Account** is created or updated (including `intent_score` from Bombora data).
4. Apollo People Search finds contacts at the company. After human approval, contacts are enriched and stored as **Contact** rows.
5. Contacts are synced to HubSpot and enrolled in sequences (after verifying **Sending Accounts** are healthy).

### Meeting Intelligence Pipeline (New)

1. Before a meeting, the pre-meeting brief agent queries the **Meetings** table for past meetings with the same attendees/company.
2. The agent pulls deal context from **Opportunities** (MEDDPIC status, next steps) and account intelligence from **Accounts** (competitor presence, tech stack).
3. The brief is generated by Claude and stored in `meetings.brief_text`, then delivered to Slack.
4. After the meeting, the post-meeting agent reads the Granola transcript via MCP.
5. Claude extracts MEDDPIC updates, competitive intel, objections, buying signals, and action items.
6. All extracted data is stored in the **Meetings** table (transcript, summary, meddpic_extractions, competitive_intel, action_items).
7. **Contact Activities** are logged for each meeting participant (activity_type = "meeting").
8. The `opportunities.last_activity_date` rollup is updated.
9. Proposed MEDDPIC updates are posted to Slack for human approval before writing to Opportunities.

### Deal Lifecycle (New)

1. An **Opportunity** starts at "Target Identified" and moves through MEDDPIC qualification.
2. After meetings, Claude extracts MEDDPIC updates from Granola transcripts and proposes CRM changes (with human approval).
3. When all 6 MEDDPIC criteria are validated, the opportunity converts to a **Deal** in the closing pipeline.
4. Deal health is scored weekly using data from **Contact Activities** (last activity recency), **Contact Deal Roles** (stakeholder coverage), and **Opportunities** (MEDDPIC completion, champion engagement, next step status).
5. At-risk deals are flagged in Slack if the health score drops below threshold.

### Customer Expansion Pipeline (New)

1. Closed-won deals with high expansion potential are identified.
2. Referrals from existing customers are tracked via `accounts.referred_by_account_id` and `accounts.referral_date`, preserving attribution from the referring customer to the new target account.
3. New contacts at the referred company are enriched and entered into the pipeline.

---

## Current to New Table Mapping

| What Exists Today | What Happens | New Home |
|---|---|---|
| `companies` table (305 rows) | **Preserved as-is.** No columns removed. | Same table, same schema |
| `company_aliases` table | **Preserved as-is.** | Same table, same schema |
| `categories` table | **Preserved as-is.** | Same table, same schema |
| `action` enum | **Preserved.** Also used by new tables. | Same enum |
| KV `review.attendees[]` | **Migrated to Postgres.** Each attendee becomes a Contact row. | `contacts` table |
| KV `review.hubspotMatches[]` | **Contact data migrated.** HubSpot match status stored on contact. | `contacts` table |
| KV `review.source` (free text) | **Structured.** Linked to a Conference and Conference List. | `conferences` + `conference_lists` tables |
| KV review state | **Stays in KV.** Reviews are ephemeral workflow state. | Vercel KV (no change) |
| KV completion counters | **Stays in KV.** Ephemeral job tracking. | Vercel KV (no change) |
| Granola transcripts (MCP only) | **Now persisted.** Transcripts, summaries, and extracted intel stored. | `meetings` table |
| Apollo engagement data (HubSpot only) | **Now stored locally.** Individual opens/clicks/replies tracked. | `contact_activities` table |
| Instantly warmup status (dashboard only) | **Now tracked in Postgres.** Mailbox health programmatically accessible. | `sending_accounts` table |

---

## Key Design Decisions

1. **Companies vs. Accounts -- two separate tables.** The Companies table is a classification reference list (305 rows, mostly vendors). The Accounts table tracks sales pipeline companies with enrichment data and deal associations. They serve different purposes and will grow at different rates. A `classification_company_id` FK links them when applicable.

2. **MEDDPIC fields directly on the Opportunities table.** Each opportunity has exactly one set of 6 MEDDPIC criteria. Putting them directly on the row (12 columns: 6 status enums + 6 detail text fields) avoids an extra table and join. The tradeoff is a wider table, but since opportunities are always queried with MEDDPIC data, this is the right call.

3. **Contacts store denormalized company_name.** Even though contacts have an `account_id` FK, the company name is stored directly on the contact. Most reads (review UI, HubSpot sync, sequence enrollment) need the name without joining to accounts.

4. **Persona stored directly on contacts.** No separate persona table. The persona is a text enum value on the contact row. Simple to read, simple to sync to HubSpot.

5. **UUIDs for externally-referenced records.** Contacts, accounts, opportunities, deals, and meetings use UUIDs as primary keys because they sync to external systems (HubSpot, Apollo). Serial IDs for internal-only tables (enrichment_runs, sync_log, agent_runs, contact_activities, sending_accounts).

6. **Timestamps on every table.** `created_at` and `updated_at` on every table for audit and freshness tracking.

7. **KV stays for ephemeral state.** Review workflow state, completion counters, and batch tracking remain in Vercel KV with 7-day TTL. Postgres is for durable data that outlives a single review session.

8. **Denormalized `last_activity_date` on opportunities.** Rather than querying `contact_activities` during every deal health scoring run, the rollup is maintained as activities are logged. This trades a small write overhead for significantly faster scoring reads.

9. **Self-referential FK for referral tracking.** `accounts.referred_by_account_id` points back to the accounts table, keeping referral attribution simple without a separate referral table. The `referral_date` timestamp records when the referral was made.

10. **Meeting intelligence stored with meetings, not opportunities.** MEDDPIC extractions, competitive intel, and action items live on the `meetings` row (as JSON columns) rather than being normalized into separate tables. This keeps meeting data self-contained and queryable: "what was discussed in each meeting?" without cross-table joins.
