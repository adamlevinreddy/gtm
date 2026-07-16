# GTM Strategy Analysis

> Extracted from `reddy-gtm-strategy.md`, company classification specs, and project memory files
> Generated: 2026-03-29

---

## 1. Entities

Every data record (noun) that the GTM system creates, stores, or references.

| Entity | Owner / Source of Truth | Created By | Consumed By | Key Fields |
|---|---|---|---|---|
| **Company** | HubSpot (CRM), Supabase (classification) | Conference lists, Apollo enrichment, Common Room signals, ABM targeting | All workflows, classification, enrichment, outreach, deal creation | name, aliases, category, account_tier, account_status, icp_fit_score, tech_stack_known, competitor_present, compelling_event, last_enrichment_date, intent_signals, stakeholder_count |
| **Contact** | HubSpot (CRM), Apollo (prospecting) | Conference lists, Apollo People Search, Common Room person-level ID, website visitors | Sequences, enrichment, meeting intelligence, MEDDPIC multi-threading | name, title, email, phone, linkedin_url, persona_category, buying_role, seniority_level, lead_source, sequence_status, engagement_score, outreach_priority, apollo_contact_id |
| **Deal (Opportunity Pipeline)** | HubSpot | Conference pipeline, website visitor pipeline, ABM targeting | MEDDPIC qualification, deal health scoring, multi-threading | 6 MEDDPIC status/detail pairs, meddpic_completion_score, deal_health_score, days_in_current_stage, single_thread_risk, competitor_in_evaluation, next_step, champion_engaged |
| **Deal (Deal Pipeline)** | HubSpot | Conversion from Opportunity Pipeline when all 6 MEDDPIC validated | Closing process, procurement, champion enablement | procurement_status, security_questionnaire_sent/completed, contract_type, decision_date_target, budget_confirmed, close_confidence, lost_reason, expansion_potential, land_use_case |
| **Sequence** | Apollo (created in UI, enrolled via API) | Pre-built in Apollo UI (L&D, QA, Ops, Website Visitor, Re-engagement, Multi-thread) | Conference pipeline, website visitor, ABM, re-engagement | sequence name, enrollment status, engagement metrics (opens, clicks, replies) |
| **Exclusion** | Supabase Postgres (was GitHub JSON) | Classification pipeline (known matching + Claude agent + human review) | All inbound list processing, ad platform blacklists | name, aliases, category (10 categories), added date, source |
| **Tag (BPO/Media)** | Supabase Postgres (was GitHub JSON) | Classification pipeline | Outreach routing (different messaging for BPOs vs direct prospects) | name, aliases, category (bpo, media), added date, source |
| **Known Prospect** | Supabase Postgres (was GitHub JSON) | Human confirmation during review | Prevents Claude from re-flagging confirmed prospects on future lists | name, aliases, added date, source, note |
| **Classification Review** | Vercel KV (ephemeral) | Classification pipeline (Slack upload, webhook, or API trigger) | Review UI, human reviewers, commit-to-database flow | id, source, status (pending/submitted/committed), items[], knownResults[], decisions, commitSummary |
| **Category** | Supabase Postgres | System setup (10 exclusion categories, 2 tag categories) | Classification matching and labeling | key, label, action (exclude or tag) |
| **Conference** | Manual input / HubSpot | Leadership decision, event registration | Conference pipeline (pre and post flows) | conference_name, date, attendee list (CSV) |
| **Meeting Transcript** | Granola (primary), Apollo CI (in-product) | Automatic recording during calls | Pre-meeting brief agent, post-meeting follow-up agent, MEDDPIC extraction | transcript text, summary, action items, attendees, date |
| **Task** | HubSpot | Meeting follow-up agent, deal management workflows | Sales team execution | description, due date, associated deal/contact, status |
| **Email Draft** | Gmail | Meeting follow-up agent, Claude voice-matched drafting | Human review and sending | subject, body, recipients, thread reference |
| **Mutual Action Plan** | Claude-generated | Auto-generated when deal enters Deal Pipeline | Champion enablement, deal tracking | milestones, timeline, customized per deal |
| **Battlecard** | Claude-generated, maintained from win/loss data | Win/loss analysis, competitive intel from meetings | Sales prep, deal strategy | competitor name, strengths, weaknesses, counter-arguments |
| **Voice/Tone Guide** | Claude-generated from sent email analysis | One-time creation from Gmail sent mail analysis | Meeting follow-up email drafting | sentence length patterns, word choice, tone, formality level, sign-off style |
| **ICP Fit Score** | Calculated (Claude + rules) | Enrichment engine | Prioritization, sequence selection, account tiering | numeric score based on company size, industry, seniority |
| **Deal Health Score** | Calculated weekly | Deal Health agent | Weekly Slack report, at-risk flagging | composite 0-100 from 6 weighted factors |
| **Persona Classification** | Claude (Sonnet) in Vercel Sandbox | Classification pipeline (title analysis) | Sequence routing, outreach personalization, review UI | 7 personas: CX/CC Leadership, L&D, QA Ops, WFM, KM, Sales & Marketing, IT/Technology |

---

## 2. Integrations

Every external system referenced in the strategy, with data flow direction and connection method.

