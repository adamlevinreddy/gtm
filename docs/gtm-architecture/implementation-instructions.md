# GTM System Implementation Instructions

> For the next Claude agent session to build off the schema design.
> Written: 2026-03-29 | Author: gtm-architect orchestrator

---

## What You're Building

You are expanding the Reddy GTM system from a classification-only tool (3 Postgres tables, Slack + HubSpot) into a full GTM pipeline with contacts as first-class entities, enrichment tracking, deal pipeline management, meeting intelligence, and multi-system sync. The schema has been designed and validated. Your job is to implement it.

---

## Golden Rules

1. **Everything runs on Vercel.** No local scripts, no CLI tools, no cron daemons. Serverless functions, Vercel Sandbox for Claude, Vercel KV for ephemeral state.

2. **Claude always runs in Vercel Sandbox.** Classification, persona tagging, meeting briefs, MEDDPIC extraction -- all Claude work happens inside `@vercel/sandbox` using `@anthropic-ai/sdk`. Server-side API calls (HubSpot, Apollo, Postgres) are fine outside sandbox.

3. **Slack is the primary interface.** Users interact via @mention in any Slack channel. One combined message per operation -- never send intermediate updates.

4. **HubSpot is a downstream destination, not the source of truth.** Supabase Postgres holds the working data. HubSpot gets synced to, and we READ from HubSpot to adapt to what's already there. DO NOT create custom properties in HubSpot, DO NOT create pipelines, DO NOT modify HubSpot configuration. Adapt the Supabase schema to map to whatever HubSpot already has.

5. **KV stays for ephemeral state.** Reviews, batch counters, job completion tracking stay in Vercel KV with 7-day TTL. Postgres is for durable data only.

6. **Cost is no object -- accuracy over speed.** Use Claude Opus 4.6 liberally. Use agents for complex reasoning. Don't cut corners to save tokens.

---

## What Already Works (Don't Break It)

### Current Pipeline (end-to-end, production)
```
Slack @mention with CSV → parse file → known match against 305 companies in Postgres
  → unknown companies sent to Claude (Opus 4.6 in sandbox, 20/batch)
  → HubSpot contact search (server-side, per company)
  → persona classification (Sonnet 4.6 in sandbox, all titles)
  → combined Slack message with results + review link
  → review page (Classification tab + Attendees tab)
  → human accept/reject decisions → commit to Postgres
```

### Live Integrations
| System | Status | Auth | What It Does |
|---|---|---|---|
| **Supabase Postgres** | Active | `POSTGRES_URL` env var | 3 tables: `companies`, `company_aliases`, `categories`. Drizzle ORM, PgBouncer (`prepare: false`). |
| **HubSpot** | Active (read-only) | `HUBSPOT_API_KEY` (PAT token, `pat-na1-...`) | Contact search by company name + title. Two code paths: server-side batch in `/api/hubspot/lookup` and Claude sandbox tool in `agent.ts`. |
| **Slack** | Active | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | `@slack/web-api` for posting. Raw Next.js handler for events (not Bolt routing). Bot: "GTM Classifier", App ID: A0APF3EJCES. |
| **Vercel KV** | Active | `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Redis via `@vercel/kv`. Review state (`review:{id}`), job counters, metadata. 7-day TTL. |
| **AI Gateway** | Active | `AI_GATEWAY_API_KEY` | Routes all Claude requests for observability. Base URL: `https://ai-gateway.vercel.sh`. Model: `anthropic/claude-opus-4.6`. |

### Webhook Handlers Already Exist
`POST /api/webhook/[source]` handles inbound from:
- `common-room` -- extracts `body.company?.name`, `body.person?.title`
- `apollo` -- extracts `body.organization?.name`, `body.title`
- `hubspot` -- extracts `body.properties?.company`, `body.properties?.jobtitle`
- `default` -- generic fallback

All run through: known match check first, then Claude agent if unknown, then Slack notification. These work today but only classify -- they don't create contacts or enrich.

---

## What Exists in Code

