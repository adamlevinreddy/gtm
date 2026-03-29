# GTM System Current State Analysis

Generated: 2026-03-29

---

## 1. Postgres Tables (Supabase via Drizzle ORM)

Connection: `POSTGRES_URL` env var, PgBouncer-compatible (`prepare: false`).
Config: `drizzle.config.ts` points to `src/lib/schema.ts`, outputs to `./drizzle/`.

### 1.1 `companies` table

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `id` | `serial` | PK | Auto-increment |
| `name` | `text` | NOT NULL | Company display name |
| `action` | `pgEnum("action")` | NOT NULL | `"exclude"` / `"tag"` / `"prospect"` |
| `category` | `text` | nullable | Slug like `"ccaas"`, `"bpo"`. Null for prospects. |
| `category_label` | `text` | nullable | Human-readable label. Often null -- commit flow passes `null` for categoryLabel. |
| `added` | `date` | NOT NULL | ISO date string of when the row was inserted |
| `source` | `text` | NOT NULL | Origin (e.g., conference file name) |
| `note` | `text` | nullable | Used for prospects and rejected-classification notes |

**Who writes:** `commitCompanyListUpdates()` in `src/lib/database.ts`, called from `POST /api/review/[id]/commit`. Inserts one row per accepted or rejected classification decision. Rejected items are stored as `action: "prospect"` with a note explaining the rejected Claude classification.

**Who reads:** `fetchCompanyLists()` in `src/lib/database.ts`, called at the start of every classification flow (Slack events, `/api/classify`, `/api/webhook/[source]`). Reads the full table with a LEFT JOIN to `company_aliases`.

### 1.2 `company_aliases` table

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `id` | `serial` | PK | Auto-increment |
| `company_id` | `integer` | NOT NULL | FK to `companies.id`, CASCADE delete |
| `alias` | `text` | NOT NULL | Alternative name for fuzzy matching |

**Who writes:** Nothing in the current codebase writes aliases. The table exists but `commitCompanyListUpdates()` only inserts into `companies` -- it never creates alias rows.

**Who reads:** `fetchCompanyLists()` LEFT JOINs this table and includes aliases in the returned data structures. The `CompanyClassifier` uses them for exact and fuzzy matching.

### 1.3 `categories` table

| Column | Type | Nullable | Notes |
|--------|------|----------|-------|
| `slug` | `text` | PK | e.g., `"ccaas"`, `"bpo"` |
| `label` | `text` | NOT NULL | Human-readable label |
| `action` | `pgEnum("action")` | NOT NULL | `"exclude"` or `"tag"` |

**Who writes:** Nothing in the current codebase. This table must be populated manually or via migration.

**Who reads:** `fetchCompanyLists()` reads all categories to build `exclusionCategories` and `tagCategories` maps used by the classifier.

### 1.4 `action` enum

Defined as `pgEnum("action", ["exclude", "tag", "prospect"])`. Used by both `companies.action` and `categories.action`.

---

## 2. Vercel KV State (Redis)

All KV usage goes through `@vercel/kv`. TTL is universally 7 days (604800 seconds).

### 2.1 `review:{uuid}` -- Main Review Object

**Type:** `ReviewData` (defined in `src/lib/types.ts`)

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | UUID v4 |
| `source` | `string` | File name or origin label |
| `createdAt` | `string` | ISO timestamp |
| `status` | `"pending"` / `"submitted"` / `"committed"` | Workflow state |
| `items` | `ReviewItem[]` | Companies Claude classified (starts empty, appended by background batches) |
| `knownResults` | `ClassificationResult[]` | Companies matched from known lists (set once at creation) |
| `decisions` | `Record<string, "accept" \| "reject"> \| null` | Human decisions, set on submit |
| `commitSummary` | `{ exclusionsAdded, tagsAdded, prospectsAdded } \| null` | Set after commit |
| `hubspotMatches` | `HubSpotCompanyMatch[] \| undefined` | Appended by both HubSpot lookup and classification background jobs |
| `attendees` | `Array<{ company, title, persona, inHubspot, hubspotName? }> \| undefined` | All conference attendees with persona + HubSpot status. Appended by HubSpot lookup route. |