| Integration | Role | Data Flows IN (from tool) | Data Flows OUT (to tool) | Connection Method | Sync Direction |
|---|---|---|---|---|---|
| **HubSpot** (Professional) | CRM, source of truth | Contact/company/deal records, lifecycle stages, pipeline stages, engagement data, association labels | New contacts, companies, deals, MEDDPIC updates, deal stage changes, tasks, property updates | `shinzo-labs/hubspot-mcp` (112 tools), native Apollo sync, native Clay integration, native Common Room integration | Bidirectional |
| **Apollo** (Professional+) | Prospecting, enrichment, sequences, conversation intelligence | People Search results, enrichment data (email, phone, title, seniority, department, LinkedIn, employment history), Organization enrichment (industry, size, revenue, funding, tech stack), engagement metrics (opens, clicks, replies), meeting recordings/transcripts/summaries | Sequence enrollment, contact creation (bulk 100/call), enrichment requests (1 credit/person, bulk 10/call) | `Chainscore/apollo-io-mcp` (45 tools), native HubSpot sync | Bidirectional |
| **Clay** (Growth) | Deep waterfall enrichment (150+ sources) | Enriched data: verified email, phone, tech stack, funding, hiring signals, competitive tech detection, intent signals, Claygent AI research | Account/contact data pushed via webhook (POST JSON, 50K row limit) | Webhook in, HTTP action out, HubSpot native integration | Bidirectional (webhook-based) |
| **Common Room** (Starter) | Signal intelligence, person-level website visitor ID | Person-level visitor identification (50% US), company-level ID, Bombora intent data, 50+ signal channels, high-intent visitor alerts, RoomieAI agent alerts | Classification results (via webhook response) | `chris-trag/commonroom-mcp` (10 tools), JS snippet on website, native Apollo integration, native HubSpot integration, Slack alerts | Mostly inbound; limited pull API, webhooks for outbound triggers |
| **Slack** | Primary human interface, approval workflows, notifications | Slack commands ("classify this", "check [company]", "status of review"), file uploads (CSV/XLSX), approval responses | Classification summaries, review links, deal health reports, meeting briefs, agent notifications, approval requests | `@slack/bolt` + `@vercel/slack-bolt`, Slack MCP (official, 12 tools) | Bidirectional |
| **Granola** (Business) | Meeting transcript access for Claude agents | Meeting transcripts, summaries, natural language query results | Queries (search by contact/company) | Granola MCP (official, 5 tools) | Inbound (read-only) |
| **Gmail** | Email drafts, voice analysis | Sent emails (for voice/tone analysis), thread context | Follow-up email drafts (via `drafts.create`) | `taylorwilsdon/google_workspace_mcp` | Bidirectional |
| **Google Calendar** | Meeting scheduling, attendee data | Upcoming events, attendee emails | None (read-only by agents) | `taylorwilsdon/google_workspace_mcp` | Inbound (read-only) |
| **Google Ads** | Search + remarketing campaigns | Campaign performance data, reporting | Customer Match audiences (from HubSpot lists), campaign management | `googleads/google-ads-mcp` (official), HubSpot native list sync | Outbound-primary (audiences + campaigns out, reporting in) |
| **LinkedIn** (Sales Nav + Ads) | Manual research, ad campaigns, connection requests | Ad campaign reporting | Matched Audiences (from HubSpot lists), awareness campaigns | LinkedIn Marketing API (ads), HeyReach (automation), HubSpot native list sync | Outbound-primary |
| **HeyReach** (Standard) | LinkedIn automation | Connection acceptance data, message responses | Connection requests, follow-up messages, contact imports | Manual import from Apollo/HubSpot export (no native MCP found in strategy) | Outbound-primary |
| **Instantly** (Growth) | Email warmup before cold sending | Warmup analytics, deliverability scores, health monitoring | Warmup enable/disable, campaign management | `bcharleson/instantly-mcp` (38 tools) | Bidirectional |
| **Google Search Console** | Blog indexing, SEO | URL inspection results, sitemap status, performance data | Sitemap submissions, URL inspection requests, IndexNow submissions | `AminForou/mcp-gsc` | Bidirectional |
| **Vercel** | App hosting, serverless functions, sandbox | Deployment status | Website hosting, API routes, Sandbox for Claude Agent SDK, KV for ephemeral state | Vercel CLI, Vercel Sandbox API, Vercel KV, Vercel AI Gateway | Platform (not a data integration) |
| **Supabase** (Postgres) | Database for classification data | Company records, aliases, categories (305 companies: 201 exclusions, 101 tags, 3 prospects) | New exclusions, tags, prospects from human-reviewed classifications | Drizzle ORM, direct Postgres connection | Bidirectional (application database) |
| **GitHub** | Code repo, formerly JSON data store (migrated to Postgres) | Source code, previously JSON company lists | Code commits, PR creation | `@octokit/rest`, GitHub API | Bidirectional |
| **Zapier** (Professional) | Fallback integration glue | Varies by workflow (8000+ app connectors) | Varies by workflow | `zapier/zapier-mcp` | Bidirectional (fallback) |

---

## 3. Data Fields

### 3a. HubSpot Company Properties (Group: "ABM Intelligence")

| Property | Type | Values / Purpose |
|---|---|---|
| `account_tier` | Dropdown | Tier 1 (strategic), Tier 2 (target), Tier 3 (opportunistic) |
| `account_status` | Dropdown | Target, Prospecting, Engaged, Opportunity Open, Customer, Churned, Disqualified |
| `lead_source_original` | Dropdown | Conference, Website Visitor, ABM List, Inbound, Referral, Apollo Prospecting |
| `conference_source` | Text | Which specific conference |
| `icp_fit_score` | Number | ICP match score (calculated or manual) |
| `tech_stack_known` | Multi-line | From Clay/Apollo enrichment (BuiltWith data) |
| `competitor_present` | Dropdown | None Known, [Competitor names], Multiple |
| `compelling_event` | Text | Why buy now? (contract renewal, initiative, regulatory) |
| `compelling_event_date` | Date | When the compelling event hits |
| `warm_intro_available` | Checkbox | Someone in network knows someone there |
| `warm_intro_path` | Text | Who can intro and to whom |
| `last_enrichment_date` | Date | When data was last refreshed |
| `intent_signals` | Multi-line | Job postings, funding, G2 research, etc. |
| `account_plan_notes` | Multi-line | Strategic alignment, land-and-expand plan |
| `stakeholder_count` | Number | Contacts associated (single-thread risk indicator) |

### 3b. HubSpot Contact Properties