### Key Files
| File | Purpose | Modify? |
|---|---|---|
| `src/lib/schema.ts` | Drizzle schema (3 tables today) | YES -- replace with expanded 18-table schema |
| `src/lib/db.ts` | Drizzle client (`postgres.js`, `prepare: false`) | NO -- works as-is |
| `src/lib/database.ts` | `fetchCompanyLists()` + `commitCompanyListUpdates()` | YES -- add new functions, keep existing ones |
| `src/lib/types.ts` | TypeScript interfaces | YES -- add new types for contacts, accounts, etc. |
| `src/lib/kv.ts` | KV CRUD for reviews | NO -- keep as-is for ephemeral review state |
| `src/lib/agent.ts` | Claude sandbox for classification | YES -- will need new agent functions for enrichment, meeting intel, etc. |
| `src/lib/persona.ts` | Claude sandbox for persona classification | NO initially -- works as-is |
| `src/lib/classifier.ts` | Known match + fuzzy matching logic | NO initially -- works as-is |
| `src/lib/prompts.ts` | Classification system prompt | NO initially |
| `src/lib/slack.ts` | Slack notification helpers | YES -- add new message types |
| `src/lib/completion.ts` | Job completion counter + final Slack message | MAYBE -- may need new job types |
| `src/lib/github.ts` | DEAD CODE (legacy GitHub data layer) | DELETE when convenient |
| `src/app/api/slack/events/route.ts` | Slack event handler | YES -- add new command types |
| `src/app/api/hubspot/lookup/route.ts` | HubSpot contact search | YES -- will also create/update contacts in Postgres |
| `src/app/api/webhook/[source]/route.ts` | Inbound webhooks | YES -- create contacts + accounts from webhook data |
| `src/app/api/classify/background/route.ts` | Background batch classification | MAYBE |
| `src/app/api/review/[id]/commit/route.ts` | Commit review decisions to Postgres | YES -- also commit contacts |
| `drizzle.config.ts` | Drizzle Kit config | NO -- works as-is |

### Environment Variables (already set on Vercel)
```
POSTGRES_URL                    # Supabase connection string (pooled)
POSTGRES_URL_NON_POOLING        # Direct connection for migrations
SLACK_BOT_TOKEN                 # Slack bot OAuth token
SLACK_SIGNING_SECRET            # Slack request verification
SLACK_CHANNEL_ID                # Default channel (C05UE697K41 / #sales)
AI_GATEWAY_API_KEY              # Vercel AI Gateway token
HUBSPOT_API_KEY                 # HubSpot private app token (pat-na1-...)
KV_REST_API_URL                 # Vercel KV endpoint
KV_REST_API_TOKEN               # Vercel KV auth
VERCEL_URL                      # Auto-set by Vercel (gtm-jet.vercel.app)
```

### Dependencies (already in package.json)
```
@anthropic-ai/sdk, @vercel/sandbox, @vercel/kv
@slack/web-api, @slack/bolt (bolt installed but not used for routing)
drizzle-orm, postgres, drizzle-kit
next 16.2.1, react 19.2.4
fuzzball, xlsx, officecrypto-tool, uuid
```

---

## The Schema to Implement

The complete Drizzle schema is in `docs/gtm-architecture/schema-technical.md`. It is ready to paste into `src/lib/schema.ts`.

### Summary: 18 Tables, 31 Enums, 62 Indexes

**Existing (preserved byte-for-byte):**
1. `companies` -- classification reference (305 rows: exclusions/tags/prospects)
2. `company_aliases` -- fuzzy match names
3. `categories` -- 12 category definitions

**New core:**
4. `accounts` -- companies as sales targets (enrichment, ABM tier, intent, external IDs)
5. `contacts` -- individual people (persona, sequence status, enrichment, HubSpot/Apollo IDs)
6. `opportunities` -- MEDDPIC pipeline (12 qualification columns + deal health)
7. `deals` -- closing pipeline (procurement, win/loss, expansion)
8. `contact_deal_roles` -- buying committee junction (9 roles)

**New conference:**
9. `conferences` -- event metadata
10. `conference_lists` -- uploaded CSV files with processing status
11. `list_contacts` -- junction (contact + list + `met_at_conference` flag)

**New intelligence:**
12. `signals` -- intent signals (Common Room, Bombora, G2)
13. `meetings` -- Granola transcripts, MEDDPIC extractions, briefs
14. `contact_activities` -- engagement events (10 types)

**New infrastructure:**
15. `enrichment_runs` -- Apollo/Clay enrichment log with raw payloads
16. `sync_log` -- audit trail for all external sync operations
17. `agent_runs` -- Claude execution log (tokens, model, duration)
18. `sending_accounts` -- Instantly email warmup status

---

## Implementation Phases

### Phase 1: Schema Migration (do this first, zero risk)

**Step 1: Replace schema.ts**