**Created by:** `createReview()` in `src/lib/kv.ts`, called from Slack events handler and `/api/classify`.

**Updated by:**
- `POST /api/classify/background` -- appends to `items` and `hubspotMatches`
- `POST /api/hubspot/lookup` -- appends to `hubspotMatches` and `attendees`
- `submitDecisions()` -- sets `decisions` and `status = "submitted"`
- `markCommitted()` -- sets `commitSummary` and `status = "committed"`

**Read by:**
- `GET /api/review/[id]` -- serves the full object to the review UI
- `markJobComplete()` in `completion.ts` -- reads for final Slack message stats
- Various update flows (read-modify-write pattern)

**TTL:** 7 days. After that, review data is gone.

#### `ReviewItem` shape (within `items[]`)

| Field | Type |
|-------|------|
| `name` | `string` |
| `titles` | `string[]` |
| `action` | `"exclude"` / `"tag"` / `"prospect"` |
| `category` | `string \| null` |
| `rationale` | `string \| null` |

#### `ClassificationResult` shape (within `knownResults[]`)

| Field | Type |
|-------|------|
| `name` | `string` |
| `action` | `"exclude"` / `"tag"` / `"prospect"` |
| `category` | `string \| null` |
| `confidence` | `"known"` / `"claude"` |
| `rationale` | `string \| null` |

#### `HubSpotCompanyMatch` shape (within `hubspotMatches[]`)

| Field | Type |
|-------|------|
| `company` | `string` |
| `contacts` | `Array<{ name, email, title, persona? }>` |

#### Attendee shape (within `attendees[]`)

| Field | Type |
|-------|------|
| `company` | `string` |
| `title` | `string` |
| `persona` | `Persona` (one of 9 enum values) |
| `inHubspot` | `boolean` |
| `hubspotName` | `string \| undefined` |

### 2.2 `review:{uuid}:meta` -- Completion Metadata

**Shape:** `ReviewMeta` (defined inline in `completion.ts`)

| Field | Type |
|-------|------|
| `totalCompanies` | `number` |
| `excludedCount` | `number` |
| `taggedCount` | `number` |
| `unknownCount` | `number` |
| `totalJobs` | `number` |
| `slackChannel` | `string` |
| `slackThreadTs` | `string` |

**Created by:** Slack events handler, right after `createReview()`.
**Read by:** `markJobComplete()` to determine if all background jobs are done and to construct the final Slack message.
**Deleted by:** `markJobComplete()` after all jobs complete.
**TTL:** 7 days (safety net; normally deleted within minutes).

### 2.3 `review:{uuid}:completed-jobs` -- Completion Counter

**Type:** Integer (incremented via `kv.incr()`).
**Created by:** `markJobComplete()` increments on each call.
**Read by:** `markJobComplete()` compares to `meta.totalJobs`.
**Deleted by:** `markJobComplete()` after all jobs complete.
**TTL:** None explicitly set (relies on meta key TTL for cleanup).

### 2.4 `review:{uuid}:error:{batchIndex}` -- Error Messages

**Type:** String (error message, truncated to 500 chars).
**Created by:** `POST /api/classify/background` when classification fails.
**Read by:** Nothing in the current codebase reads these.
**TTL:** 1 hour.

---

## 3. Ephemeral Data (Never Persisted)

### 3.1 Slack File Content
- CSV/XLSX files uploaded to Slack are downloaded, parsed into `CompanyWithTitles[]`, then the buffer is discarded.
- The raw file bytes, decrypted content, and parsed spreadsheet are all in-memory only.
- The file's name is preserved as `review.source`.

### 3.2 Claude Sandbox Output
- The classification agent runs in a Vercel Sandbox (`@vercel/sandbox`).
- The full Claude conversation (system prompt, tool calls, thinking blocks) is lost.
- Only the final JSON output (stdout) is parsed and kept.
- Stderr is checked for errors but not stored (except batch error keys in KV).

### 3.3 Persona Classification Raw Output
- `classifyPersonas()` runs Claude Sonnet in a sandbox.
- The full response is discarded; only the parsed `{ title -> persona }` map is kept.
- The map itself is used inline and attached to the review's `attendees[]` array, but never stored as a standalone entity.