| Property | Type | Values / Purpose |
|---|---|---|
| `persona_category` | Dropdown | L&D, QA, Operations |
| `buying_role` | Dropdown | Champion, Economic Buyer, Technical Evaluator, End User, Coach, Blocker, Unknown |
| `seniority_level` | Dropdown | C-Suite, VP, Director, Manager, IC |
| `lead_source` | Dropdown | Conference (Pre), Conference (Post), Website Visitor, ABM, Inbound, Referral, Apollo Search |
| `conference_name` | Text | Which specific conference |
| `is_competitor` | Checkbox | For filtering |
| `is_disqualified` | Checkbox | Non-ICP |
| `disqualification_reason` | Dropdown | Competitor, Wrong Role, Wrong Company Size, Bad Fit, Other |
| `apollo_contact_id` | Text | Sync tracking |
| `linkedin_url` | Text | From enrichment |
| `enrichment_source` | Dropdown | Apollo, Clay, Manual, Conference List |
| `last_enrichment_date` | Date | Freshness tracking |
| `engagement_score` | Number | Calculated from activity |
| `sequence_status` | Dropdown | Not Sequenced, Active, Completed, Replied, Opted Out |
| `sequence_name` | Text | Which Apollo sequence |
| `outreach_priority` | Number (1-3) | Per ABM playbook ranking |

### 3c. HubSpot Deal Properties -- Opportunity Pipeline (MEDDPIC)

| Property | Type | Purpose |
|---|---|---|
| `meddpic_metrics_status` | Dropdown | Not Started, Exploring, Identified, Validated |
| `meddpic_metrics_detail` | Multi-line | What quantifiable outcomes they're trying to achieve |
| `meddpic_economic_buyer_status` | Dropdown | Not Started, Exploring, Identified, Validated |
| `meddpic_economic_buyer_detail` | Multi-line | Who signs the check, budget authority |
| `meddpic_decision_criteria_status` | Dropdown | Not Started, Exploring, Identified, Validated |
| `meddpic_decision_criteria_detail` | Multi-line | Factors they'll use to choose a vendor |
| `meddpic_decision_process_status` | Dropdown | Not Started, Exploring, Identified, Validated |
| `meddpic_decision_process_detail` | Multi-line | Buying process, who's involved, timeline |
| `meddpic_identify_pain_status` | Dropdown | Not Started, Exploring, Identified, Validated |
| `meddpic_identify_pain_detail` | Multi-line | Pain the champion feels, cost of inaction |
| `meddpic_champion_status` | Dropdown | Not Started, Exploring, Identified, Validated |
| `meddpic_champion_detail` | Multi-line | Who sells internally, their personal win |
| `meddpic_completion_score` | Number | Validated count / 6 x 100 |
| `deal_health_score` | Number | Composite 0-100 (weighted scoring) |
| `days_in_current_stage` | Number | Calculated from stage entry |
| `single_thread_risk` | Checkbox | True if only 1 contact associated |
| `competitor_in_evaluation` | Dropdown | None, [Competitor names], Unknown |
| `next_step` | Text | Agreed next action |
| `next_step_date` | Date | When |
| `last_meeting_date` | Date | From engagement tracking |
| `champion_engaged` | Checkbox | Active in last 14 days |
| `mutual_action_plan_link` | URL | Link to MAP doc |

### 3d. HubSpot Deal Properties -- Deal Pipeline (Closing)

| Property | Type | Purpose |
|---|---|---|
| `procurement_status` | Dropdown | Not Started, Security Review, Legal Review, Contract Redlines, Approved |
| `security_questionnaire_sent` | Checkbox | Did they send one? |
| `security_questionnaire_completed` | Checkbox | Did you return it? |
| `contract_type` | Dropdown | MSA + SOW, Single Agreement, PO-based |
| `decision_date_target` | Date | When they say they'll decide |
| `budget_confirmed` | Checkbox | Has budget been allocated? |
| `close_confidence` | Dropdown | High (>75%), Medium (40-75%), Low (<40%) |
| `lost_reason` | Dropdown | Price, Competitor, Timing, No Decision, Champion Left, Budget Cut, Product Gap |
| `lost_to_competitor` | Text | Which competitor |
| `win_loss_notes` | Multi-line | Learnings |
| `expansion_potential` | Dropdown | High, Medium, Low, None |
| `land_use_case` | Text | What they bought first |

### 3e. Contact-to-Deal Association Labels (Buying Committee)

- Champion
- Economic Buyer
- Technical Evaluator
- Decision Maker
- Coach / Guide
- Blocker
- End User
- Legal / Procurement
- Executive Sponsor

### 3f. HubSpot Lifecycle Stages

| Stage | Definition | Trigger |
|---|---|---|
| Subscriber | Known contact, no engagement | Added from conference list or enrichment |
| Lead | Engaged (opened email, clicked, visited site) | Apollo engagement or website activity |
| MQL | Meets ICP + engagement threshold | Lead score crosses threshold |
| SQL | Sales-accepted, meeting booked or direct conversation | Manual or meeting-booked trigger |
| Opportunity | Associated to an active Opportunity pipeline deal | Deal created |
| Customer | Closed-won deal | Deal stage = Closed Won |
| Evangelist | Active reference / referral source | Manual |

### 3g. Classification System Fields (Supabase)

| Field | Location | Type | Purpose |
|---|---|---|---|
| `name` | companies table | Text | Primary company name (canonical form) |
| `aliases` | company_aliases table | Text[] | Known spelling variants for matching |
| `category` | categories table (FK) | Text key | Category key from exclusion/tag categories |
| `action` | categories table | Enum | "exclude" or "tag" |
| `added` | companies table | Date | ISO date when entry was created |
| `source` | companies table | Text | Which list or data source triggered the addition |
| `note` | companies table (prospects) | Text | Human annotation for why confirmed as prospect |
| `confidence` | classification result | Enum | "known" (fuzzy match) or "claude" (agent-classified) |
| `rationale` | classification result | Text | Claude's reasoning for classification |