Copy the full Drizzle schema from `docs/gtm-architecture/schema-technical.md` into `src/lib/schema.ts`. This is the section inside the TypeScript code block. It preserves the existing 3 tables exactly as they are and adds 15 new tables.

Two minor fixes to apply from the validation report:
- Add `.references(() => accounts.id, { onDelete: "set null" })` to `accounts.referredByAccountId`
- Add `granolaMeetingId: text("granola_meeting_id")` to the `meetings` table (for dedup)

**Step 2: Push to database**

Run `npx drizzle-kit push` using `POSTGRES_URL_NON_POOLING` (direct connection, not PgBouncer -- required for DDL). This is additive only -- creates new tables and enums without touching existing ones.

```bash
POSTGRES_URL=<non-pooling-url> npx drizzle-kit push
```

**Step 3: Verify**

Query Supabase to confirm all 18 tables exist. Confirm `companies` still has 305 rows. The existing application continues to work unchanged because the 3 original tables are untouched.

**Step 4: Update db.ts import**

`src/lib/db.ts` imports `* as schema from "./schema"`. Since we're updating `schema.ts` in place, the wildcard import will pick up all new table exports automatically. No change needed to `db.ts`.

---

### Phase 2: Contact Persistence (highest impact)

Today, individual attendees from conference lists exist only in Vercel KV and expire after 7 days. This phase makes them permanent.

**What to build:**

1. **`src/lib/contacts.ts`** -- new module with functions:
   - `findOrCreateContact(data)` -- upsert by email (if available) or name+company composite
   - `findOrCreateAccount(companyName)` -- upsert by name, link to `companies` table if classification exists
   - `persistAttendees(reviewId, attendees[])` -- take the KV attendees array and write to `contacts` + `list_contacts`
   - `getContactsByAccount(accountId)` -- read contacts at a company
   - `getContactsByConference(conferenceId)` -- read contacts from a conference list

2. **Update commit flow** -- when a review is committed (`/api/review/[id]/commit`), also:
   - Create a `conferences` row if this is from a conference list
   - Create a `conference_lists` row for the uploaded file
   - For each attendee in `review.attendees`, call `findOrCreateContact()` to persist them to `contacts`
   - Link contacts to the list via `list_contacts`
   - If a contact's company matches a classification, link to the `companies` row

3. **Update HubSpot lookup** -- when `/api/hubspot/lookup` finds contacts in HubSpot, store the `hubspot_contact_id` (from the HubSpot search result, `c.id`) on the contact record. Today this data is lost after 7 days.

**Key pattern -- adapt to HubSpot, don't modify it:**

When reading from HubSpot during lookup, map whatever properties HubSpot already has:
```typescript
// READ from HubSpot, STORE in Supabase
const hubspotContact = searchResult.properties;
await upsertContact({
  email: hubspotContact.email,
  firstName: hubspotContact.firstname,
  lastName: hubspotContact.lastname,
  title: hubspotContact.jobtitle,
  companyName: hubspotContact.company,
  hubspotContactId: searchResult.id, // the HubSpot record ID
  lifecycleStage: hubspotContact.lifecyclestage,
});
```

Do NOT push data back to HubSpot in this phase. Read-only.

---

### Phase 3: Enrichment Infrastructure

This phase sets up the Apollo and Clay integration plumbing so it can be tested.

**APIs available (separate doc has the keys):**
- Apollo (Professional+): People Enrichment, Organization Enrichment, People Search
- Clay (Growth): Webhook-based (push data in, receive enriched data back)
- Granola (Business): MCP-based transcript access
- HeyReach (Standard): Manual import from Apollo/HubSpot export