### 3.4 HubSpot API Responses
- Full contact records from HubSpot (lifecycle stage, lead status, email) are fetched but only partially stored.
- The agent's HubSpot tool fetches: `firstname`, `lastname`, `email`, `jobtitle`, `company`, `lifecyclestage`, `hs_lead_status`.
- What gets kept: `name`, `email`, `title` (in `hubspotMatches`).
- What gets discarded: `lifecyclestage`, `hs_lead_status`, `company` (the company name from HubSpot).
- The HubSpot lookup route (`/api/hubspot/lookup`) also fetches contacts but only keeps `name`, `title` in the matches and `hubspotName` in attendees. Email is set to `null`.

### 3.5 In-Memory Deduplication Set
- `processedEvents` in `src/app/api/slack/events/route.ts` is a `Set<string>` that prevents duplicate Slack event processing.
- This is module-level state that resets on every cold start.
- Entries auto-expire after 5 minutes via `setTimeout`.

### 3.6 CompanyClassifier Instance
- Built fresh on every request from the full Postgres dump.
- Contains in-memory fuzzy matching indexes (`fuzzball` library, threshold 90%).
- Discarded after the request completes.

### 3.7 GitHub Module (Legacy)
- `src/lib/github.ts` exists and contains `fetchCompanyLists()` and `commitCompanyListUpdates()` using Octokit.
- These functions read/write JSON files from a GitHub repo (`company-lists/exclusions.json`, `company-lists/tags.json`, `company-lists/known_prospects.json`).
- This appears to be the **old** data layer before the Postgres migration. The active `database.ts` has replaced it, but the file is still in the codebase and imports `@octokit/rest` (still in `package.json`).

---

## 4. Static Files and Configuration

### 4.1 No JSON Data Files
There are no `data/` directory or JSON config files in the `src/` tree. The old `company-lists/*.json` files mentioned in `github.ts` lived in the GitHub repo, not locally. Company data now lives entirely in Postgres.

### 4.2 Prompt Templates
- `src/lib/prompts.ts` contains `CLASSIFICATION_SYSTEM_PROMPT` (hardcoded string) and `buildClassificationPrompt()`.
- `src/lib/persona.ts` contains `PERSONA_SYSTEM_PROMPT` (hardcoded string).
- These define the 10 exclude categories, 2 tag categories, and 9 persona types.

### 4.3 Category Definitions (Hardcoded in Prompts)
The prompts define these categories, which should match the `categories` Postgres table:

**Exclude categories:** `ccaas`, `ai_voice`, `quality_analytics_wfm`, `workforce_training_km`, `consulting`, `telecom_infrastructure`, `cloud_bigtech`, `crm_saas_martech`, `compliance_security`, `self`

**Tag categories:** `bpo`, `media`

**Persona types:** `cx_leadership`, `ld`, `qa`, `wfm`, `km`, `sales_marketing`, `it`, `excluded`, `unknown`

### 4.4 Environment Variables Required

| Variable | Used By |
|----------|---------|
| `POSTGRES_URL` | `src/lib/db.ts` -- Supabase Postgres connection |
| `SLACK_BOT_TOKEN` | Slack events, completion, slack helpers |
| `SLACK_CHANNEL_ID` | `src/lib/slack.ts` -- default notification channel |
| `AI_GATEWAY_API_KEY` | Agent sandbox and persona sandbox (passed as `ANTHROPIC_AUTH_TOKEN`) |
| `HUBSPOT_API_KEY` | Agent sandbox and HubSpot lookup route |
| `GITHUB_TOKEN` | Legacy `github.ts` (likely unused now) |
| `GITHUB_OWNER` | Legacy `github.ts` |
| `GITHUB_REPO` | Legacy `github.ts` |
| `GITHUB_BRANCH` | Legacy `github.ts` |
| `VERCEL_URL` | `src/lib/slack.ts` (auto-set by Vercel) |

---

## 5. Complete Data Flows

### 5.1 File Classification via Slack (Primary Flow)