### 3h. Exclusion Categories (10)

| Key | Label |
|---|---|
| `ccaas` | CCaaS / Contact Center Platforms |
| `ai_voice` | AI / Conversational AI / Voice AI |
| `quality_analytics_wfm` | Quality / Analytics / WFM / CX Platforms |
| `workforce_training_km` | Workforce / Training / Knowledge Management |
| `consulting` | Consulting / Advisory / Systems Integrators |
| `telecom_infrastructure` | Telecom / Infrastructure Vendors |
| `cloud_bigtech` | Cloud / Big Tech (selling CX/CC solutions) |
| `crm_saas_martech` | CRM / SaaS / Marketing Tech (selling to CC) |
| `compliance_security` | Compliance / Identity / Security (selling to CC) |
| `self` | Reddy (ourselves) |

### 3i. Tag Categories (2)

| Key | Label |
|---|---|
| `bpo` | BPO / Outsourcing |
| `media` | Media / Press |

---

## 4. Workflows

### 4a. Conference Pipeline -- Pre-Conference

1. **Receive attendee list** (CSV with names, titles, companies) -- Manual
2. **Import into Apollo** via bulk People Enrichment (10/batch) -- Apollo, 1 credit/person
3. **Filter** -- remove competitors, non-ICP, irrelevant titles -- Apollo + Claude
4. **Categorize by persona** -- L&D, QA, or Operations -- Claude
5. **Prioritize contacts** (1/2/3 ranking by title fit) -- Claude
6. **HUMAN GATE: Submit to leadership for approval via Slack** -- before spending credits on reveals
7. **Reveal emails + LinkedIn URLs** for approved contacts -- Apollo (credits spent here)
8. **Create contacts in Apollo** -- Apollo API (free, bulk 100/call)
9. **Enroll in persona-specific sequence** (L&D / QA / Ops) -- Apollo API (sequences pre-built in UI)
10. **Contacts sync to HubSpot** via native integration -- automatic
11. **Create opportunity deal** in HubSpot for each target account -- HubSpot API (stage: Target Identified)

### 4b. Conference Pipeline -- Post-Conference

1. **Receive full/expanded attendee list** after event -- Manual
2. **Cross-reference** against pre-conference contacts (avoid double-sequencing) -- Apollo + Claude
3. **Enrich new contacts** not already in pipeline -- Apollo
4. **Filter competitors + non-ICP** -- same filters
5. **Tag as "met at conference" vs "did not meet"** -- HubSpot
6. **Sequence the unmet, high-priority contacts** -- Apollo ("we were both at [conference]" angle)
7. **LinkedIn connection requests** to approved contacts -- HeyReach

### 4c. Company Classification Pipeline (Currently Implemented)

1. **Input received** -- Slack file upload, webhook (Common Room/Apollo/HubSpot), or API trigger
2. **Known matching** (instant) -- Fetch exclusions/tags/prospects from Supabase (cached in KV), normalize input, exact + fuzzy match (0.90 threshold)
3. **Known exclusions** -- marked and separated in output
4. **Known tags** (BPO/Media) -- marked in output
5. **Known prospects** -- pass through clean
6. **Unknown companies** -- sent to Claude Agent SDK in Vercel Sandbox via AI Gateway for multi-step classification
7. **Store results + notify** -- Results to Vercel KV, review link posted to Slack
8. **HUMAN GATE: Human review** -- Review UI on Vercel, accept/reject per company
9. **Commit decisions** -- Accepted exclusions to exclusions table, accepted tags to tags table, rejected/prospect to known_prospects table
10. **Database update** via Drizzle ORM (was GitHub commit via Octokit)
11. **Slack confirmation** -- summary of what was committed

### 4d. Website Visitor Pipeline

1. **Visitor hits website** -- Common Room JS snippet + Apollo pixel + GTM fires all tags
2. **Common Room identifies** person (50% US) or company -- scores intent via Bombora + behavioral signals
3. **Real-time Slack alert** via RoomieAI Spark for high-intent visitors
4. **High-fit visitors auto-pushed to Apollo** via native Common Room-to-Apollo integration
5. **Apollo People Search** for company-level-only IDs -- search by target titles (L&D, QA, Ops) -- free, no credits
6. **Filter by seniority** (Director+), department, title relevance -- Claude
7. **Enrich top matches** (email, phone, LinkedIn) -- Apollo, 1 credit/person
8. **Check HubSpot** for existing contact/company -- HubSpot API
9. **HUMAN GATE: Submit new contacts for approval via Slack**
10. **Create contacts in Apollo** + enroll in "Website Visitor" sequence
11. **Sync to HubSpot** -- create opportunity if company is ICP Tier 1/2
12. **Company enters retargeting audiences** via HubSpot list sync -- auto to Google + LinkedIn

### 4e. ABM & Multi-Threading -- New Account Targeting

1. **Identify target company** (leadership decision, intent signal from Common Room, or ICP match) -- Manual + Common Room
2. **Search company in Apollo** -- pull contacts in L&D, QA, Operations -- free
3. **Export Name, Title, Company** (no email reveal yet, preserve credits) -- Apollo
4. **Prioritize by seniority + persona + fit** -- Claude
5. **HUMAN GATE: Submit to Adam/Tom for approval via Slack**
6. **Reveal emails + LinkedIn** for approved contacts -- Apollo (credits spent)
7. **Create contacts, enroll in campaign-specific sequences** -- Apollo
8. **Send LinkedIn connection requests** -- HeyReach
9. **Create opportunity in HubSpot** Opportunity Pipeline -- stage: Target Identified

### 4f. ABM & Multi-Threading -- Multi-Threading Existing Opportunities