**APIs NOT available yet (don't build these):**
- Common Room -- no API key yet
- Google Ads -- Data Manager API migration pending (April 1, 2026 deadline)
- LinkedIn Ads -- no direct API, goes through HubSpot native sync

**What's not ready yet in external tools:**
- Apollo sequences don't exist yet (will be built manually in Apollo UI first)
- Clay tables aren't finalized yet (webhook endpoints and field mappings TBD)

**What to build:**

1. **`src/lib/enrichment.ts`** -- new module:
   - `enrichContactViaApollo(contact)` -- call Apollo People Enrichment API, update contact fields, log to `enrichment_runs`
   - `enrichAccountViaApollo(account)` -- call Apollo Organization Enrichment API, update account fields, log to `enrichment_runs`
   - `getEnrichmentHistory(contactId | accountId)` -- read `enrichment_runs` for an entity

2. **`src/app/api/enrich/route.ts`** -- new API route:
   - Accept `{ contactId }` or `{ accountId }` or `{ email, name, company }`
   - Run Apollo enrichment
   - Return the enriched data
   - This is for testing the API integration before wiring it into the pipeline

3. **Apollo API integration pattern:**
   ```typescript
   // Apollo People Enrichment
   const res = await fetch("https://api.apollo.io/api/v1/people/match", {
     method: "POST",
     headers: {
       "Content-Type": "application/json",
       "X-Api-Key": process.env.APOLLO_API_KEY!,
     },
     body: JSON.stringify({
       first_name: contact.firstName,
       last_name: contact.lastName,
       organization_name: contact.companyName,
       email: contact.email, // optional, improves match rate
     }),
   });
   ```

4. **`enrichment_runs` logging pattern:**
   ```typescript
   await db.insert(enrichmentRuns).values({
     contactId: contact.id,
     accountId: contact.accountId,
     source: "apollo",
     status: "success",
     creditsUsed: 1,
     rawPayload: apolloResponse, // full JSON response
     completedAt: new Date(),
   });
   ```

5. **Update contacts with enrichment data:**
   Map Apollo response fields to contact columns:
   ```
   Apollo person.email           → contacts.email
   Apollo person.phone_numbers   → contacts.phone
   Apollo person.title           → contacts.title
   Apollo person.seniority       → contacts.seniority (map to enum)
   Apollo person.linkedin_url    → contacts.linkedinUrl
   Apollo person.city/state/country → contacts.city/state/country
   Apollo person.employment_history → contacts.employmentHistory (jsonb)
   Apollo organization.industry  → accounts.industry
   Apollo organization.estimated_num_employees → accounts.employeeCount
   Apollo organization.annual_revenue → accounts.annualRevenue
   Apollo organization.total_funding → accounts.totalFunding
   Apollo organization.technology_names → accounts.techStack (jsonb)
   ```

6. **Clay webhook stub** -- `src/app/api/webhook/clay/route.ts`:
   - Accept inbound Clay webhook payloads (shape TBD)
   - Parse and store enrichment data
   - Log to `enrichment_runs` with `source: "clay"`
   - This is a placeholder -- the actual Clay table and webhook URL will be configured later in the Clay UI

7. **Granola meeting stub** -- don't build a full meeting agent yet, but:
   - Create `src/lib/meetings.ts` with `createMeeting(data)` and `getMeetingsByAccount(accountId)`
   - The Granola MCP tools are available in the Claude environment but not yet wired into automated flows

---

### Phase 4: Sync Infrastructure

Build the plumbing for tracking what data flows between systems.

**What to build:**

1. **`src/lib/sync.ts`** -- new module:
   - `logSync(params)` -- write to `sync_log` table
   - `getFailedSyncs()` -- read sync_log where `success = false` and `next_retry_at <= now()`
   - `recordAgentRun(params)` -- write to `agent_runs` table

2. **Update existing HubSpot lookup to log syncs:**
   When `/api/hubspot/lookup` reads from HubSpot, log it:
   ```typescript
   await logSync({
     system: "hubspot",
     direction: "inbound",
     entityType: "contact",
     entityId: contact.id,
     externalId: hubspotContactId,
     operation: "read",
     success: true,
   });
   ```

3. **Update agent runs:**
   When classification or persona agents run, log to `agent_runs`:
   ```typescript
   const startTime = Date.now();
   // ... run sandbox ...
   await recordAgentRun({
     agentType: "classification",
     status: "success",
     model: "anthropic/claude-opus-4.6",
     inputSummary: { companies: companyNames, batchSize: 20 },
     outputSummary: { classifications: results.length, hubspotMatches: matches.length },
     durationMs: Date.now() - startTime,
     inputTokens: response.usage?.input_tokens,
     outputTokens: response.usage?.output_tokens,
     reviewId: reviewId,
   });
   ```

---

### Phase 5: Expanded Slack Commands

Add new Slack interaction patterns.

**What to build:**

1. **`enrich [company]`** command -- trigger Apollo enrichment for a company and its known contacts
2. **`status [company]`** command -- show everything we know about a company (classification, contacts, enrichment status, HubSpot presence)
3. **`contacts [conference]`** command -- show all contacts from a specific conference with persona and sequence status

These are additions to the existing `app_mention` handler in `/api/slack/events/route.ts`. The current handler parses `check [company]` and file uploads. Add new command patterns following the same structure.

---

### Phase 6: Deal Pipeline (later -- after enrichment is working)

Build opportunity and deal tracking. This depends on Phase 2 (contacts) and Phase 3 (enrichment) being complete.

**What to build:**
- `src/lib/deals.ts` -- CRUD for opportunities and deals
- MEDDPIC tracking on opportunities
- Contact-deal role associations
- Deal health scoring agent (Claude in sandbox, weekly cron via Vercel Cron)
- Slack report for deal health

This phase is not urgent. Focus on Phases 1-4 first.

---

## HubSpot Adaptation Strategy

**The principle: read from HubSpot, don't write to it yet.**

The full HubSpot sync plan (66 custom properties, 2 custom pipelines, 9 association labels) is documented in `docs/gtm-architecture/hubspot-mapping.md`. But implementing that requires creating custom properties in HubSpot, which we're deferring.

**For now:**

1. **Read standard properties** that already exist in HubSpot:
   - Contacts: `firstname`, `lastname`, `email`, `jobtitle`, `company`, `lifecyclestage`, `hs_lead_status`
   - Companies: `name`, `domain`, `industry`, `numberofemployees`, `annualrevenue`
   - Deals: `dealname`, `amount`, `dealstage`, `closedate`, `pipeline`

2. **Store HubSpot IDs** on every Supabase record that corresponds to a HubSpot record:
   - `contacts.hubspot_contact_id` = HubSpot contact ID
   - `accounts.hubspot_company_id` = HubSpot company ID
   - `opportunities.hubspot_deal_id` = HubSpot deal ID
   - `deals.hubspot_deal_id` = HubSpot deal ID

3. **Map HubSpot's existing pipeline stages** to our enums. When reading deals from HubSpot, translate their stage names to our `opportunity_stage` or `deal_stage` enums. Store the raw HubSpot stage in the sync_log changeset for audit.

4. **Don't create custom properties yet.** The schema has fields like `persona_category`, `icp_fit_score`, `meddpic_metrics_status` that will eventually be custom HubSpot properties. For now, these live only in Supabase. The HubSpot push will come later when we're ready to create those properties.

5. **Adapt to whatever HubSpot already has.** If HubSpot already has custom properties (check first!), map to them. If it has specific lifecycle stages or pipelines, use those values in our enums. Read HubSpot's property definitions via `GET /crm/v3/properties/contacts` to discover what's there before building the mapping.

---

## API Keys and External Services

### Already Connected (env vars set on Vercel)
- `HUBSPOT_API_KEY` -- HubSpot private app token
- `SLACK_BOT_TOKEN` / `SLACK_SIGNING_SECRET` -- Slack app
- `AI_GATEWAY_API_KEY` -- Vercel AI Gateway for Claude
- `POSTGRES_URL` -- Supabase Postgres
- `KV_*` -- Vercel KV (Redis)

### Available but Not Yet Connected (keys in separate doc)
These need env vars added to Vercel:
- `APOLLO_API_KEY` -- Apollo.io API key (for People/Org Enrichment, People Search)
- `GRANOLA_API_KEY` -- Granola API (or use MCP -- Granola MCP is already available in Claude environment)
- `HEYREACH_API_KEY` -- HeyReach API (for LinkedIn automation -- limited API, mostly manual)
- `CLAY_WEBHOOK_URL` -- Clay inbound webhook URL (not an API key -- Clay uses webhook-based integration)

### Not Available Yet (don't build these)
- Common Room API -- no key, webhook handler already exists as a placeholder
- Google Ads API -- Data Manager API migration pending (deadline April 1, 2026)
- LinkedIn Ads API -- goes through HubSpot native sync, not direct API
- Instantly API -- no key yet (for email warmup tracking)

### External Tools Not Ready Yet
- **Apollo sequences** -- the sequence templates (L&D, QA, Ops, Website Visitor, Re-engagement, Multi-thread) need to be created manually in the Apollo UI first. Don't build sequence enrollment until they exist.
- **Clay tables** -- the enrichment tables in Clay need to be configured manually. The webhook URLs and field mappings will come from that setup. Build the webhook handler stub but don't expect it to work end-to-end yet.

---

## Testing Strategy

### Phase 1 Testing (Schema)
- Deploy to Vercel
- Upload a conference list via Slack
- Verify the existing classification pipeline still works (known matching, Claude classification, HubSpot lookup, persona, review page, commit)
- Check that new tables exist in Supabase with zero rows (query any new table to confirm)

### Phase 2 Testing (Contacts)
- Upload a conference list
- After commit, verify contacts exist in the `contacts` table
- Verify the conference and conference_list rows were created
- Verify list_contacts junction records link contacts to the list
- Verify HubSpot contact IDs are stored when HubSpot matches are found

### Phase 3 Testing (Enrichment)
- Call the new `/api/enrich` endpoint with a known contact
- Verify Apollo returns enrichment data
- Verify the data is written to the contact and account records
- Verify an `enrichment_runs` row was created with the raw payload
- Test with a contact that has no email (name + company only)
- Test with a contact at an unknown company (should create an account)

### Phase 4 Testing (Sync)
- Verify `sync_log` rows are created during HubSpot lookups
- Verify `agent_runs` rows are created during classification
- Check token counts and duration tracking

---

## Reference Documents

| Document | Path | What It Contains |
|---|---|---|
| **Complete Drizzle schema** | `docs/gtm-architecture/schema-technical.md` | Full TypeScript code -- 31 enums, 18 tables, 62 indexes. Copy into `src/lib/schema.ts`. |
| **Schema overview (business)** | `docs/gtm-architecture/schema-overview.md` | Plain-English description of every table, relationships, design decisions |
| **HubSpot field mapping** | `docs/gtm-architecture/hubspot-mapping.md` | 66 custom properties, sync triggers, conflict resolution (defer implementation -- just read from HubSpot for now) |
| **Validation report** | `docs/gtm-architecture/validation-report.md` | 21 workflows traced through schema, all PASS |
| **Strategy analysis** | `docs/gtm-architecture/analysis/strategy-analysis.md` | 17 entities, 17 integrations, 21 workflows extracted from strategy doc |
| **Current state map** | `docs/gtm-architecture/analysis/current-state.md` | What's in Postgres, KV, and code today |
| **Integration mapping** | `docs/gtm-architecture/analysis/integration-mapping.md` | Field-level data flows between all systems |
| **GTM strategy** | `reddy-gtm-strategy.md` | The full GTM strategy document (source of truth for what we're building toward) |
| **Original design spec** | `docs/superpowers/specs/2026-03-28-company-classification-system-design.md` | The v2 classification system design (already built) |

---

## What NOT to Do

1. **Don't modify HubSpot.** No creating custom properties, pipelines, association labels, or workflows. Read from HubSpot, store in Supabase. We'll push to HubSpot later.

2. **Don't build Common Room, Google Ads, or LinkedIn Ads integrations.** No API keys available.

3. **Don't build Apollo sequence enrollment.** The sequences don't exist in Apollo yet.

4. **Don't build Clay enrichment end-to-end.** The Clay tables aren't finalized. Build the webhook handler stub only.

5. **Don't break the existing classification pipeline.** It works end-to-end. The 3 existing Postgres tables must remain byte-for-byte compatible. `fetchCompanyLists()` and `commitCompanyListUpdates()` must continue to work.

6. **Don't run Claude on the server.** All Claude work goes through Vercel Sandbox. Server-side code handles routing, Postgres, KV, and external API calls.

7. **Don't send multiple Slack messages.** One combined message per operation. Use the existing job completion counter pattern in `completion.ts`.

8. **Don't use `@anthropic-ai/claude-agent-sdk`.** Use `@anthropic-ai/sdk` inside sandboxes. This is a known gotcha (see `memory/project_sandbox_learnings.md`).

9. **Don't hardcode the AI Gateway model string.** Use `"anthropic/claude-opus-4.6"` for classification/complex reasoning and `"anthropic/claude-sonnet-4.6"` for persona tagging. These go through `ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh"`.

10. **Don't delete `src/lib/github.ts` yet.** It's dead code but harmless. Clean it up when convenient, not as part of the schema migration.

---

## Priority Order

```
Phase 1: Schema migration        ← Do first. Zero risk. Unblocks everything.
Phase 2: Contact persistence      ← Highest value. Makes attendees permanent.
Phase 3: Enrichment infra         ← Set up Apollo API. Test it. Clay stub only.
Phase 4: Sync infrastructure      ← Audit trail. Adds observability.
Phase 5: Expanded Slack commands  ← New user-facing capabilities.
Phase 6: Deal pipeline            ← Later. Depends on 2+3 being solid.
```

Phase 1 can be done in a single session. Phase 2 is the most code-intensive. Phase 3 is where you'll need the external API keys.