```
Slack @mention "classify this" + file attachment
  |
  v
POST /api/slack/events (maxDuration: 60s)
  |-- Dedup check (in-memory Set)
  |-- Download file from Slack (Bearer token)
  |-- Decrypt if encrypted (officecrypto-tool)
  |-- Parse CSV/XLSX -> CompanyWithTitles[] (xlsx library)
  |-- Fetch all companies from Postgres (fetchCompanyLists)
  |-- Build CompanyClassifier (fuzzball fuzzy matching)
  |-- Split into knownResults[] and unknowns[]
  |-- Create ReviewData in KV (status: "pending", items: [])
  |-- Store ReviewMeta in KV (for completion tracking)
  |-- Add hourglass emoji to Slack message
  |
  |-- Fire-and-forget: POST /api/hubspot/lookup
  |     |-- For each non-excluded company: search HubSpot contacts API
  |     |-- Filter to exact title matches from conference list
  |     |-- Classify ALL titles with persona sandbox (Claude Sonnet)
  |     |-- Build attendees[] array (every company+title with persona + HubSpot status)
  |     |-- Append hubspotMatches and attendees to KV review
  |     |-- Call markJobComplete() (1 job)
  |
  |-- Fire-and-forget: POST /api/classify/background (x N batches of 20)
        |-- For each batch: run classifyWithAgent() in Vercel Sandbox
        |     |-- Install Claude Code CLI + SDK in sandbox
        |     |-- Write classification script with HubSpot tool
        |     |-- Claude Opus classifies companies with tool-use loop
        |     |-- Claude can call search_hubspot tool for prospect companies
        |     |-- Post-filter HubSpot results to exact title matches
        |     |-- Parse JSON output -> classifications + hubspot_matches
        |-- Append new ReviewItems to KV review
        |-- Append any hubspotMatches to KV review
        |-- Call markJobComplete() (1 job per batch)

When all jobs complete (markJobComplete counter == totalJobs):
  |-- Delete counter and meta from KV
  |-- Read final review from KV
  |-- Compose summary Slack message with stats
  |-- Post threaded reply in Slack
  |-- Swap hourglass -> checkmark emoji
```

### 5.2 Quick Check via Slack

```
Slack @mention "check <company>"
  |
  v
POST /api/slack/events
  |-- Add eyes emoji
  |-- Fetch companies from Postgres
  |-- Build CompanyClassifier
  |-- classifyKnown() -- exact + fuzzy match only, no Claude
  |-- Post result in Slack thread
  |-- Swap eyes -> checkmark
```

### 5.3 API Classification (Non-Slack)

```
POST /api/classify
  |-- mode: "quick" -> single company lookup (known + Claude fallback)
  |-- mode: "batch" or file upload -> full classification pipeline
  |     |-- Same known/unknown split as Slack flow
  |     |-- But runs Claude classification synchronously (not background batches)
  |     |-- No HubSpot lookup or persona classification
  |     |-- Sends Slack notification with review link
  |     |-- Returns reviewId + stats
```

### 5.4 Webhook Classification

```
POST /api/webhook/[source] (source: common-room, apollo, hubspot, generic)
  |-- Extract company name + titles from webhook payload
  |-- Known-match check first
  |-- If unknown: classify with Claude agent (single company)
  |-- Post result to Slack
  |-- Return result as JSON
  |-- No review created, no persistence
```

### 5.5 Human Review + Commit

```
Browser: GET /review/{id}
  |-- Fetch ReviewData from GET /api/review/[id]
  |-- Display Classification tab:
  |     |-- Collapsible sections for known excluded/tagged
  |     |-- Review table for Claude suggestions (exclude/tag only)
  |     |-- Prospect suggestions shown as info, not reviewable
  |-- Display Attendees tab:
  |     |-- Table of all attendees with persona, HubSpot status
  |     |-- Excluded personas filtered out
  |-- User accepts/rejects each Claude suggestion
  |
  v
POST /api/review/[id]/submit
  |-- Save decisions to KV (status -> "submitted")
  |
  v
POST /api/review/[id]/commit
  |-- For each accepted item: insert into Postgres companies table
  |-- For each rejected item: insert as prospect with note
  |-- Update KV status -> "committed" with summary
  |-- Send Slack commit confirmation
```