1. **Scan HubSpot opportunities** for incomplete MEDDPIC criteria -- HubSpot API
2. **Identify missing buying committee roles** (no Champion? no Economic Buyer?) -- HubSpot + Claude
3. **Apollo People Search** at that company for matching titles -- free
4. **Enrich top candidates** -- Apollo, 1 credit each
5. **Craft personalized outreach** (reference the initiative, not cold) -- Claude
6. **Enroll in targeted multi-thread sequence** -- Apollo
7. **Associate new contacts to deal** with appropriate role label -- HubSpot Associations API
8. **Update MEDDPIC status** as new contacts engage

### 4g. ABM -- Warm Introduction Path

1. **Check network** -- does anyone know someone at the target account? -- HubSpot + LinkedIn
2. **If warm path exists** -- flag `warm_intro_available` + `warm_intro_path` in HubSpot
3. **Request intro from connector** -- Manual (highest conversion channel)
4. **Warm intro contacts fast-track** to Discovery stage (skip Target Identified + Outreach Active)

### 4h. Enrichment Engine -- Standard (Apollo, Every Contact)

1. **Input** -- name + company (or email, LinkedIn URL, domain)
2. **People Enrichment API** -- returns email, phone, title, seniority, department, LinkedIn URL, employment history -- 1 credit/person, bulk 10/call
3. **Organization Enrichment** -- returns industry, size, revenue, funding, tech stack -- 1 credit/company
4. **Classify persona** (L&D / QA / Ops) based on title + department -- Claude
5. **Score ICP fit** based on company size, industry, seniority -- write `icp_fit_score` to HubSpot
6. **Tag `last_enrichment_date`** on contact and company for freshness tracking

### 4i. Enrichment Engine -- Deep (Clay, High-Value Accounts)

1. **ONE-TIME SETUP** -- Create Clay table with enrichment columns pre-configured -- UI only
2. **Push account/contact data into Clay table** via webhook -- POST JSON, 50K row limit
3. **Clay runs waterfall enrichment** across 150+ sources (Apollo, Clearbit, Hunter, PDL, etc.)
4. **Returns** -- verified email, phone, tech stack, funding, hiring signals -- ~95% email accuracy
5. **HTTP API action pushes enriched data back to HubSpot** -- outbound webhook
6. **Use Clay for** -- competitive tech detection, intent signals, custom AI research via Claygent

### 4j. Outbound Sequences -- Email (Apollo)

1. **PRE-REQUISITE** -- Build template sequences in Apollo UI (L&D, QA, Ops, Website Visitor, Re-engagement, Multi-thread) -- cannot create via API
2. **PRE-REQUISITE** -- Warm sending mailboxes via Instantly -- enable warmup via API, monitor health scores
3. **Enroll approved contacts** in persona-specific sequence via API -- Apollo
4. **Apollo sends multi-step email sequences** from warmed mailboxes -- A/B testing, auto-pause on reply/OOO/opt-out
5. **Monitor engagement** -- opens, clicks, replies -- Apollo API
6. **Engagement data syncs to HubSpot** as activity logs -- native sync
7. **Replies** -- pause sequence, notify in Slack, create HubSpot task

### 4k. Outbound -- LinkedIn (HeyReach)

1. **Import target contacts to HeyReach** -- from Apollo/HubSpot export
2. **Send connection requests** with personalized notes -- cloud-based, profile rotation
3. **Follow-up messages** to accepted connections -- HeyReach sequences
4. **Keep under 25 connection requests/week per profile** for best acceptance rate
5. **Log LinkedIn activity to HubSpot** -- manual or via Hublead extension

### 4l. Outbound -- Ad Retargeting

1. **HubSpot contact lists auto-sync to LinkedIn Matched Audiences** -- native
2. **HubSpot contact lists auto-sync to Google Ads Customer Match** -- native (migrate to Data Manager API before April 1, 2026)
3. **Run LinkedIn awareness campaigns** to opportunity accounts -- company + persona targeting
4. **Run Google remarketing** to website visitors -- Google Ads remarketing tag via GTM

### 4m. Meeting Intelligence -- Pre-Meeting Brief

1. **Read upcoming calendar events** + extract attendee emails -- Google Calendar API
2. **Look up each attendee in HubSpot** by email -- contact record, deal associations, lifecycle stage
3. **Enrich unknown attendees** via Apollo -- title, seniority, LinkedIn, company data
4. **Pull deal context** -- MEDDPIC status, stage, last notes, open tasks -- HubSpot API
5. **Query past Granola meetings** with this contact/company -- Granola MCP: `query_granola_meetings`
6. **Check for competitive presence** at this account -- HubSpot `competitor_present` property
7. **Claude synthesizes into 1-page brief** -- who, context, MEDDPIC gaps to probe, suggested questions
8. **Deliver brief to Slack `#meeting-prep`** -- 30 minutes before meeting

### 4n. Meeting Intelligence -- Post-Meeting Follow-Up

1. **Meeting ends** -- Apollo CI records, transcribes, generates AI summary + action items + follow-up email draft -- automatic
2. **Apollo auto-populates HubSpot fields** from conversation content -- native
3. **Claude reads Granola transcript via MCP** (parallel, for deeper/custom analysis)
4. **Claude extracts** -- MEDDPIC updates, competitive intel, objections, buying signals -- structured from unstructured
5. **Claude drafts follow-up email** in your voice (using voice guidelines) -- references specific discussion points
6. **Agent posts to Slack `#sales-approvals`** -- proposed HubSpot updates + draft email + suggested tasks
7. **HUMAN GATE: Review in Slack** -- approve, edit, or reject each item
8. **On approval: Update MEDDPIC fields + deal stage** in HubSpot -- API
9. **On approval: Create tasks** in HubSpot for agreed next steps -- API
10. **On approval: Create Gmail draft** of follow-up email in correct thread -- Gmail API `drafts.create`
11. **If new contacts mentioned** -- search/enrich via Apollo, associate to deal

