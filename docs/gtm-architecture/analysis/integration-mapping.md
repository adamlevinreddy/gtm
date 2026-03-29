# Integration Field Mapping: Supabase <-> External Systems

> Reddy GTM | Generated 2026-03-29
> Maps every data flow between the Supabase Postgres database and all external integrations.

---

## Table of Contents

1. [Current Supabase Schema (Baseline)](#1-current-supabase-schema-baseline)
2. [HubSpot CRM Integration](#2-hubspot-crm-integration)
3. [Apollo Integration](#3-apollo-integration)
4. [Clay Integration](#4-clay-integration)
5. [Common Room Integration](#5-common-room-integration)
6. [Slack Integration](#6-slack-integration)
7. [Vercel Sandbox / Claude Agent Integration](#7-vercel-sandbox--claude-agent-integration)
8. [Additional Systems (HeyReach, Instantly, Granola, Google)](#8-additional-systems)
9. [Sync Architecture Summary](#9-sync-architecture-summary)
10. [Custom HubSpot Properties to Create](#10-custom-hubspot-properties-to-create)
11. [Expanded Schema Requirements](#11-expanded-schema-requirements)

---

## 1. Current Supabase Schema (Baseline)

Source: `src/lib/schema.ts`

### Table: `companies`

| Column | Type | Purpose |
|---|---|---|
| `id` | serial (PK) | Auto-increment identifier |
| `name` | text | Canonical company name |
| `action` | enum: exclude/tag/prospect | Classification decision |
| `category` | text (nullable) | Category slug (e.g., "ccaas", "bpo") |
| `category_label` | text (nullable) | Human-readable category label |
| `added` | date | Date entry was created |
| `source` | text | Which list/event/source triggered classification |
| `note` | text (nullable) | Freeform notes (used for prospects) |

### Table: `company_aliases`

| Column | Type | Purpose |
|---|---|---|
| `id` | serial (PK) | Auto-increment identifier |
| `company_id` | integer (FK -> companies.id) | Parent company reference |
| `alias` | text | Alternate spelling/name for matching |

### Table: `categories`

| Column | Type | Purpose |
|---|---|---|
| `slug` | text (PK) | Category identifier (e.g., "ccaas", "bpo") |
| `label` | text | Human-readable label |
| `action` | enum: exclude/tag/prospect | Default action for this category |

### Data Volumes (as of 2026-03-29)
- 305 companies (201 exclusions, 101 tags, 3 prospects)
- 12 categories (10 exclusion, 2 tag)

### Tables NOT Yet in Supabase (stored in Vercel KV)
- Review state (`review:{id}`) -- classification results, decisions, HubSpot matches, attendees
- Persona classifications (ephemeral, per-review)

---

## 2. HubSpot CRM Integration

### Overview

| Attribute | Value |
|---|---|
| **Direction** | Bidirectional (read during classification, write planned for full pipeline) |
| **Current state** | Read-only: contact search by company+title during classification |
| **Future state** | Full CRUD on contacts, companies, deals; lifecycle management; MEDDPIC tracking |
| **API base** | `https://api.hubapi.com/crm/v3/objects/` |
| **Auth** | Bearer token (`HUBSPOT_API_KEY` env var) |
| **MCP server** | `shinzo-labs/hubspot-mcp` (112 tools) -- planned for agent use |
| **Rate limits** | 650K requests/day, 190 requests/10 seconds |

### 2A. Current HubSpot API Usage

Two code paths currently hit HubSpot:

**Path 1: `src/app/api/hubspot/lookup/route.ts` (server-side batch lookup)**

| API Endpoint | Method | Purpose |
|---|---|---|
| `/crm/v3/objects/contacts/search` | POST | Search contacts by company name (query param), return up to 20 results |

Properties requested: `firstname`, `lastname`, `jobtitle`, `company`

Matching logic: Exact title match between conference attendee titles and HubSpot contact job titles. Results stored as `hubspotMatches` and `attendees` arrays in Vercel KV review state.

**Path 2: `src/lib/agent.ts` (sandbox agent tool use)**

| API Endpoint | Method | Purpose |
|---|---|---|
| `/crm/v3/objects/contacts/search` | POST | Filter-based search (CONTAINS_TOKEN on company + jobtitle) |
| `/crm/v3/objects/contacts/search` | POST | Fallback: query-based search when filter fails on multi-word values |

Properties requested: `firstname`, `lastname`, `email`, `jobtitle`, `company`, `lifecyclestage`, `hs_lead_status`

The agent uses a `search_hubspot` tool within the Claude agentic loop. It searches for each prospect company+title combination and returns matching contacts.

**Path 3: `src/app/api/webhook/[source]/route.ts` (inbound webhook)**

Accepts HubSpot webhook payloads at `POST /api/webhook/hubspot`. Extracts `body.properties.company` and `body.properties.jobtitle`, then runs classification.

### 2B. HubSpot Contact Field Mapping (Full Vision)

#### Standard Contact Properties

| Supabase Column (Future) | HubSpot Property | Type | Sync Direction | Transform | Notes |
|---|---|---|---|---|---|
| `contacts.email` | `email` | string | Bidirectional | None | **Primary match key** |
| `contacts.first_name` | `firstname` | string | Bidirectional | None | |
| `contacts.last_name` | `lastname` | string | Bidirectional | None | |
| `contacts.title` | `jobtitle` | string | Bidirectional | None | |
| `contacts.company_name` | `company` | string | Bidirectional | None | Used for company association |
| `contacts.phone` | `phone` | string | Apollo -> Supabase -> HubSpot | None | From enrichment |
| `contacts.linkedin_url` | `linkedin_url` (custom) | string | Supabase -> HubSpot | None | Custom property needed |
| `contacts.lifecycle_stage` | `lifecyclestage` | enumeration | Bidirectional | Map enum values | Standard: subscriber/lead/marketingqualifiedlead/salesqualifiedlead/opportunity/customer/evangelist |
| `contacts.lead_status` | `hs_lead_status` | enumeration | Bidirectional | Map enum values | Standard: NEW/OPEN/IN_PROGRESS/OPEN_DEAL/UNQUALIFIED/ATTEMPTED_TO_CONTACT/CONNECTED/BAD_TIMING |

#### Custom Contact Properties (to create in HubSpot)

| Supabase Column (Future) | HubSpot Property | Type | Sync Direction | Transform | Notes |
|---|---|---|---|---|---|
| `contacts.persona` | `persona_category` | enumeration | Supabase -> HubSpot | Map: ld/qa/wfm/km/cx_leadership/sales_marketing/it -> dropdown values | **Custom property, group: "Reddy Intelligence"** |
| `contacts.buying_role` | `buying_role` | enumeration | Supabase -> HubSpot | None | Values: Champion/Economic Buyer/Technical Evaluator/End User/Coach/Blocker/Unknown |
| `contacts.seniority` | `seniority_level` | enumeration | Supabase -> HubSpot | Map Apollo seniority | Values: C-Suite/VP/Director/Manager/IC |
| `contacts.lead_source` | `lead_source` | enumeration | Supabase -> HubSpot | None | Values: Conference (Pre)/Conference (Post)/Website Visitor/ABM/Inbound/Referral/Apollo Search |
| `contacts.conference_name` | `conference_name` | string | Supabase -> HubSpot | None | Which specific conference |
| `contacts.is_competitor` | `is_competitor` | boolean | Supabase -> HubSpot | `companies.action == 'exclude'` | Derived from company classification |
| `contacts.is_disqualified` | `is_disqualified` | boolean | Supabase -> HubSpot | None | Non-ICP flag |
| `contacts.disqualification_reason` | `disqualification_reason` | enumeration | Supabase -> HubSpot | None | Competitor/Wrong Role/Wrong Company Size/Bad Fit/Other |
| `contacts.apollo_contact_id` | `apollo_contact_id` | string | Supabase -> HubSpot | None | Cross-system ID link |
| `contacts.enrichment_source` | `enrichment_source` | enumeration | Supabase -> HubSpot | None | Apollo/Clay/Manual/Conference List |
| `contacts.last_enrichment_date` | `last_enrichment_date` | date | Supabase -> HubSpot | ISO date | Freshness tracking |
| `contacts.engagement_score` | `engagement_score` | number | HubSpot -> Supabase | Calculated from activities | Workflow-calculated in HubSpot |
| `contacts.sequence_status` | `sequence_status` | enumeration | Apollo -> Supabase -> HubSpot | None | Not Sequenced/Active/Completed/Replied/Opted Out |
| `contacts.sequence_name` | `sequence_name` | string | Apollo -> Supabase -> HubSpot | None | Which Apollo sequence |
| `contacts.outreach_priority` | `outreach_priority` | number | Supabase -> HubSpot | None | 1-3 ranking |
| `contacts.icp_fit_score` | `icp_fit_score` | number | Supabase -> HubSpot | Claude-calculated | ICP match score |

### 2C. HubSpot Company Field Mapping (Full Vision)

#### Standard Company Properties

| Supabase Column (Future) | HubSpot Property | Type | Sync Direction | Notes |
|---|---|---|---|---|
| `accounts.name` | `name` | string | Bidirectional | Primary match key |
| `accounts.domain` | `domain` | string | Bidirectional | **Secondary match key** |
| `accounts.industry` | `industry` | string | Apollo -> Supabase -> HubSpot | From enrichment |
| `accounts.employee_count` | `numberofemployees` | number | Apollo -> Supabase -> HubSpot | From enrichment |
| `accounts.annual_revenue` | `annualrevenue` | number | Apollo -> Supabase -> HubSpot | From enrichment |
| `accounts.city` | `city` | string | Bidirectional | |
| `accounts.state` | `state` | string | Bidirectional | |
| `accounts.country` | `country` | string | Bidirectional | |

#### Custom Company Properties (to create in HubSpot, group: "ABM Intelligence")

| Supabase Column (Future) | HubSpot Property | Type | Sync Direction | Notes |
|---|---|---|---|---|
| `accounts.tier` | `account_tier` | enumeration | Supabase -> HubSpot | Tier 1 (strategic) / Tier 2 (target) / Tier 3 (opportunistic) |
| `accounts.status` | `account_status` | enumeration | Bidirectional | Target/Prospecting/Engaged/Opportunity Open/Customer/Churned/Disqualified |
| `accounts.lead_source_original` | `lead_source_original` | enumeration | Supabase -> HubSpot | Conference/Website Visitor/ABM List/Inbound/Referral/Apollo Prospecting |
| `accounts.conference_source` | `conference_source` | string | Supabase -> HubSpot | Which specific conference |
| `accounts.icp_fit_score` | `icp_fit_score` | number | Supabase -> HubSpot | Calculated by Claude |
| `accounts.tech_stack` | `tech_stack_known` | multi-line text | Clay -> Supabase -> HubSpot | From Clay/Apollo enrichment |
| `accounts.competitor_present` | `competitor_present` | enumeration | Supabase -> HubSpot | None Known / [names] / Multiple |
| `accounts.compelling_event` | `compelling_event` | string | Supabase -> HubSpot | Why buy now |
| `accounts.compelling_event_date` | `compelling_event_date` | date | Supabase -> HubSpot | When the event hits |
| `accounts.warm_intro_available` | `warm_intro_available` | boolean | Supabase -> HubSpot | Network check result |
| `accounts.warm_intro_path` | `warm_intro_path` | string | Supabase -> HubSpot | Who can intro to whom |
| `accounts.last_enrichment_date` | `last_enrichment_date` | date | Supabase -> HubSpot | Data freshness |
| `accounts.intent_signals` | `intent_signals` | multi-line text | Common Room -> Supabase -> HubSpot | Job postings, funding, G2, etc. |
| `accounts.account_plan_notes` | `account_plan_notes` | multi-line text | Supabase -> HubSpot | Strategic notes |
| `accounts.stakeholder_count` | `stakeholder_count` | number | HubSpot -> Supabase | Calculated from associations |
| `companies.action` | (derived) `is_competitor` | boolean | Supabase -> HubSpot | `action == 'exclude'` maps to competitor flag |
| `companies.category` | (derived) | N/A | Supabase -> HubSpot | Category determines which competitor/tag label |

### 2D. HubSpot Deal Field Mapping -- Opportunity Pipeline (MEDDPIC)

| Supabase Column (Future) | HubSpot Property | Type | Sync Direction | Notes |
|---|---|---|---|---|
| `opportunities.name` | `dealname` | string | Bidirectional | |
| `opportunities.stage` | `dealstage` | enumeration | Bidirectional | See pipeline stages below |
| `opportunities.pipeline` | `pipeline` | enumeration | Supabase -> HubSpot | "Opportunity Pipeline" |
| `opportunities.amount` | `amount` | number | Bidirectional | |
| `opportunities.close_date` | `closedate` | date | Bidirectional | |
| `opportunities.owner` | `hubspot_owner_id` | number | Bidirectional | |

#### Opportunity Pipeline Stages

| Stage ID (to create) | Stage Name | Supabase Enum Value |
|---|---|---|
| `target_identified` | Target Identified | `target_identified` |
| `outreach_active` | Outreach Active | `outreach_active` |
| `discovery` | Discovery | `discovery` |
| `qualification_in_progress` | Qualification In Progress | `qualification_in_progress` |
| `fully_qualified` | Fully Qualified | `fully_qualified` |
| `disqualified` | Disqualified | `disqualified` |

#### MEDDPIC Custom Deal Properties

| Supabase Column (Future) | HubSpot Property | Type | Sync Direction | Notes |
|---|---|---|---|---|
| `opportunities.meddpic_metrics_status` | `meddpic_metrics_status` | enumeration | Bidirectional | Not Started / Exploring / Identified / Validated |
| `opportunities.meddpic_metrics_detail` | `meddpic_metrics_detail` | multi-line text | Bidirectional | Freeform notes from meetings |
| `opportunities.meddpic_economic_buyer_status` | `meddpic_economic_buyer_status` | enumeration | Bidirectional | Same 4-value enum |
| `opportunities.meddpic_economic_buyer_detail` | `meddpic_economic_buyer_detail` | multi-line text | Bidirectional | |
| `opportunities.meddpic_decision_criteria_status` | `meddpic_decision_criteria_status` | enumeration | Bidirectional | |
| `opportunities.meddpic_decision_criteria_detail` | `meddpic_decision_criteria_detail` | multi-line text | Bidirectional | |
| `opportunities.meddpic_decision_process_status` | `meddpic_decision_process_status` | enumeration | Bidirectional | |
| `opportunities.meddpic_decision_process_detail` | `meddpic_decision_process_detail` | multi-line text | Bidirectional | |
| `opportunities.meddpic_identify_pain_status` | `meddpic_identify_pain_status` | enumeration | Bidirectional | |
| `opportunities.meddpic_identify_pain_detail` | `meddpic_identify_pain_detail` | multi-line text | Bidirectional | |
| `opportunities.meddpic_champion_status` | `meddpic_champion_status` | enumeration | Bidirectional | |
| `opportunities.meddpic_champion_detail` | `meddpic_champion_detail` | multi-line text | Bidirectional | |
| `opportunities.meddpic_completion_score` | `meddpic_completion_score` | number | Supabase -> HubSpot | Calculated: (validated count / 6) x 100 |

#### Additional Opportunity Deal Properties

| Supabase Column (Future) | HubSpot Property | Type | Sync Direction | Notes |
|---|---|---|---|---|
| `opportunities.deal_health_score` | `deal_health_score` | number | Supabase -> HubSpot | Composite 0-100, calculated weekly |
| `opportunities.days_in_current_stage` | `days_in_current_stage` | number | HubSpot -> Supabase | Calculated from stage entry timestamp |
| `opportunities.single_thread_risk` | `single_thread_risk` | boolean | HubSpot -> Supabase | True if only 1 contact after 14 days |
| `opportunities.competitor_in_evaluation` | `competitor_in_evaluation` | enumeration | Bidirectional | None / [names] / Unknown |
| `opportunities.next_step` | `next_step` | string | Bidirectional | Agreed next action |
| `opportunities.next_step_date` | `next_step_date` | date | Bidirectional | When |
| `opportunities.last_meeting_date` | `last_meeting_date` | date | HubSpot -> Supabase | From engagement tracking |
| `opportunities.champion_engaged` | `champion_engaged` | boolean | HubSpot -> Supabase | Active in last 14 days |
| `opportunities.mutual_action_plan_link` | `mutual_action_plan_link` | string | Supabase -> HubSpot | URL to MAP doc |

### 2E. HubSpot Deal Field Mapping -- Deal Pipeline (Closing)

| Supabase Column (Future) | HubSpot Property | Type | Sync Direction | Notes |
|---|---|---|---|---|
| `deals.procurement_status` | `procurement_status` | enumeration | Bidirectional | Not Started/Security Review/Legal Review/Contract Redlines/Approved |
| `deals.security_questionnaire_sent` | `security_questionnaire_sent` | boolean | Bidirectional | |
| `deals.security_questionnaire_completed` | `security_questionnaire_completed` | boolean | Bidirectional | |
| `deals.contract_type` | `contract_type` | enumeration | Bidirectional | MSA + SOW / Single Agreement / PO-based |
| `deals.decision_date_target` | `decision_date_target` | date | Bidirectional | |
| `deals.budget_confirmed` | `budget_confirmed` | boolean | Bidirectional | |
| `deals.close_confidence` | `close_confidence` | enumeration | Bidirectional | High (>75%) / Medium (40-75%) / Low (<40%) |
| `deals.lost_reason` | `lost_reason` | enumeration | HubSpot -> Supabase | Required on close-lost |
| `deals.lost_to_competitor` | `lost_to_competitor` | string | HubSpot -> Supabase | |
| `deals.win_loss_notes` | `win_loss_notes` | multi-line text | HubSpot -> Supabase | |
| `deals.expansion_potential` | `expansion_potential` | enumeration | Bidirectional | High/Medium/Low/None |
| `deals.land_use_case` | `land_use_case` | string | Bidirectional | What they bought first |

#### Deal Pipeline Stages

| Stage ID (to create) | Stage Name |
|---|---|
| `solution_design` | Solution Design |
| `proposal_delivered` | Proposal Delivered |
| `technical_evaluation` | Technical Evaluation |
| `business_case_roi` | Business Case / ROI |
| `procurement_legal_security` | Procurement / Legal / Security |
| `final_negotiation` | Final Negotiation |
| `closed_won` | Closed Won |
| `closed_lost` | Closed Lost |

### 2F. HubSpot Association Labels (Contact <-> Deal)

These buying committee roles need to be created as custom association labels:

| Label | Purpose |
|---|---|
| Champion | Internal seller/advocate |
| Economic Buyer | Budget authority |
| Technical Evaluator | Evaluates technical fit |
| Decision Maker | Final decision authority |
| Coach / Guide | Internal advisor |
| Blocker | Opposes the deal |
| End User | Will use the product |
| Legal / Procurement | Contract/compliance review |
| Executive Sponsor | Senior executive backing |

### 2G. HubSpot API Endpoints Required

| Endpoint | Method | Current | Future | Purpose |
|---|---|---|---|---|
| `/crm/v3/objects/contacts/search` | POST | YES | YES | Find contacts by company/title/email |
| `/crm/v3/objects/contacts` | POST | No | YES | Create new contacts |
| `/crm/v3/objects/contacts/{id}` | PATCH | No | YES | Update contact properties |
| `/crm/v3/objects/contacts/batch/create` | POST | No | YES | Bulk create contacts (100/call) |
| `/crm/v3/objects/contacts/batch/update` | POST | No | YES | Bulk update contacts |
| `/crm/v3/objects/companies/search` | POST | No | YES | Find companies by domain/name |
| `/crm/v3/objects/companies` | POST | No | YES | Create company records |
| `/crm/v3/objects/companies/{id}` | PATCH | No | YES | Update company properties |
| `/crm/v3/objects/deals` | POST | No | YES | Create deals (opportunities) |
| `/crm/v3/objects/deals/{id}` | PATCH | No | YES | Update deal properties/stage |
| `/crm/v3/objects/deals/search` | POST | No | YES | Find deals by property filters |
| `/crm/v3/associations/{fromType}/{toType}/batch/create` | POST | No | YES | Associate contacts<->deals, contacts<->companies |
| `/crm/v3/associations/{fromType}/{toType}/labels` | GET | No | YES | Read association labels |
| `/crm/v3/properties/{objectType}` | POST | No | YES (setup) | Create custom properties |
| `/crm/v3/pipelines/{objectType}` | POST | No | YES (setup) | Create pipelines + stages |

### 2H. HubSpot Sync Triggers

| Trigger | Direction | When | What |
|---|---|---|---|
| Classification review committed | Supabase -> HubSpot | On human approval | Update company `is_competitor` flag; tag BPO/media companies |
| Contact enriched (Apollo/Clay) | Supabase -> HubSpot | After enrichment completes | Create/update contact with all enriched fields |
| Sequence enrolled | Apollo -> HubSpot (native) | Apollo sequence enrollment | Apollo native sync handles engagement data |
| Meeting follow-up approved | Supabase -> HubSpot | On human approval in Slack | Update MEDDPIC fields, deal stage, create tasks |
| Deal health scan | HubSpot -> Supabase | Weekly cron | Pull all open deals, calculate health scores, write back |
| Lifecycle stage change | HubSpot -> Supabase | HubSpot workflow | Webhook to `/api/webhook/hubspot` |
| Contact re-enrichment | Supabase -> HubSpot | Scheduled (contacts >60 days stale) | Updated phone/email/title from Apollo |

### 2I. HubSpot Conflict Resolution

| Scenario | Winner | Rationale |
|---|---|---|
| Contact email differs | HubSpot | HubSpot is CRM source of truth for engagement data |
| Contact title differs | Most recent enrichment | Titles change; latest data wins |
| MEDDPIC fields updated by agent vs. manual | Manual (HubSpot) | Human override always wins for qualification data |
| Lifecycle stage | HubSpot | Only advances forward; HubSpot workflows are authoritative |
| ICP fit score | Supabase | Calculated by Claude; pushed to HubSpot as read-only display |
| Persona category | Supabase | Classified by Claude; pushed to HubSpot |
| Deal health score | Supabase | Calculated by agent; pushed to HubSpot weekly |

---

## 3. Apollo Integration

### Overview

| Attribute | Value |
|---|---|
| **Direction** | Bidirectional (enrich inbound, push contacts outbound, read engagement) |
| **Current state** | Not directly integrated (HubSpot search used as proxy) |
| **Future state** | Full enrichment pipeline, sequence enrollment, engagement tracking |
| **API base** | `https://api.apollo.io/api/v1/` |
| **Auth** | API key header |
| **MCP server** | `Chainscore/apollo-io-mcp` (45 tools) |
| **Rate limits** | 200+ requests/min (Professional plan) |
| **Credit model** | 1 credit/person enrichment, 1 credit/company enrichment |

### 3A. Apollo People Enrichment -> Supabase

Apollo People Enrichment API returns rich contact data. This is the primary enrichment source for every contact.

**API endpoint:** `POST /api/v1/people/match` (single) or `POST /api/v1/people/bulk_match` (batch of 10)

| Apollo Response Field | Supabase Column (Future) | Transform | Notes |
|---|---|---|---|
| `person.email` | `contacts.email` | None | Primary identifier |
| `person.first_name` | `contacts.first_name` | None | |
| `person.last_name` | `contacts.last_name` | None | |
| `person.title` | `contacts.title` | None | |
| `person.seniority` | `contacts.seniority` | Map: c_suite/vp/director/manager/individual_contributor -> enum | Also feeds persona classification |
| `person.department` | `contacts.department` | None | Used for persona classification |
| `person.linkedin_url` | `contacts.linkedin_url` | None | |
| `person.phone_numbers[0].raw_number` | `contacts.phone` | Take first number | |
| `person.city` | `contacts.city` | None | |
| `person.state` | `contacts.state` | None | |
| `person.country` | `contacts.country` | None | |
| `person.employment_history[]` | `contact_enrichments.employment_history` | JSON blob | Historical employers, titles, dates |
| `person.id` | `contacts.apollo_contact_id` | None | Cross-system ID |
| `person.organization.name` | `accounts.name` | None | Links contact to account |
| `person.organization.id` | `accounts.apollo_org_id` | None | Cross-system ID |

### 3B. Apollo Organization Enrichment -> Supabase

**API endpoint:** `POST /api/v1/organizations/enrich`

| Apollo Response Field | Supabase Column (Future) | Transform | Notes |
|---|---|---|---|
| `organization.name` | `accounts.name` | None | |
| `organization.website_url` | `accounts.domain` | Extract domain from URL | **Secondary match key** |
| `organization.industry` | `accounts.industry` | None | |
| `organization.estimated_num_employees` | `accounts.employee_count` | None | |
| `organization.annual_revenue` | `accounts.annual_revenue` | None | May be null |
| `organization.total_funding` | `accounts.total_funding` | None | From Crunchbase data |
| `organization.latest_funding_round_date` | `accounts.latest_funding_date` | ISO date | |
| `organization.technologies[]` | `accounts.tech_stack` | JSON array | BuiltWith/similar data |
| `organization.keywords[]` | `accounts.keywords` | JSON array | Industry/product keywords |
| `organization.linkedin_url` | `accounts.linkedin_url` | None | |
| `organization.phone` | `accounts.phone` | None | |
| `organization.city` | `accounts.city` | None | |
| `organization.state` | `accounts.state` | None | |
| `organization.country` | `accounts.country` | None | |
| `organization.id` | `accounts.apollo_org_id` | None | Cross-system ID |
| (derived) | `accounts.last_enrichment_date` | Set to now() | Freshness tracking |

### 3C. Apollo People Search (Free, No Credits)

**API endpoint:** `POST /api/v1/mixed_people/search`

Used for: ABM targeting (find people at target companies by title/seniority), website visitor follow-up (find contacts at identified companies).

No data stored directly -- results feed into the enrichment pipeline after human approval.

### 3D. Apollo Sequence Enrollment

**API endpoint:** `POST /api/v1/emailer_campaigns/{id}/add_contact_ids`

| Supabase Column (Future) | Apollo Field | Direction | Notes |
|---|---|---|---|
| `contacts.apollo_contact_id` | `contact_ids[]` | Supabase -> Apollo | Must have Apollo contact first |
| `contacts.sequence_name` | `emailer_campaign.name` | Apollo -> Supabase | Track which sequence |
| `contacts.sequence_status` | Derived from engagement | Apollo -> Supabase | Active/Completed/Replied/Opted Out |

### 3E. Apollo Engagement Data -> Supabase

**API endpoint:** `GET /api/v1/emailer_campaigns/{id}/emailer_steps` + engagement endpoints

| Apollo Data | Supabase Column (Future) | Notes |
|---|---|---|
| Email opens | `contact_activities.type = 'email_open'` | Activity log |
| Email clicks | `contact_activities.type = 'email_click'` | Activity log |
| Email replies | `contact_activities.type = 'email_reply'` | Triggers sequence pause + Slack alert |
| Opt-outs | `contacts.sequence_status = 'opted_out'` | Stop all outreach |
| Bounces | `contacts.email_status = 'bounced'` | Mark email invalid |

### 3F. Apollo Sync Triggers

| Trigger | Direction | When | What |
|---|---|---|---|
| New contact approved for enrichment | Supabase -> Apollo | Human gate approval | People Enrichment API call |
| New account identified | Supabase -> Apollo | On new prospect company | Organization Enrichment API call |
| Contact approved for outreach | Supabase -> Apollo | Human gate approval | Create contact + enroll in sequence |
| Engagement data sync | Apollo -> Supabase | Polling (every 15 min or webhook) | Pull opens/clicks/replies/bounces |
| Re-enrichment (stale contacts) | Supabase -> Apollo | Scheduled (contacts >60 days) | Re-run People Enrichment |
| Job change detection | Apollo -> Supabase | During re-enrichment | New company/title triggers re-classification |

### 3G. Apollo ID Mapping

| Supabase | Apollo | Match Strategy |
|---|---|---|
| `contacts.email` | `person.email` | Primary match |
| `contacts.apollo_contact_id` | `person.id` | Stored after first enrichment |
| `contacts.linkedin_url` | `person.linkedin_url` | Fallback match |
| `accounts.domain` | `organization.website_url` | Domain extraction + match |
| `accounts.apollo_org_id` | `organization.id` | Stored after first enrichment |

---

## 4. Clay Integration

### Overview

| Attribute | Value |
|---|---|
| **Direction** | Bidirectional (push data in via webhook, receive enriched data via webhook out) |
| **Current state** | Not integrated |
| **Future state** | Deep enrichment for high-value accounts (waterfall across 150+ sources) |
| **API pattern** | Webhook-in (POST JSON), HTTP action webhook-out |
| **MCP server** | Clay MCP (6 tools, read-only) |
| **Limits** | 50K webhook rows per table |
| **Setup** | Table + columns must be configured in Clay UI (one-time) |

### 4A. Supabase -> Clay (Webhook Push)

Data pushed to Clay table via webhook when a high-value account needs deep enrichment.

**Trigger:** Account identified as Tier 1 or Tier 2 after initial Apollo enrichment.

| Supabase Column (Future) | Clay Column | Notes |
|---|---|---|
| `contacts.email` | `Email` | Primary input for waterfall |
| `contacts.first_name` | `First Name` | |
| `contacts.last_name` | `Last Name` | |
| `contacts.title` | `Job Title` | |
| `contacts.linkedin_url` | `LinkedIn URL` | Alternative enrichment input |
| `accounts.name` | `Company Name` | |
| `accounts.domain` | `Company Domain` | Key input for company enrichment |

### 4B. Clay -> Supabase (Webhook Out / HTTP Action)

Clay's waterfall enrichment aggregates data from 150+ sources (Apollo, Clearbit, Hunter, People Data Labs, ZoomInfo, etc.) and pushes enriched data back.

| Clay Output Column | Supabase Column (Future) | Transform | Notes |
|---|---|---|---|
| `Verified Email` | `contacts.verified_email` | None | Higher confidence than Apollo email |
| `Work Phone` | `contacts.phone` | Overwrite if higher confidence | |
| `Tech Stack (BuiltWith)` | `accounts.tech_stack` | JSON array | From BuiltWith/Wappalyzer |
| `Funding (Crunchbase)` | `accounts.total_funding` | Number | May be more current than Apollo |
| `Hiring Signals` | `accounts.intent_signals` | Append to JSON | Job postings indicating growth |
| `Competitive Tech` | `accounts.competitor_present` | Map vendor names to dropdown | Detect competing products installed |
| `Intent Score (Bombora)` | `accounts.intent_score` | Number | Bombora intent data |
| `Claygent Research` | `contact_enrichments.clay_research` | Text blob | Custom AI research per company |
| `Email Verification Status` | `contacts.email_verified` | Boolean | |
| (timestamp) | `contacts.last_enrichment_date` | Set to now() | |
| (timestamp) | `accounts.last_enrichment_date` | Set to now() | |

### 4C. Clay Sync Architecture

| Attribute | Value |
|---|---|
| **Push trigger** | On-demand: when account promoted to Tier 1/2 and human approves enrichment spend |
| **Return trigger** | Webhook from Clay HTTP action when row enrichment completes |
| **Return endpoint** | `POST /api/webhook/clay` |
| **ID mapping** | `contacts.email` (primary) or `accounts.domain` (company-level) |
| **Conflict resolution** | Clay overwrites Apollo data for overlapping fields (Clay waterfall is more comprehensive) |
| **Credit model** | Clay credits consumed per enrichment action per row |

---

## 5. Common Room Integration

### Overview

| Attribute | Value |
|---|---|
| **Direction** | Primarily inbound (signals flow in), limited outbound (push contacts) |
| **Current state** | Not integrated |
| **Future state** | Real-time signal intelligence: website visitors, intent, community activity |
| **API pattern** | Webhooks out to our system; limited REST API for pulls |
| **MCP server** | `chris-trag/commonroom-mcp` (10 tools) |
| **Rate limits** | ~20 req/sec |
| **JS snippet** | Installed on website for visitor identification |

### 5A. Common Room -> Supabase (Inbound Signals via Webhook)

**Endpoint:** `POST /api/webhook/common-room`

Current webhook handler (in `src/app/api/webhook/[source]/route.ts`) extracts:
- `body.company.name` or `body.organization.name` -> company name
- `body.person.title` -> job title (single)

Full signal payload mapping:

| Common Room Signal Field | Supabase Column (Future) | Transform | Notes |
|---|---|---|---|
| `person.email` | `contacts.email` | None | Person-level ID (50% US traffic) |
| `person.name` | `contacts.first_name` / `contacts.last_name` | Split on space | |
| `person.title` | `contacts.title` | None | |
| `person.linkedin_url` | `contacts.linkedin_url` | None | |
| `organization.name` | `accounts.name` | None | Company-level ID (higher coverage) |
| `organization.domain` | `accounts.domain` | None | |
| `organization.industry` | `accounts.industry` | None | If not already enriched |
| `organization.employee_count` | `accounts.employee_count` | None | If not already enriched |
| `signal.type` | `signals.type` | None | website_visit / g2_research / job_posting / funding / etc. |
| `signal.source` | `signals.source` | "common_room" | |
| `signal.timestamp` | `signals.detected_at` | ISO date | |
| `signal.url` | `signals.url` | None | Which page visited |
| `signal.intent_score` | `signals.intent_score` | Number | Bombora intent data |
| `signal.intent_topics[]` | `signals.intent_topics` | JSON array | What topics they are researching |
| `segment.name` | `signals.segment` | None | Common Room segment that triggered |

### 5B. Supabase -> Common Room (Limited Outbound)

| Use Case | Direction | Method | Notes |
|---|---|---|---|
| Push contact tags | Supabase -> Common Room | API: tag contacts | Tag ICP fit, persona, account tier |
| Push company classification | Supabase -> Common Room | API: tag organizations | Mark as prospect/vendor/BPO |
| Segment management | Read-only | MCP: list segments | Used by agents to check signal segments |

### 5C. Common Room Processing Flow

```
Website visitor detected (JS snippet)
         |
         v
Common Room identifies person (50% US) or company
         |
         v
Webhook fires to POST /api/webhook/common-room
         |
         v
classifyKnown() -- instant check against companies table
         |
    +----+----+
    |         |
  Known    Unknown
    |         |
    v         v
 Return    classifyWithAgent() -- Claude sandbox
 result         |
    |         v
    +----+----+
         |
         v
  Store signal in signals table
  If prospect: queue for Apollo enrichment
  If high intent: Slack alert to #sales
```

### 5D. Common Room Sync Architecture

| Attribute | Value |
|---|---|
| **Inbound trigger** | Real-time webhook on high-intent visitor detection |
| **Processing** | Classify company -> if prospect, enrich via Apollo -> create/update contact |
| **Slack alert** | RoomieAI Spark sends direct Slack alert (Common Room native) |
| **ID mapping** | `person.email` (primary), `organization.domain` (company-level fallback) |
| **Conflict resolution** | Common Room signals are additive; they never overwrite existing enrichment data |
| **Native integrations** | Common Room -> HubSpot (direct), Common Room -> Apollo (direct) |

---

## 6. Slack Integration

### Overview

| Attribute | Value |
|---|---|
| **Direction** | Bidirectional (receive commands, send notifications/results) |
| **Current state** | Fully integrated -- GTM Classifier bot in Reddy workspace, #sales channel |
| **API** | `@slack/web-api` (WebClient) |
| **Auth** | `SLACK_BOT_TOKEN` (xoxb-...), `SLACK_SIGNING_SECRET` |
| **MCP server** | Official Slack MCP (12 tools) -- for agent use |
| **Endpoint** | `POST /api/slack/events` (Slack Bolt receiver) |

### 6A. Slack -> Supabase (Inbound Commands)

| Slack Action | Data Extracted | Supabase Effect | Code Path |
|---|---|---|---|
| File upload + "classify" | CSV/XLSX file -> parsed to `{company, titles}[]` | Creates review in KV; classifications committed to `companies` table on approval | `src/app/api/slack/events/route.ts` -> `src/lib/parse-upload.ts` -> `src/lib/classifier.ts` -> `src/lib/agent.ts` |
| "check [company]" | Company name string | `classifyKnown()` reads from `companies` table | `src/app/api/slack/events/route.ts` -> `src/lib/classifier.ts` |
| Review approval (future: interactive buttons) | Review ID + decisions | Updates `companies` table via `commitCompanyListUpdates()` | `src/app/api/review/[id]/commit/route.ts` |

### 6B. Supabase -> Slack (Outbound Notifications)

| Event | Slack Message | Data Source | Code Path |
|---|---|---|---|
| Classification complete | Summary stats + "Review Now" button | Vercel KV review state | `src/lib/slack.ts` -> `sendReviewNotification()` |
| Review committed | "X exclusions, Y tags, Z prospects committed" | `commitCompanyListUpdates()` result | `src/lib/slack.ts` -> `sendCommitConfirmation()` |
| Webhook classification | Quick inline result for company | `classifyKnown()` or agent result | `src/lib/slack.ts` -> `sendQuickClassification()` |
| Common Room high-intent visitor (future) | Alert with company + signal details | `signals` table | Future: post to #sales |
| Deal health report (future) | Weekly pipeline scorecard | `opportunities` table + HubSpot data | Future: post to #deal-health |
| Meeting brief (future) | Pre-meeting brief 30 min before call | HubSpot + Apollo + Granola | Future: post to #meeting-prep |
| Approval requests (future) | CRM updates, email drafts, enrichment spend | Agent-proposed actions | Future: post to #sales-approvals |

### 6C. Slack Channels (Current and Planned)

| Channel | Purpose | Status |
|---|---|---|
| `#sales` | Classification results, quick lookups | Active |
| `#deal-health` | Weekly deal health reports | Planned |
| `#meeting-prep` | Pre-meeting briefs | Planned |
| `#sales-approvals` | Human gates for CRM updates, outreach, credit spend | Planned |

---

## 7. Vercel Sandbox / Claude Agent Integration

### Overview

| Attribute | Value |
|---|---|
| **Direction** | Supabase -> Sandbox (input data) -> Supabase (classification results) |
| **Current state** | Two sandbox flows: company classification (Opus 4.6) and persona classification (Sonnet 4.6) |
| **Runtime** | Vercel Sandbox (ephemeral Node.js 22 containers) |
| **AI routing** | Vercel AI Gateway (`https://ai-gateway.vercel.sh`) |
| **Auth** | `AI_GATEWAY_API_KEY` env var |

### 7A. Company Classification Agent

**Source:** `src/lib/agent.ts`

| Input (to Sandbox) | Source | Notes |
|---|---|---|
| Company names + attendee titles | Parsed from uploaded CSV/XLSX | Max 20 companies per batch |
| Known exclusions/tags/prospects | `companies` table (via `fetchCompanyLists()`) | Pre-filtered before agent runs |
| Classification system prompt | `src/lib/prompts.ts` | Rules for exclude/tag/prospect |

| Output (from Sandbox) | Destination | Notes |
|---|---|---|
| `classifications[]` | Vercel KV (`review:{id}.items`) | Each: `{name, action, category, rationale}` |
| `hubspot_matches[]` | Vercel KV (`review:{id}.hubspotMatches`) | Each: `{company, contacts: [{name, email, title}]}` |

**Tools available to agent:**

| Tool | API Called | Purpose |
|---|---|---|
| `search_hubspot` | `POST /crm/v3/objects/contacts/search` | Look up contacts in HubSpot CRM during classification |

### 7B. Persona Classification Agent

**Source:** `src/lib/persona.ts`

| Input (to Sandbox) | Source | Notes |
|---|---|---|
| Unique job titles | All titles from classification input | Deduplicated |
| Persona system prompt | Inline in `src/lib/persona.ts` | 7 buyer personas + excluded + unknown |

| Output (from Sandbox) | Destination | Notes |
|---|---|---|
| `{title, persona}[]` | Vercel KV (`review:{id}.attendees[].persona`) | Mapped by lowercase title |

**Persona values:**

| Persona Key | Label | HubSpot Mapping |
|---|---|---|
| `cx_leadership` | CX / Contact Center Leadership | `persona_category` = "CX Leadership" |
| `ld` | L&D / Training | `persona_category` = "L&D" |
| `qa` | QA Ops | `persona_category` = "QA" |
| `wfm` | WFM | `persona_category` = "WFM" |
| `km` | Knowledge Management | `persona_category` = "KM" |
| `sales_marketing` | Sales & Marketing | `persona_category` = "Sales & Marketing" |
| `it` | IT / Technology | `persona_category` = "IT" |
| `excluded` | Non-buyer roles (SDR, BDR, AE, etc.) | Do not sync to HubSpot; filter out |
| `unknown` | Unclassifiable | `persona_category` = "Unknown" |

### 7C. Future Agent Flows (from Strategy)

| Agent | Sandbox Input | Sandbox Output | External APIs Used |
|---|---|---|---|
| Conference Pipeline | Attendee list + enrichment data | Filtered/prioritized contact list + sequence assignments | Apollo, HubSpot, Clay |
| Website Visitor | Common Room signal + Apollo search results | Prioritized contacts for outreach | Apollo, HubSpot |
| Pre-Meeting Brief | Calendar event + attendee data + deal context | 1-page brief document | HubSpot, Apollo, Granola |
| Meeting Follow-up | Granola transcript + deal context | MEDDPIC updates + email draft + tasks | HubSpot, Granola, Gmail |
| ABM Multi-Thread | MEDDPIC gaps + Apollo people search | Missing role contacts + outreach plan | HubSpot, Apollo |
| Deal Health | All open deals + activity data | Health scores + at-risk flags | HubSpot |
| Re-Engagement | Stale contacts + re-enrichment data | Re-engagement list + sequence assignments | HubSpot, Apollo, Instantly |

---

## 8. Additional Systems

### 8A. HeyReach (LinkedIn Automation)

| Attribute | Value |
|---|---|
| **Direction** | Outbound only (push contacts for LinkedIn outreach) |
| **Current state** | Not integrated |
| **Integration pattern** | Export from Apollo/HubSpot -> import to HeyReach |

| Supabase Column (Future) | HeyReach Field | Direction | Notes |
|---|---|---|---|
| `contacts.first_name` | First Name | Supabase -> HeyReach | |
| `contacts.last_name` | Last Name | Supabase -> HeyReach | |
| `contacts.linkedin_url` | LinkedIn URL | Supabase -> HeyReach | **Required** for LinkedIn automation |
| `contacts.title` | Job Title | Supabase -> HeyReach | For personalization |
| `accounts.name` | Company | Supabase -> HeyReach | For personalization |

No data flows back from HeyReach to Supabase programmatically. LinkedIn activity logged to HubSpot manually or via Hublead browser extension.

### 8B. Instantly (Email Warmup)

| Attribute | Value |
|---|---|
| **Direction** | Outbound (manage warmup), Read (deliverability scores) |
| **Current state** | Not integrated |
| **MCP server** | `bcharleson/instantly-mcp` (38 tools) |

| Supabase Column (Future) | Instantly Field | Direction | Notes |
|---|---|---|---|
| `sending_accounts.email` | Account email | Supabase -> Instantly | Mailbox to warm |
| `sending_accounts.warmup_status` | Warmup status | Instantly -> Supabase | Active/Paused/Complete |
| `sending_accounts.health_score` | Health score | Instantly -> Supabase | Deliverability metric |

### 8C. Granola (Meeting Transcripts)

| Attribute | Value |
|---|---|
| **Direction** | Inbound only (read transcripts) |
| **Current state** | Not integrated |
| **MCP server** | Granola MCP (official, 5 tools) |
| **Auth** | Business plan required for API access |

| Granola Field | Supabase Column (Future) | Direction | Notes |
|---|---|---|---|
| `meeting.transcript` | `meetings.transcript` | Granola -> Supabase | Full meeting transcript |
| `meeting.summary` | `meetings.summary` | Granola -> Supabase | AI-generated summary |
| `meeting.title` | `meetings.title` | Granola -> Supabase | |
| `meeting.date` | `meetings.date` | Granola -> Supabase | |
| `meeting.attendees[]` | `meetings.attendees` | Granola -> Supabase | JSON array of attendee emails |
| (Claude-extracted) | `opportunities.meddpic_*` | Supabase -> HubSpot | MEDDPIC updates from transcript analysis |
| (Claude-extracted) | `contact_activities.type = 'meeting'` | Supabase | Activity log entry |

### 8D. Google Workspace (Calendar + Gmail)

| Attribute | Value |
|---|---|
| **Direction** | Read (calendar events, sent emails), Write (draft emails) |
| **MCP server** | `taylorwilsdon/google_workspace_mcp` |

| Google Field | Supabase Column (Future) | Direction | Notes |
|---|---|---|---|
| Calendar event attendees | (used by Pre-Meeting Brief agent) | Google -> Agent | Not stored in Supabase; used in-flight |
| Gmail sent emails | (used for voice analysis) | Google -> Agent | One-time analysis for tone guidelines |
| Gmail draft | (created by Meeting Follow-up agent) | Agent -> Google | Draft created on human approval |

### 8E. Google Ads + LinkedIn Ads

| Attribute | Value |
|---|---|
| **Direction** | Outbound (audience lists from HubSpot) |
| **Integration** | HubSpot native sync to Google Customer Match + LinkedIn Matched Audiences |

No direct Supabase integration. HubSpot contact lists are the source for ad audience sync.

| HubSpot List | Ad Platform | Audience Type | Notes |
|---|---|---|---|
| ICP Tier 1+2 companies | LinkedIn | Company targeting | Awareness campaigns |
| Active opportunity contacts | Google Ads | Customer Match | Remarketing |
| Website visitors (Common Room) | Google Ads | Remarketing | Via Google Ads tag |

---

## 9. Sync Architecture Summary

### Per-Integration Overview

| System | Direction | Trigger | Frequency | ID Match Key | Conflict Winner |
|---|---|---|---|---|---|
| **HubSpot** | Bidirectional | Event (webhook, API call) + Weekly batch | Real-time + weekly | `email` (contacts), `domain` (companies), `hubspot_id` | HubSpot for engagement/lifecycle; Supabase for classification/enrichment |
| **Apollo** | Bidirectional | On-demand (human gate) + Scheduled (re-enrichment) | On-demand + 60-day cycle | `email`, `apollo_contact_id`, `linkedin_url` | Apollo for enrichment data; Supabase for classification |
| **Clay** | Bidirectional | On-demand (Tier 1/2 accounts) | On-demand | `email` (contact), `domain` (company) | Clay overwrites Apollo for overlapping enrichment fields |
| **Common Room** | Inbound primarily | Real-time webhook | Real-time | `email` (person-level), `domain` (company-level) | Common Room signals are additive only |
| **Slack** | Bidirectional | Event-driven | Real-time | N/A (notifications, not data sync) | N/A |
| **Vercel Sandbox** | Internal processing | Event-driven (classification/persona requests) | On-demand | N/A (ephemeral) | Agent output subject to human review |
| **HeyReach** | Outbound only | On-demand (human approval) | On-demand | `linkedin_url` | N/A (one-way push) |
| **Instantly** | Read + Configure | Scheduled (warmup monitoring) | Daily | Sending mailbox email | Instantly for deliverability data |
| **Granola** | Inbound only | Post-meeting (agent-triggered) | On-demand | Meeting ID / attendee emails | N/A (read-only source) |
| **Google Ads** | Outbound via HubSpot | Native HubSpot sync | Automatic | HubSpot list membership | N/A |
| **LinkedIn Ads** | Outbound via HubSpot | Native HubSpot sync | Automatic | HubSpot list membership | N/A |

### Data Flow Diagram (Logical)

```
                         INBOUND                              OUTBOUND
                    ┌──────────────┐                    ┌──────────────┐
                    │  Common Room  │                    │   HubSpot    │
                    │  (signals)    │───webhook──┐      │   (CRM)      │◄──── contacts, companies,
                    └──────────────┘            │      └──────────────┘      deals, MEDDPIC, lifecycle
                    ┌──────────────┐            │      ┌──────────────┐
                    │    Apollo     │            │      │    Apollo     │
                    │  (enrichment) │───API────┐ │      │  (sequences)  │◄──── enroll contacts,
                    └──────────────┘          │ │      └──────────────┘      create contacts
                    ┌──────────────┐          │ │      ┌──────────────┐
                    │     Clay      │          │ │      │     Clay      │
                    │  (deep enrich)│──webhook─┤ │      │  (push data)  │◄──── contact/company data
                    └──────────────┘          │ │      └──────────────┘      for enrichment
                    ┌──────────────┐          │ │      ┌──────────────┐
                    │   HubSpot     │          │ │      │   HeyReach    │
                    │  (webhooks)   │──webhook─┤ │      │  (LinkedIn)   │◄──── contacts for outreach
                    └──────────────┘          │ │      └──────────────┘
                    ┌──────────────┐          ▼ ▼      ┌──────────────┐
                    │    Slack      │    ┌──────────┐   │    Slack      │
                    │  (commands)   │───►│ SUPABASE │──►│  (alerts)     │
                    └──────────────┘    │ POSTGRES  │   └──────────────┘
                    ┌──────────────┐    │          │   ┌──────────────┐
                    │   Granola     │    │ contacts │   │   Gmail       │
                    │ (transcripts) │───►│ accounts │──►│  (drafts)     │
                    └──────────────┘    │ companies│   └──────────────┘
                    ┌──────────────┐    │ signals  │
                    │ Google Cal    │    │ opps     │
                    │ (events)      │───►│ deals    │
                    └──────────────┘    │ meetings │
                                       │ activities│
                                       └──────────┘
                                            │
                                    ┌───────┴───────┐
                                    │ Vercel Sandbox │
                                    │ (Claude Agent) │
                                    │ Classification │
                                    │ Persona        │
                                    │ MEDDPIC extract│
                                    │ Deal scoring   │
                                    └────────────────┘
```

---

## 10. Custom HubSpot Properties to Create

All custom properties that need to be created in HubSpot before full integration. Grouped by property group.

### Property Group: "Reddy Intelligence" (Contact)

| Property Internal Name | Label | Type | Options |
|---|---|---|---|
| `persona_category` | Persona Category | Enumeration | CX Leadership, L&D, QA, WFM, KM, Sales & Marketing, IT, Unknown |
| `buying_role` | Buying Role | Enumeration | Champion, Economic Buyer, Technical Evaluator, End User, Coach, Blocker, Unknown |
| `seniority_level` | Seniority Level | Enumeration | C-Suite, VP, Director, Manager, IC |
| `icp_fit_score` | ICP Fit Score | Number | 0-100 |
| `lead_source` | Lead Source (Reddy) | Enumeration | Conference (Pre), Conference (Post), Website Visitor, ABM, Inbound, Referral, Apollo Search |
| `conference_name` | Conference Name | Single-line text | |
| `is_competitor` | Is Competitor | Checkbox | |
| `is_disqualified` | Is Disqualified | Checkbox | |
| `disqualification_reason` | Disqualification Reason | Enumeration | Competitor, Wrong Role, Wrong Company Size, Bad Fit, Other |
| `apollo_contact_id` | Apollo Contact ID | Single-line text | |
| `linkedin_url` | LinkedIn URL | Single-line text | |
| `enrichment_source` | Enrichment Source | Enumeration | Apollo, Clay, Manual, Conference List |
| `last_enrichment_date` | Last Enrichment Date | Date | |
| `engagement_score` | Engagement Score | Number | 0-100 |
| `sequence_status` | Sequence Status | Enumeration | Not Sequenced, Active, Completed, Replied, Opted Out |
| `sequence_name` | Sequence Name | Single-line text | |
| `outreach_priority` | Outreach Priority | Number | 1-3 |

### Property Group: "ABM Intelligence" (Company)

| Property Internal Name | Label | Type | Options |
|---|---|---|---|
| `account_tier` | Account Tier | Enumeration | Tier 1, Tier 2, Tier 3 |
| `account_status` | Account Status | Enumeration | Target, Prospecting, Engaged, Opportunity Open, Customer, Churned, Disqualified |
| `lead_source_original` | Original Lead Source | Enumeration | Conference, Website Visitor, ABM List, Inbound, Referral, Apollo Prospecting |
| `conference_source` | Conference Source | Single-line text | |
| `icp_fit_score` | ICP Fit Score | Number | 0-100 |
| `tech_stack_known` | Tech Stack | Multi-line text | |
| `competitor_present` | Competitor Present | Enumeration | None Known, [specific names], Multiple |
| `compelling_event` | Compelling Event | Single-line text | |
| `compelling_event_date` | Compelling Event Date | Date | |
| `warm_intro_available` | Warm Intro Available | Checkbox | |
| `warm_intro_path` | Warm Intro Path | Single-line text | |
| `last_enrichment_date` | Last Enrichment Date | Date | |
| `intent_signals` | Intent Signals | Multi-line text | |
| `account_plan_notes` | Account Plan Notes | Multi-line text | |
| `stakeholder_count` | Stakeholder Count | Number | |

### Property Group: "MEDDPIC" (Deal)

| Property Internal Name | Label | Type | Options |
|---|---|---|---|
| `meddpic_metrics_status` | Metrics Status | Enumeration | Not Started, Exploring, Identified, Validated |
| `meddpic_metrics_detail` | Metrics Detail | Multi-line text | |
| `meddpic_economic_buyer_status` | Economic Buyer Status | Enumeration | Not Started, Exploring, Identified, Validated |
| `meddpic_economic_buyer_detail` | Economic Buyer Detail | Multi-line text | |
| `meddpic_decision_criteria_status` | Decision Criteria Status | Enumeration | Not Started, Exploring, Identified, Validated |
| `meddpic_decision_criteria_detail` | Decision Criteria Detail | Multi-line text | |
| `meddpic_decision_process_status` | Decision Process Status | Enumeration | Not Started, Exploring, Identified, Validated |
| `meddpic_decision_process_detail` | Decision Process Detail | Multi-line text | |
| `meddpic_identify_pain_status` | Pain Status | Enumeration | Not Started, Exploring, Identified, Validated |
| `meddpic_identify_pain_detail` | Pain Detail | Multi-line text | |
| `meddpic_champion_status` | Champion Status | Enumeration | Not Started, Exploring, Identified, Validated |
| `meddpic_champion_detail` | Champion Detail | Multi-line text | |
| `meddpic_completion_score` | MEDDPIC Completion Score | Number | 0-100 (calculated) |

### Property Group: "Deal Intelligence" (Deal)

| Property Internal Name | Label | Type | Options |
|---|---|---|---|
| `deal_health_score` | Deal Health Score | Number | 0-100 |
| `days_in_current_stage` | Days in Current Stage | Number | |
| `single_thread_risk` | Single Thread Risk | Checkbox | |
| `competitor_in_evaluation` | Competitor in Evaluation | Enumeration | None, Unknown, [specific names] |
| `next_step` | Next Step | Single-line text | |
| `next_step_date` | Next Step Date | Date | |
| `last_meeting_date` | Last Meeting Date | Date | |
| `champion_engaged` | Champion Engaged | Checkbox | |
| `mutual_action_plan_link` | MAP Link | Single-line text | URL |

### Property Group: "Deal Closing" (Deal)

| Property Internal Name | Label | Type | Options |
|---|---|---|---|
| `procurement_status` | Procurement Status | Enumeration | Not Started, Security Review, Legal Review, Contract Redlines, Approved |
| `security_questionnaire_sent` | Security Questionnaire Sent | Checkbox | |
| `security_questionnaire_completed` | Security Questionnaire Completed | Checkbox | |
| `contract_type` | Contract Type | Enumeration | MSA + SOW, Single Agreement, PO-based |
| `decision_date_target` | Target Decision Date | Date | |
| `budget_confirmed` | Budget Confirmed | Checkbox | |
| `close_confidence` | Close Confidence | Enumeration | High (>75%), Medium (40-75%), Low (<40%) |
| `lost_reason` | Lost Reason | Enumeration | Price, Competitor, Timing, No Decision, Champion Left, Budget Cut, Product Gap |
| `lost_to_competitor` | Lost To Competitor | Single-line text | |
| `win_loss_notes` | Win/Loss Notes | Multi-line text | |
| `expansion_potential` | Expansion Potential | Enumeration | High, Medium, Low, None |
| `land_use_case` | Land Use Case | Single-line text | |

### Totals

| Object | Standard Properties Used | Custom Properties to Create |
|---|---|---|
| Contact | 9 | 17 |
| Company | 7 | 15 |
| Deal (Opportunity) | 5 | 22 |
| Deal (Closing) | 0 | 12 |
| **Total custom properties** | | **66** |

---

## 11. Expanded Schema Requirements

The current Supabase schema only covers company classification. The full GTM pipeline requires these additional tables.

### New Tables Needed

| Table | Purpose | Key Foreign Keys |
|---|---|---|
| `contacts` | Individual people (enriched from Apollo/Clay/conference lists) | `account_id` -> `accounts.id` |
| `accounts` | Companies as sales targets (distinct from classification `companies` table) | |
| `opportunities` | MEDDPIC opportunity pipeline deals | `account_id` -> `accounts.id` |
| `deals` | Closing pipeline deals (post-qualification) | `opportunity_id` -> `opportunities.id` |
| `contact_enrichments` | Raw enrichment payloads from Apollo/Clay per contact | `contact_id` -> `contacts.id` |
| `account_enrichments` | Raw enrichment payloads per account | `account_id` -> `accounts.id` |
| `signals` | Common Room / intent signals per account | `account_id` -> `accounts.id` |
| `contact_activities` | Activity log (emails, meetings, calls, sequences) | `contact_id` -> `contacts.id` |
| `meetings` | Meeting transcripts and summaries from Granola | |
| `sending_accounts` | Email warmup tracking for Instantly | |

### Relationship: `companies` (classification) vs. `accounts` (sales)

The existing `companies` table tracks classification decisions (exclude/tag/prospect). The new `accounts` table tracks companies as sales targets with enrichment data, tier, status, and deal associations. A prospect in `companies` may become a row in `accounts` when promoted to active pipeline.

| companies (existing) | accounts (new) |
|---|---|
| Classification decisions | Sales pipeline tracking |
| 305 rows (mostly exclusions) | Grows as prospects are activated |
| `action`: exclude/tag/prospect | `status`: Target/Prospecting/Engaged/etc. |
| No enrichment data | Full enrichment (Apollo, Clay, Common Room) |
| No HubSpot sync | Bidirectional HubSpot sync |

### Cross-System ID Map

Every record in Supabase should store external IDs for deduplication and sync:

| Supabase Table | External ID Columns | Match Strategy |
|---|---|---|
| `contacts` | `hubspot_id`, `apollo_contact_id`, `common_room_id` | Primary: `email`; Secondary: `linkedin_url` |
| `accounts` | `hubspot_company_id`, `apollo_org_id`, `common_room_org_id` | Primary: `domain`; Secondary: `name` fuzzy match |
| `opportunities` | `hubspot_deal_id` | Primary: `hubspot_deal_id` |
| `deals` | `hubspot_deal_id` | Primary: `hubspot_deal_id` (separate pipeline) |
| `companies` | (none currently) | `name` + `aliases` fuzzy match |

---

*Generated by Integration Mapper agent. Source files analyzed:*
- *`reddy-gtm-strategy.md` -- full GTM strategy with HubSpot data model, workflows, and tool stack*
- *`docs/superpowers/specs/2026-03-28-company-classification-system-design.md` -- classification system design*
- *`docs/superpowers/plans/2026-03-28-company-classification-system.md` -- implementation plan*
- *`src/lib/schema.ts` -- current Drizzle ORM schema (companies, company_aliases, categories)*
- *`src/lib/types.ts` -- TypeScript types (ReviewData, Persona, HubSpotCompanyMatch)*
- *`src/lib/database.ts` -- Supabase database operations (fetchCompanyLists, commitCompanyListUpdates)*
- *`src/lib/agent.ts` -- Vercel Sandbox agent with HubSpot search_hubspot tool*
- *`src/lib/persona.ts` -- Persona classification agent (7 buyer personas)*
- *`src/app/api/hubspot/lookup/route.ts` -- server-side HubSpot contact search*
- *`src/app/api/webhook/[source]/route.ts` -- inbound webhook handler (Common Room, Apollo, HubSpot)*
- *`src/lib/slack.ts` -- Slack messaging (review notifications, commit confirmations)*
- *`src/lib/db.ts` -- Drizzle + Supabase Postgres connection*