---

## 6. Data Gaps and Pain Points

### 6.1 Attendees Not in Postgres
Individual attendees (person + title + company + persona) are stored only in KV `ReviewData.attendees`. After the 7-day TTL expires, all attendee data is lost. There is no `attendees` or `contacts` table in Postgres. This means:
- No historical record of who attended which conference
- No way to query "show me all L&D personas we've seen"
- No way to track if an attendee was later contacted

### 6.2 HubSpot Contact IDs Not Stored
The system searches HubSpot by company name and matches by title, but never stores the HubSpot contact ID (`hs_object_id`). This means:
- No way to link a review attendee back to a specific HubSpot record
- No deduplication across reviews (same person at different conferences)
- The HubSpot lookup discards `lifecyclestage` and `hs_lead_status` which could be valuable

### 6.3 Persona Classifications Ephemeral
Persona classifications exist only in the KV review object's `attendees[]` array. They are not stored in Postgres. Once the review expires from KV, all persona data is gone.

### 6.4 No Enrichment Status Tracking
There is no field or table tracking whether a prospect company has been enriched, contacted, or followed up on. The `companies` table tracks what category a company falls into but not what happened after classification.

### 6.5 Review Data Expires After 7 Days
All review data (Claude classifications, HubSpot matches, attendees, decisions) lives only in KV with a 7-day TTL. After commit, the only durable record is the rows inserted into `companies`. The full context (which attendees, which titles, what Claude said, what HubSpot showed) is lost.

### 6.6 Aliases Never Written
The `company_aliases` table exists in the schema and is read by `fetchCompanyLists()`, but `commitCompanyListUpdates()` never creates alias rows. Aliases from the old JSON files may have been migrated in, but new companies committed through the review flow will never have aliases. This degrades fuzzy matching over time.

### 6.7 `category_label` Never Populated
The commit flow in `/api/review/[id]/commit` passes `categoryLabel: null` for every insert. The column exists but is never populated through the normal workflow.

### 6.8 Categories Table Not Auto-Populated
The `categories` table stores category definitions but nothing in the application code writes to it. It must be manually seeded. If Claude invents a new category slug that is not in this table, it will still be stored in `companies.category` but will not appear in the category lookups.

### 6.9 Duplicate HubSpot Searches
HubSpot contacts are searched in two independent places:
1. The agent sandbox script (`src/lib/agent.ts`) -- Claude calls `search_hubspot` tool during classification
2. The server-side HubSpot lookup route (`/api/hubspot/lookup`) -- direct API calls

Both append to `review.hubspotMatches`, which can produce duplicates. The sandbox search runs for prospect companies during classification; the lookup route runs for all non-excluded companies. There is no deduplication.

### 6.10 Fire-and-Forget Background Jobs
Background classification and HubSpot lookup jobs are triggered via `fetch()` with `.catch(() => {})`. If the target URL is unreachable (e.g., cold start timeout, deployment issue), the job silently fails. The completion counter will never reach `totalJobs`, and the user will see a perpetual hourglass emoji. Error keys are stored in KV but nothing reads them.

### 6.11 In-Memory Dedup is Not Durable
The `processedEvents` Set in the Slack events handler resets on every cold start. In a serverless environment, this means the same event could be processed multiple times if it arrives during different function invocations. The 5-minute timeout also means long-running retries from Slack could slip through.

### 6.12 Legacy GitHub Module Still Present
`src/lib/github.ts` and `@octokit/rest` dependency are still in the codebase. The active `database.ts` has the same function names (`fetchCompanyLists`, `commitCompanyListUpdates`) with different signatures. All imports in routes point to `database.ts`, making `github.ts` dead code.

### 6.13 Synchronous vs. Background Classification Split
The `/api/classify` route runs Claude classification synchronously (up to 300s timeout), while the Slack flow runs it as background batches. The synchronous path does not do HubSpot lookup or persona classification. This means API-triggered classifications produce less data than Slack-triggered ones.

### 6.14 No Test Coverage
There are no test files in the `src/` directory. The `package.json` has vitest configured but no tests exist.