### 4o. MEDDPIC Qualification (Opportunity Pipeline Stages)

| Stage | What's Happening | Exit Criteria |
|---|---|---|
| 1. Target Identified | Account flagged, contacts being found/enriched | At least 1 contact sequenced |
| 2. Outreach Active | Sequences running, ads targeting this account | Meeting booked or reply received |
| 3. Discovery | First meetings, learning the org and pain | At least 2 MEDDPIC criteria have data |
| 4. Qualification In Progress | Actively working all MEDDPIC, multi-threading | 4+ criteria have data, Champion identified |
| 5. Fully Qualified | All 6 MEDDPIC validated | Convert to Deal Pipeline (manual + Slack prompt) |
| Disqualified | Not a fit | Reason documented, enter re-engagement after 90 days |

### 4p. Deal Pipeline (Post-Qualification Stages)

| Stage | What's Happening | Exit Criteria |
|---|---|---|
| 1. Solution Design | Scoping requirements | Proposal drafted |
| 2. Proposal Delivered | Prospect reviewing | Feedback received |
| 3. Technical Evaluation | Demo, POC, or trial | Technical signoff |
| 4. Business Case / ROI | Champion building internal case | Exec sponsor briefed |
| 5. Procurement / Legal / Security | Vendor assessment, contracts | All requirements met |
| 6. Final Negotiation | Terms, pricing, timing | Verbal commit |
| 7. Closed Won | Signed | Handoff to implementation |
| 8. Closed Lost | Did not close | Reason captured, win/loss analysis, re-engagement in 90 days |

### 4q. Deal Health Scoring (Weekly Automated)

| Factor | Weight | Scoring |
|---|---|---|
| MEDDPIC completion | 25% | 0-100 based on validated criteria ratio |
| Days in current stage vs. average | 20% | 100 if on pace, decays as deal ages |
| Last activity recency | 20% | 100 if <7d, 50 if 7-14d, 25 if 14-30d, 0 if >30d |
| Stakeholder coverage | 15% | 100 if 3+ contacts, 50 if 2, 0 if single-threaded |
| Champion engagement | 10% | 100 if active in last 14 days, 0 if not |
| Next step defined | 10% | 100 if next_step + next_step_date set, 0 if not |

Score 0-100. Below 50 = flagged in weekly Slack `#deal-health` report.

### 4r. Content & Retargeting Loop

1. **Publish blog post** on Vercel-hosted TypeScript site
2. **Deploy hook fires** -- regenerate XML sitemap
3. **Submit updated sitemap** via Search Console API -- Sitemaps API
4. **Inspect new URL** via URL Inspection API -- triggers re-evaluation, 2K/day
5. **Submit to IndexNow** for instant Bing/Yandex/Naver indexing -- free POST request
6. **Google indexes page** -- hours to days (NOT instant)
7. **Visitor lands on site** -- GTM fires all tracking pixels (Google Ads, LinkedIn Insight Tag, Apollo pixel)
8. **Common Room identifies visitor** -- person-level 50% US, company-level otherwise
9. **HubSpot contact lists auto-sync** to Google Customer Match + LinkedIn Matched Audiences
10. **Visitor enters Website Visitor pipeline** (see 4d)

### 4s. Re-engagement -- Stale Lead Recovery

1. **HubSpot search** -- contacts with no activity >60 days, not customer, not disqualified
2. **Re-enrich via Apollo** (email/phone may have changed) -- 22.5% of CRM data goes stale annually
3. **Check for job changes** -- if at a new company, flag as new opportunity
4. **Job changed** -- create new opportunity + re-sequence with warm angle
5. **Same role, stale** -- enroll in re-engagement sequence (different tone, not cold)
6. **Bad data** -- archive contact
7. **Re-warm sending mailboxes** via Instantly if they've gone cold

### 4t. Re-engagement -- Lost Deal Recovery

1. **Deal closes Lost** -- require `lost_reason` + `lost_to_competitor` + `win_loss_notes` -- HubSpot workflow gate
2. **Add to "Lost Deals" list**
3. **After 90 days** -- re-enter nurture with new angle (new feature, case study, insight)
4. **Track competitive losses separately** -- feed battlecard updates

### 4u. Customer Expansion

1. **Track `expansion_potential`** on closed-won deals (High/Medium/Low/None)
2. **For High** -- identify additional teams/use cases at the account -- Apollo People Search
3. **Request referrals and intros** to other target accounts -- manual, highest conversion channel
4. **Long-cycle nurture** for non-expansion customers (content drip, event invites)

---

## 5. Sync Directions -- Detailed

| Source | Destination | What Syncs | Direction | Mechanism |
|---|---|---|---|---|
| Apollo | HubSpot | Contacts, engagement data, activity logs | Apollo -> HubSpot | Native sync (automatic) |
| Apollo CI | HubSpot | Meeting data, conversation fields | Apollo -> HubSpot | Native auto-populate |
| HubSpot | Google Ads | Contact lists for Customer Match audiences | HubSpot -> Google | Native list sync (migrate to Data Manager API by Apr 2026) |
| HubSpot | LinkedIn | Contact lists for Matched Audiences | HubSpot -> LinkedIn | Native list sync |
| Common Room | Apollo | High-fit visitor contacts | Common Room -> Apollo | Native integration |
| Common Room | HubSpot | Signal data, visitor identification | Common Room -> HubSpot | Native integration |
| Common Room | Slack | High-intent visitor alerts | Common Room -> Slack | RoomieAI Spark alerts |
| Clay | HubSpot | Enriched data (verified email, phone, tech stack, etc.) | Clay -> HubSpot | HTTP API action (outbound webhook) |
| HubSpot/Apollo | Clay | Account/contact data for deep enrichment | HubSpot -> Clay | Webhook POST (50K row limit) |
| Granola | Claude Agents | Meeting transcripts, summaries | Granola -> Agent | MCP (read-only) |
| Google Calendar | Claude Agents | Events, attendee data | Calendar -> Agent | MCP (read-only) |
| Claude Agents | HubSpot | MEDDPIC updates, deal stage changes, tasks, contact creation | Agent -> HubSpot | HubSpot MCP (after human approval) |
| Claude Agents | Apollo | Contact creation, sequence enrollment, enrichment requests | Agent -> Apollo | Apollo MCP |
| Claude Agents | Gmail | Follow-up email drafts | Agent -> Gmail | Gmail MCP (drafts.create) |
| Claude Agents | Slack | Briefs, approval requests, notifications, reports | Agent -> Slack | Slack MCP + Slack Bolt |
| Slack | Claude Agents | Commands, file uploads, approval responses | Slack -> Agent | Slack Bolt webhook |
| Classification System | Supabase | New exclusions, tags, known prospects | System -> Postgres | Drizzle ORM |
| Supabase | Classification System | Known company lists for matching | Postgres -> System | Drizzle ORM |
| HeyReach | LinkedIn | Connection requests, messages | HeyReach -> LinkedIn | Cloud automation |
| Instantly | Email | Mailbox warmup | Instantly -> Email infrastructure | API |

---

## 6. Workflow Dependencies

### Prerequisite Chain

```
Sequences built in Apollo UI (manual, one-time)
    |
    v
Instantly mailbox warmup enabled (one-time setup, ongoing monitoring)
    |
    v
Clay table configured in UI (one-time)
    |
    v
HubSpot data model created (all properties, pipelines, stages, workflows)
    |
    v
Common Room JS snippet installed on website
    |
    v
MCP servers installed and configured (4-5 per session max)
    |
    v
--- All pipelines can now operate ---
```

### Runtime Dependencies per Workflow

| Step | Depends On | Must Complete Before |
|---|---|---|
| Classification (known match) | Supabase company lists populated | Agent classification (only for unknowns) |
| Agent classification (Claude) | Known matching completed (unknowns identified) | Review UI display |
| Human review | Classification complete, review stored in KV | Database commit |
| Database commit | Human review submitted | Next classification run (improved matching) |
| Apollo enrichment | Contact identified (name + company minimum) | Sequence enrollment, HubSpot contact creation |
| Apollo People Search | Company identified | Contact enrichment |
| Sequence enrollment | Contact created in Apollo + email revealed | Engagement tracking |
| HubSpot contact creation | Apollo enrichment complete (or native sync) | Deal creation, lifecycle tracking |
| Deal creation in HubSpot | At least 1 contact exists at company | MEDDPIC tracking, deal health scoring |
| MEDDPIC tracking | Deal exists in Opportunity Pipeline | Deal health scoring, qualification |
| Convert to Deal Pipeline | All 6 MEDDPIC criteria validated | Closing process |
| Pre-meeting brief | Calendar event exists, 30 min before meeting | Meeting execution |
| Post-meeting follow-up | Meeting transcript available in Granola | CRM updates, task creation |
| CRM updates from meeting | Human approval in Slack | MEDDPIC field updates, task creation |
| Re-engagement | Contact inactive >60 days | Re-enrichment, re-sequencing |
| Lost deal recovery | Deal closed Lost + 90 days elapsed | Re-nurture sequence |
| Ad retargeting audiences | HubSpot contact lists populated | Google/LinkedIn ad campaigns |
| Blog indexing | Blog published on Vercel, sitemap regenerated | Visitor tracking via Common Room |
| HubSpot persona classification | Contact enriched with title data | Sequence selection (L&D vs QA vs Ops) |
| Clay deep enrichment | Account identified as high-value | Tech stack detection, intent signals |
| LinkedIn connection requests (HeyReach) | Contacts approved by human, LinkedIn URLs revealed | LinkedIn follow-up messaging |

---

## 7. Human Gates

Every point in the system where a human must review and approve before the pipeline continues.

| Gate | Location | What's Being Approved | Why | Slack Channel |
|---|---|---|---|---|
| **Pre-conference contact approval** | Conference Pipeline step 6 | Contact list before spending Apollo credits on reveals | Credits cost money; prevents wasting on bad-fit contacts | Slack (leadership) |
| **Website visitor contact approval** | Website Visitor step 9 | New contacts before sequencing | Prevents auto-emailing bad-fit visitors | Slack |
| **ABM target approval** | ABM Targeting step 5 | Contact list before spending Apollo credits | Same credit-protection logic | Slack (Adam/Tom) |
| **Company classification review** | Classification Pipeline step 8 | Accept/reject Claude's classification of unknown companies | Ensures classification accuracy before database update | Slack + Review UI |
| **Post-meeting CRM updates** | Meeting Follow-up step 7 | Proposed HubSpot field updates + draft email + suggested tasks | Prevents inaccurate CRM updates or poorly-worded emails | Slack `#sales-approvals` |
| **MEDDPIC-to-Deal conversion** | Opportunity Pipeline step 5 | Opportunity ready to convert to Deal Pipeline | Major pipeline transition; needs human judgment | Slack prompt |
| **Re-engagement list approval** | Re-engagement agent | Contacts to re-sequence | Prevents unwanted outreach to stale contacts | Slack |
| **Win/loss capture gate** | Deal Pipeline (Closed Lost) | `lost_reason` required before deal can close as lost | Ensures win/loss data is captured for learning | HubSpot workflow gate |

---

## 8. HubSpot Automated Workflows (9)