### 6.15 Hardcoded Base URL
The Slack events handler hardcodes `https://gtm-jet.vercel.app` as the base URL for fire-and-forget fetch calls and review links in the completion message. The `/api/classify` route and `slack.ts` use `process.env.VERCEL_URL` instead. This inconsistency means preview deployments would still fire background jobs to production.

---

## 7. File Inventory

### Core Library (`src/lib/`)
| File | Purpose | Status |
|------|---------|--------|
| `schema.ts` | Drizzle schema (3 tables + 1 enum) | Active |
| `types.ts` | TypeScript interfaces | Active |
| `db.ts` | Postgres connection via `postgres` + `drizzle-orm` | Active |
| `database.ts` | Read/write companies from Postgres | Active |
| `kv.ts` | CRUD for ReviewData in Vercel KV | Active |
| `classifier.ts` | Known-company matching (exact + fuzzy) | Active |
| `agent.ts` | Claude sandbox classification with HubSpot tools | Active |
| `persona.ts` | Claude sandbox persona classification | Active |
| `completion.ts` | Job completion counter + final Slack message | Active |
| `prompts.ts` | Classification system prompt + builder | Active |
| `slack.ts` | Slack notification helpers | Active |
| `parse-upload.ts` | CSV/XLSX parsing with column detection | Active |
| `github.ts` | Legacy GitHub-based company list read/write | **Dead code** |

### API Routes (`src/app/api/`)
| Route | Method | maxDuration | Purpose |
|-------|--------|-------------|---------|
| `/api/slack/events` | POST | 60s | Slack event handler (entry point) |
| `/api/classify` | POST | 300s | API classification (sync) |
| `/api/classify/background` | POST | 300s | Background classification batch |
| `/api/hubspot/lookup` | POST | 300s | HubSpot + persona classification |
| `/api/webhook/[source]` | POST | 60s | Webhook classification |
| `/api/review/[id]` | GET | default | Fetch review data |
| `/api/review/[id]/submit` | POST | default | Submit human decisions |
| `/api/review/[id]/commit` | POST | 60s | Commit to Postgres |

### Frontend Pages (`src/app/`)
| Route | Purpose |
|-------|---------|
| `/` | Static landing page ("Reddy GTM Tools -- active") |
| `/review/[id]` | Review UI with Classification and Attendees tabs |

### Components (`src/components/`)
| File | Purpose |
|------|---------|
| `review-table.tsx` | Accept/reject table for Claude suggestions |
| `submit-button.tsx` | Submit + commit button with loading states |

### Config
| File | Purpose |
|------|---------|
| `drizzle.config.ts` | Drizzle Kit config for migrations |
| `package.json` | 16 runtime deps, 10 dev deps |

---

## 8. Dependency Map

```
Slack Events Handler
  |-- fetchCompanyLists() --> Postgres (companies + aliases + categories)
  |-- CompanyClassifier --> fuzzball (fuzzy matching)
  |-- parseUploadedFile() --> xlsx (spreadsheet parsing)
  |-- officecrypto-tool (file decryption)
  |-- createReview() --> Vercel KV
  |-- kv.set() --> Vercel KV (meta)
  |-- fire-and-forget --> /api/hubspot/lookup
  |-- fire-and-forget --> /api/classify/background (x N)

Background Classification
  |-- classifyWithAgent() --> Vercel Sandbox
  |     |-- @anthropic-ai/sdk (inside sandbox)
  |     |-- HubSpot Search API (inside sandbox, via fetch)
  |-- kv.set() --> Vercel KV (update review)
  |-- markJobComplete() --> Vercel KV (counter + meta)

HubSpot Lookup
  |-- HubSpot Search API (direct, server-side)
  |-- classifyPersonas() --> Vercel Sandbox
  |     |-- @anthropic-ai/sdk (inside sandbox, Sonnet model)
  |-- kv.set() --> Vercel KV (update review)
  |-- markJobComplete() --> Vercel KV (counter + meta)

Review Commit
  |-- getReview() --> Vercel KV
  |-- commitCompanyListUpdates() --> Postgres
  |-- markCommitted() --> Vercel KV
  |-- sendCommitConfirmation() --> Slack API
```