| Workflow | Trigger | Action |
|---|---|---|
| Lifecycle auto-advance | Engagement score crosses MQL threshold | Set lifecycle = MQL, Slack notification |
| Meeting booked -> SQL | Meeting activity logged with prospect | Set lifecycle = SQL |
| New deal -> associate company | Deal created | Auto-associate to contact's company |
| Stage change tracking | Deal stage changes | Reset `days_in_current_stage`, log timestamp |
| Single-thread risk | Deal has only 1 contact after 14 days | Set `single_thread_risk` = true, Slack alert |
| Champion gone quiet | Champion last activity >14 days | Set `champion_engaged` = false, Slack alert |
| MEDDPIC complete | All 6 statuses = Validated | Slack: "Ready to convert to Deal Pipeline" |
| Win/loss capture gate | Deal closing as Won or Lost | Require `lost_reason` or `expansion_potential` |
| Re-engagement trigger | Contact inactive >60 days, not customer/disqualified | Add to re-engagement list |

---

## 9. Claude Code Agents (8)

| Agent | Purpose | MCP Servers Used | Human Gate |
|---|---|---|---|
| Conference Pipeline | CSV -> enrich -> filter -> create contacts -> enroll in sequence | Apollo, HubSpot, Clay | Approve list before spending credits |
| Website Visitor | Common Room signals -> Apollo search -> enrich -> sequence | Common Room, Apollo, HubSpot | Approve contact list before sequencing |
| Pre-Meeting Brief | Calendar -> enrich attendees -> pull deal history -> deliver brief | Calendar, Apollo, HubSpot, Slack | None (read-only) |
| Meeting Follow-up | Granola transcript -> CRM updates + follow-up email + tasks -> Slack | Granola, HubSpot, Gmail, Slack | Approve all updates before executing |
| ABM Multi-Thread | Check MEDDPIC gaps -> find missing roles -> enrich -> sequence | HubSpot, Apollo | Approve new contacts before sequencing |
| Deal Health | Weekly pipeline scan -> score each deal -> flag at-risk -> Slack report | HubSpot, Slack | None (report only) |
| Re-Engagement | Find stale leads -> re-enrich -> detect job changes -> re-sequence | HubSpot, Apollo, Instantly | Approve re-engagement list |
| Content Pipeline | New blog post -> submit sitemap -> inspect URL -> IndexNow | Search Console | None (automated) |

---

## 10. Future Spokes & Planned Capabilities

### Immediate Next Steps (from project status)

1. **Expanded Supabase schema** -- contacts as first-class entities, HubSpot field mapping, enrichment tracking
2. **End-to-end testing** -- upload list -> classification + persona + HubSpot -> review page with both tabs
3. **Clay table setup** (manual in Clay UI) -> then wire push-to-Clay from sandbox
4. **Apollo enrichment integration** -- People Enrichment API
5. **Post-conference list handling** (with names/emails, not just companies)

### Build Roadmap Phases

| Phase | Timeline | Key Deliverables |
|---|---|---|
| Phase 0: Foundation | Week 1-2 | HubSpot data model, Apollo sync, template sequences, Instantly warmup, Clay table |
| Phase 1: Signal Intelligence | Week 2-3 | Common Room setup, HeyReach, website to Vercel, deploy hooks |
| Phase 2: Core Agents | Week 3-5 | Conference Pipeline, Pre-Meeting Brief, Meeting Follow-up agents, voice guidelines |
| Phase 3: Outbound & ABM | Week 5-7 | Website Visitor agent, ABM Multi-Thread, ad retargeting, Content Pipeline agent |
| Phase 4: Intelligence & Health | Week 7-8 | Deal Health agent, Re-Engagement agent, champion enablement, battlecards, procurement bank, MAP templates |
| Phase 5: Polish & Optimize | Ongoing | Tune scoring weights, refine ICP model, Slack app with interactive buttons, Google Ads Data Manager API migration |

### Planned Evaluations

- Is Common Room Starter sufficient or need upgrade to Team?
- As team grows, is Apollo CI + Granola sufficient or need Gong/Avoma?
- Slack interactive buttons app to replace thread-based approvals
- Voice/tone guidelines creation from sent email analysis

### Known Deadlines

- **April 1, 2026** -- Migrate Google Ads Customer Match to Data Manager API (breaking change)

### Known Limitations Requiring Workarounds

| Limitation | Current Workaround |
|---|---|
| No LinkedIn outreach API | HeyReach cloud automation (TOS risk acknowledged) |
| No instant Google blog indexing | Sitemap + URL Inspection + IndexNow for Bing |
| Cannot create sequences via API (Apollo/HubSpot) | Pre-build in UI, API handles enrollment only |
| Apollo website visitor data has no API | Common Room replaces this (person-level ID + API + webhooks) |
| Clay tables must be configured in UI | Set up once, webhook-in/webhook-out runs automatically |
| Sales Navigator API closed (SNAP paused Aug 2025) | Apollo People Search as programmatic alternative |
| No Slack interactive buttons via MCP | Thread-based approval; build Slack app later |
| Apollo transcript data not in API | Granola MCP for programmatic access |
| Common Room API mostly push-in | Use webhooks for outbound triggers, S3 export for bulk |

---

## 11. Current System State (as of 2026-03-29)

### Working

- Classification pipeline: Slack upload -> known matching -> Claude classification -> human review -> Postgres commit
- Supabase Postgres: 305 companies (201 exclusions, 101 tags, 3 prospects), Drizzle ORM
- HubSpot integration: searches contacts by company+title, exact title match filtering
- Persona classification: Claude (Sonnet) tags titles into 7 personas
- Review page: two tabs (Classification + Attendees)
- Single Slack message after all jobs complete
- Parallel batch processing (20 companies/batch)

### Known Issues

- AI Gateway credits can run out mid-session (causes persona classification to return all "unknown")
- Persona classification can fail silently in sandbox
- Large lists (~350 companies) can approach 300s function timeout with HubSpot lookups + persona sandbox

### Architecture Constraints

- Everything lives on Vercel -- no local scripts or CLI tools
- Slack is the primary interface for all interactions
- Supabase Postgres for persistent data, Vercel KV for ephemeral state
- HubSpot is a DESTINATION (downstream sync), NOT a backend/system of record for classification
- Bot only responds to @mentions, not all channel messages
