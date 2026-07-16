# HubSpot Field Mapping

Complete field-level mapping between every Supabase column and its corresponding HubSpot property. Includes sync direction, transformation logic, custom property creation requirements, sync triggers, and conflict resolution rules.

---

## 1. Contact Properties

### Standard HubSpot Contact Properties (already exist)

| Supabase Column | HubSpot Property | HubSpot Type | Sync Direction | Transform | Notes |
|---|---|---|---|---|---|
| `contacts.email` | `email` | string | Bidirectional | None | **Primary match key.** Used to find/deduplicate contacts across systems. |
| `contacts.first_name` | `firstname` | string | Bidirectional | None | |
| `contacts.last_name` | `lastname` | string | Bidirectional | None | |
| `contacts.title` | `jobtitle` | string | Bidirectional | None | |
| `contacts.company_name` | `company` | string | Bidirectional | None | Denormalized company name for display |
| `contacts.phone` | `phone` | string | Supabase -> HubSpot | None | Sourced from Apollo/Clay enrichment |
| `contacts.lifecycle_stage` | `lifecyclestage` | enumeration | HubSpot -> Supabase | Map: subscriber/lead/marketingqualifiedlead/salesqualifiedlead/opportunity/customer/evangelist | HubSpot is authoritative. Only advances forward. |
| `contacts.lead_status` | `hs_lead_status` | enumeration | HubSpot -> Supabase | Map standard values | HubSpot is authoritative |
| `contacts.city` | `city` | string | Supabase -> HubSpot | None | From enrichment |
| `contacts.state` | `state` | string | Supabase -> HubSpot | None | From enrichment |
| `contacts.country` | `country` | string | Supabase -> HubSpot | None | From enrichment |

### Custom HubSpot Contact Properties (must be created)

**Property Group: "Reddy Intelligence"**

| Supabase Column | HubSpot Property | HubSpot Type | Sync Direction | Transform | Options / Notes |
|---|---|---|---|---|---|
| `contacts.persona` | `persona_category` | Enumeration | Supabase -> HubSpot | Map enum: `cx_leadership` -> "CX Leadership", `ld` -> "L&D", `qa` -> "QA", `wfm` -> "WFM", `km` -> "KM", `sales_marketing` -> "Sales & Marketing", `it` -> "IT", `unknown` -> "Unknown" | Do NOT sync `excluded` persona contacts. Filter them out before sync. |
| `contacts.buying_role` | `buying_role` | Enumeration | Supabase -> HubSpot | Map enum: `champion` -> "Champion", `economic_buyer` -> "Economic Buyer", `technical_evaluator` -> "Technical Evaluator", etc. | Options: Champion, Economic Buyer, Technical Evaluator, End User, Coach, Blocker, Unknown |
| `contacts.seniority` | `seniority_level` | Enumeration | Supabase -> HubSpot | Map: `c_suite` -> "C-Suite", `vp` -> "VP", `director` -> "Director", `manager` -> "Manager", `ic` -> "IC" | From Apollo enrichment |
| `contacts.lead_source` | `lead_source` | Enumeration | Supabase -> HubSpot | Map: `conference_pre` -> "Conference (Pre)", `conference_post` -> "Conference (Post)", `website_visitor` -> "Website Visitor", `abm` -> "ABM", `inbound` -> "Inbound", `referral` -> "Referral", `apollo_search` -> "Apollo Search" | Set once on first creation; do not overwrite |
| `contacts.conference_name` | `conference_name` | Single-line text | Supabase -> HubSpot | None | Which specific conference |
| `contacts.is_competitor` | `is_competitor` | Checkbox | Supabase -> HubSpot | Boolean to checkbox | Derived from company classification: `companies.action == 'exclude'` |
| `contacts.is_disqualified` | `is_disqualified` | Checkbox | Supabase -> HubSpot | Boolean to checkbox | |
| `contacts.disqualification_reason` | `disqualification_reason` | Enumeration | Supabase -> HubSpot | Map enum: `competitor` -> "Competitor", `wrong_role` -> "Wrong Role", `wrong_company_size` -> "Wrong Company Size", `bad_fit` -> "Bad Fit", `other` -> "Other" | **Updated:** Now a proper enum in Supabase (was text). Options match HubSpot enumeration. |
| `contacts.apollo_contact_id` | `apollo_contact_id` | Single-line text | Supabase -> HubSpot | None | Cross-system ID link |
| `contacts.linkedin_url` | `linkedin_url` | Single-line text | Supabase -> HubSpot | None | From Apollo/Clay enrichment |
| `contacts.last_enrichment_source` | `enrichment_source` | Enumeration | Supabase -> HubSpot | Map enum values | Options: Apollo, Clay, Manual, Conference List |
| `contacts.last_enrichment_date` | `last_enrichment_date` | Date | Supabase -> HubSpot | ISO date string | Freshness tracking |
| `contacts.engagement_score` | `engagement_score` | Number | HubSpot -> Supabase | None | Calculated by HubSpot workflows from activity data |
| `contacts.sequence_status` | `sequence_status` | Enumeration | Apollo -> Supabase -> HubSpot | Map enum values | Options: Not Sequenced, Active, Completed, Replied, Opted Out. Apollo native sync may also write this. |
| `contacts.sequence_name` | `sequence_name` | Single-line text | Supabase -> HubSpot | None | Which Apollo sequence |
| `contacts.outreach_priority` | `outreach_priority` | Number | Supabase -> HubSpot | None | 1 (highest) to 3 (lowest) |
| `contacts.icp_fit_score` | `icp_fit_score` | Number | Supabase -> HubSpot | None | 0-100, calculated by Claude |
| `contacts.email_status` | `email_deliverability_status` | Enumeration | Supabase -> HubSpot | Map enum: `valid` -> "Valid", `risky` -> "Risky", `invalid` -> "Invalid", `bounced` -> "Bounced", `unknown` -> "Unknown" | **New.** More nuanced than the boolean `email_verified`. Tracks deliverability from Apollo/Clay verification. |
| `contacts.linkedin_outreach_status` | `linkedin_outreach_status` | Enumeration | Supabase -> HubSpot | Map enum: `not_contacted` -> "Not Contacted", `request_sent` -> "Request Sent", `connected` -> "Connected", `messaged` -> "Messaged" | **New.** Tracks HeyReach LinkedIn outreach state. Updated manually since HeyReach has no return data feed. |
| `contacts.previous_company_name` | `previous_company` | Single-line text | Supabase -> HubSpot | None | **New.** Set when Apollo re-enrichment detects a job change. |
| `contacts.job_change_detected_at` | `job_change_date` | Date | Supabase -> HubSpot | ISO date string | **New.** When the job change was detected during re-enrichment. |

---

## 2. Company Properties

### Standard HubSpot Company Properties (already exist)

| Supabase Column | HubSpot Property | HubSpot Type | Sync Direction | Transform | Notes |
|---|---|---|---|---|---|
| `accounts.name` | `name` | string | Bidirectional | None | Primary display name |
| `accounts.domain` | `domain` | string | Bidirectional | None | **Secondary match key** for HubSpot company dedup |
| `accounts.industry` | `industry` | string | Supabase -> HubSpot | None | From Apollo/Clay enrichment |
| `accounts.employee_count` | `numberofemployees` | number | Supabase -> HubSpot | None | From enrichment |
| `accounts.annual_revenue` | `annualrevenue` | number | Supabase -> HubSpot | None | From enrichment |
| `accounts.city` | `city` | string | Bidirectional | None | |
| `accounts.state` | `state` | string | Bidirectional | None | |
| `accounts.country` | `country` | string | Bidirectional | None | |

### Custom HubSpot Company Properties (must be created)

**Property Group: "ABM Intelligence"**

| Supabase Column | HubSpot Property | HubSpot Type | Sync Direction | Transform | Options / Notes |
|---|---|---|---|---|---|
| `accounts.tier` | `account_tier` | Enumeration | Supabase -> HubSpot | Map: `tier_1` -> "Tier 1", `tier_2` -> "Tier 2", `tier_3` -> "Tier 3" | ABM prioritization |
| `accounts.status` | `account_status` | Enumeration | Bidirectional | Map enum values | Options: Target, Prospecting, Engaged, Opportunity Open, Customer, Churned, Disqualified |
| `accounts.lead_source_original` | `lead_source_original` | Enumeration | Supabase -> HubSpot | Map enum values | Options: Conference, Website Visitor, ABM List, Inbound, Referral, Apollo Prospecting |
| `accounts.conference_source` | `conference_source` | Single-line text | Supabase -> HubSpot | None | Which conference |
| `accounts.icp_fit_score` | `icp_fit_score` | Number | Supabase -> HubSpot | None | 0-100, Claude-calculated |
| `accounts.tech_stack` | `tech_stack_known` | Multi-line text | Supabase -> HubSpot | `JSON.stringify(techStack)` or comma-separated | From Clay/Apollo BuiltWith data |
| `accounts.competitor_present` | `competitor_present` | Enumeration | Supabase -> HubSpot | Map to dropdown | Options: None Known, [specific competitor names], Multiple |
| `accounts.compelling_event` | `compelling_event` | Single-line text | Supabase -> HubSpot | None | Why buy now |
| `accounts.compelling_event_date` | `compelling_event_date` | Date | Supabase -> HubSpot | ISO date | When the event hits |
| `accounts.warm_intro_available` | `warm_intro_available` | Checkbox | Supabase -> HubSpot | Boolean to checkbox | |
| `accounts.warm_intro_path` | `warm_intro_path` | Single-line text | Supabase -> HubSpot | None | Who can intro to whom |
| `accounts.last_enrichment_date` | `last_enrichment_date` | Date | Supabase -> HubSpot | ISO date | Data freshness |
| `accounts.intent_signals` | `intent_signals` | Multi-line text | Supabase -> HubSpot | None | Job postings, funding, G2, etc. |
| `accounts.account_plan_notes` | `account_plan_notes` | Multi-line text | Supabase -> HubSpot | None | Strategic notes |
| `accounts.stakeholder_count` | `stakeholder_count` | Number | HubSpot -> Supabase | Calculated from contact associations | Single-thread risk indicator |
| `accounts.intent_score` | `intent_score` | Number | Supabase -> HubSpot | None | **New.** Bombora/Clay intent score rollup. 0-100. Updated during Clay enrichment. |
| `accounts.referred_by_account_id` | `referred_by_company` | Single-line text | Supabase -> HubSpot | Resolve account UUID to company name | **New.** Which customer referred this account. Stored as company name in HubSpot for readability. |

### Derived Properties (no direct column, computed during sync)

| Source | HubSpot Property | Logic | Notes |
|---|---|---|---|
| `companies.action == 'exclude'` | Company `is_competitor` tag | If a company is classified as "exclude", any HubSpot company with matching name/domain gets tagged | Applied via HubSpot company property or list membership |
| `companies.category` | Company tag label | The category label (e.g., "CCaaS", "BPO") can be pushed as a HubSpot company note or tag | Informational only |

---

## 3. Opportunity Pipeline Deal Properties

### Standard HubSpot Deal Properties

| Supabase Column | HubSpot Property | HubSpot Type | Sync Direction | Notes |
|---|---|---|---|---|
| `opportunities.name` | `dealname` | string | Bidirectional | |
| `opportunities.stage` | `dealstage` | enumeration | Bidirectional | Map to custom pipeline stage IDs (see Pipeline Stages below) |
| `opportunities.amount` | `amount` | number | Bidirectional | |
| `opportunities.close_date` | `closedate` | date | Bidirectional | |
| `opportunities.owner_id` | `hubspot_owner_id` | number | Bidirectional | HubSpot user ID |

### Custom MEDDPIC Deal Properties (must be created)

**Property Group: "MEDDPIC"**

| Supabase Column | HubSpot Property | HubSpot Type | Sync Direction | Transform |
|---|---|---|---|---|
| `opportunities.meddpic_metrics_status` | `meddpic_metrics_status` | Enumeration | Bidirectional | Map: `not_started` -> "Not Started", `exploring` -> "Exploring", `identified` -> "Identified", `validated` -> "Validated" |
| `opportunities.meddpic_metrics_detail` | `meddpic_metrics_detail` | Multi-line text | Bidirectional | None |
| `opportunities.meddpic_economic_buyer_status` | `meddpic_economic_buyer_status` | Enumeration | Bidirectional | Same 4-value mapping |
| `opportunities.meddpic_economic_buyer_detail` | `meddpic_economic_buyer_detail` | Multi-line text | Bidirectional | None |
| `opportunities.meddpic_decision_criteria_status` | `meddpic_decision_criteria_status` | Enumeration | Bidirectional | Same 4-value mapping |
| `opportunities.meddpic_decision_criteria_detail` | `meddpic_decision_criteria_detail` | Multi-line text | Bidirectional | None |
| `opportunities.meddpic_decision_process_status` | `meddpic_decision_process_status` | Enumeration | Bidirectional | Same 4-value mapping |
| `opportunities.meddpic_decision_process_detail` | `meddpic_decision_process_detail` | Multi-line text | Bidirectional | None |
| `opportunities.meddpic_identify_pain_status` | `meddpic_identify_pain_status` | Enumeration | Bidirectional | Same 4-value mapping |
| `opportunities.meddpic_identify_pain_detail` | `meddpic_identify_pain_detail` | Multi-line text | Bidirectional | None |
| `opportunities.meddpic_champion_status` | `meddpic_champion_status` | Enumeration | Bidirectional | Same 4-value mapping |
| `opportunities.meddpic_champion_detail` | `meddpic_champion_detail` | Multi-line text | Bidirectional | None |
| `opportunities.meddpic_completion_score` | `meddpic_completion_score` | Number | Supabase -> HubSpot | Calculated: count of "validated" statuses / 6 * 100 |

### Custom Deal Intelligence Properties (must be created)

**Property Group: "Deal Intelligence"**

| Supabase Column | HubSpot Property | HubSpot Type | Sync Direction | Notes |
|---|---|---|---|---|
| `opportunities.deal_health_score` | `deal_health_score` | Number | Supabase -> HubSpot | Composite 0-100, calculated weekly by Deal Health agent |
| `opportunities.days_in_current_stage` | `days_in_current_stage` | Number | HubSpot -> Supabase | Calculated from `stage_entered_at` or HubSpot workflow |
| `opportunities.single_thread_risk` | `single_thread_risk` | Checkbox | HubSpot -> Supabase | True if only 1 contact associated after 14 days |
| `opportunities.competitor_in_evaluation` | `competitor_in_evaluation` | Enumeration | Bidirectional | Options: None, Unknown, [specific names] |
| `opportunities.next_step` | `next_step` | Single-line text | Bidirectional | Agreed next action |
| `opportunities.next_step_date` | `next_step_date` | Date | Bidirectional | When |
| `opportunities.last_meeting_date` | `last_meeting_date` | Date | HubSpot -> Supabase | From engagement tracking |
| `opportunities.champion_engaged` | `champion_engaged` | Checkbox | HubSpot -> Supabase | Active in last 14 days |
| `opportunities.mutual_action_plan_link` | `mutual_action_plan_link` | Single-line text | Supabase -> HubSpot | URL to MAP document |
| `opportunities.last_activity_date` | `last_activity_date` | Date | Supabase -> HubSpot | **New.** Denormalized rollup from contact_activities. Updated when engagement events are logged for contacts on this deal. Used in deal health scoring. |

### Opportunity Pipeline Stages (must be created in HubSpot)

| Stage Internal Name | Stage Display Name | Supabase Enum | Win Probability |
|---|---|---|---|
| `target_identified` | Target Identified | `target_identified` | 5% |
| `outreach_active` | Outreach Active | `outreach_active` | 10% |
| `discovery` | Discovery | `discovery` | 20% |
| `qualification_in_progress` | Qualification In Progress | `qualification_in_progress` | 40% |
| `fully_qualified` | Fully Qualified | `fully_qualified` | 60% |
| `disqualified` | Disqualified | `disqualified` | 0% (closed-lost) |

---

## 4. Deal Pipeline (Closing) Properties

### Custom Closing Properties (must be created)

**Property Group: "Deal Closing"**

| Supabase Column | HubSpot Property | HubSpot Type | Sync Direction | Notes |
|---|---|---|---|---|
| `deals.procurement_status` | `procurement_status` | Enumeration | Bidirectional | Options: Not Started, Security Review, Legal Review, Contract Redlines, Approved |
| `deals.security_questionnaire_sent` | `security_questionnaire_sent` | Checkbox | Bidirectional | |
| `deals.security_questionnaire_completed` | `security_questionnaire_completed` | Checkbox | Bidirectional | |
| `deals.contract_type` | `contract_type` | Enumeration | Bidirectional | Options: MSA + SOW, Single Agreement, PO-based |
| `deals.decision_date_target` | `decision_date_target` | Date | Bidirectional | |
| `deals.budget_confirmed` | `budget_confirmed` | Checkbox | Bidirectional | |
| `deals.close_confidence` | `close_confidence` | Enumeration | Bidirectional | Options: High (>75%), Medium (40-75%), Low (<40%) |
| `deals.lost_reason` | `lost_reason` | Enumeration | HubSpot -> Supabase | Required on close-lost. Options: Price, Competitor, Timing, No Decision, Champion Left, Budget Cut, Product Gap |
| `deals.lost_to_competitor` | `lost_to_competitor` | Single-line text | HubSpot -> Supabase | Which competitor won |
| `deals.win_loss_notes` | `win_loss_notes` | Multi-line text | HubSpot -> Supabase | Post-mortem learnings |
| `deals.expansion_potential` | `expansion_potential` | Enumeration | Bidirectional | Options: High, Medium, Low, None |
| `deals.land_use_case` | `land_use_case` | Single-line text | Bidirectional | What they bought first |

### Deal Pipeline Stages (must be created in HubSpot)

| Stage Internal Name | Stage Display Name | Supabase Enum | Win Probability |
|---|---|---|---|
| `solution_design` | Solution Design | `solution_design` | 65% |
| `proposal_delivered` | Proposal Delivered | `proposal_delivered` | 70% |
| `technical_evaluation` | Technical Evaluation | `technical_evaluation` | 75% |
| `business_case_roi` | Business Case / ROI | `business_case_roi` | 80% |
| `procurement_legal_security` | Procurement / Legal / Security | `procurement_legal_security` | 85% |
| `final_negotiation` | Final Negotiation | `final_negotiation` | 90% |
| `closed_won` | Closed Won | `closed_won` | 100% |
| `closed_lost` | Closed Lost | `closed_lost` | 0% |

---

## 5. Meeting Engagement Properties (new)

Meetings in Supabase sync to HubSpot as engagement activities (meetings). The `meetings` table stores Granola transcripts and Claude-extracted intelligence; HubSpot stores the meeting engagement record for CRM visibility.

### HubSpot Engagement (Meeting) Properties

| Supabase Column | HubSpot Property | HubSpot Type | Sync Direction | Transform | Notes |
|---|---|---|---|---|---|
| `meetings.hubspot_meeting_id` | Engagement ID | string | Bidirectional | None | **Primary link.** Created on first sync, stored for subsequent updates. |
| `meetings.title` | `hs_meeting_title` | string | Supabase -> HubSpot | None | Meeting subject line |
| `meetings.meeting_date` | `hs_meeting_start_time` | datetime | Supabase -> HubSpot | ISO 8601 | When the meeting occurred |
| `meetings.summary` | `hs_meeting_body` | string (rich text) | Supabase -> HubSpot | Markdown to HTML | Granola or Claude-generated summary pushed as meeting body |
| `meetings.attendees` | Associated contacts | Association | Supabase -> HubSpot | Extract emails from attendees JSON, match to HubSpot contact IDs | Each attendee email is resolved to a HubSpot contact and associated to the meeting engagement |
| `meetings.source` | `hs_meeting_source` | Enumeration | Supabase -> HubSpot | Map: "granola" -> "THIRD_PARTY", "apollo_ci" -> "THIRD_PARTY", "manual" -> "CRM_UI" | HubSpot meeting source type |

### Custom Meeting Properties (must be created)

**Property Group: "Meeting Intelligence"**

| Supabase Column | HubSpot Property | HubSpot Type | Sync Direction | Notes |
|---|---|---|---|---|
| `meetings.meddpic_extractions` | `meeting_meddpic_updates` | Multi-line text | Supabase -> HubSpot | JSON stringified or formatted summary of MEDDPIC updates extracted from this meeting |
| `meetings.competitive_intel` | `meeting_competitive_intel` | Multi-line text | Supabase -> HubSpot | Formatted: competitors mentioned, objections raised, buying signals detected |
| `meetings.action_items` | `meeting_action_items` | Multi-line text | Supabase -> HubSpot | Formatted list of action items extracted from the meeting |

### Meeting Sync Logic

1. When a meeting is stored in Supabase, check if `hubspot_meeting_id` exists.
2. If null: create a new HubSpot meeting engagement via `POST /crm/v3/objects/meetings`.
3. Associate the meeting to the HubSpot company (via `accounts.hubspot_company_id`) and deal (via `opportunities.hubspot_deal_id`).
4. For each attendee email, resolve to a HubSpot contact ID and associate.
5. Store returned HubSpot engagement ID in `meetings.hubspot_meeting_id`.
6. Log the sync in `sync_log`.

---

## 6. Contact Activity -> HubSpot Timeline Events (new)

Contact activities in Supabase represent granular engagement events. Most of these are already tracked natively in HubSpot via Apollo and HubSpot's own tracking. The sync is primarily **inbound** (HubSpot -> Supabase) to populate `contact_activities` for local deal health scoring.

### Inbound Sync (HubSpot -> Supabase)

| HubSpot Event | Activity Type | Source | What Gets Stored |
|---|---|---|---|
| Email open (from Apollo sequence) | `email_open` | `apollo` | `metadata: {sequence_name, step_number, email_subject}` |
| Email click (from Apollo sequence) | `email_click` | `apollo` | `metadata: {sequence_name, step_number, url_clicked}` |
| Email reply (from Apollo sequence) | `email_reply` | `apollo` | `metadata: {sequence_name, step_number}` |
| Email bounce (from Apollo sequence) | `email_bounce` | `apollo` | `metadata: {sequence_name, bounce_type}` |
| Meeting logged in HubSpot | `meeting` | `hubspot` | `metadata: {meeting_title, hubspot_engagement_id}` |
| Call logged in HubSpot | `call` | `hubspot` | `metadata: {call_duration, call_outcome, hubspot_engagement_id}` |
| Website visit (Common Room) | `website_visit` | `common_room` | `metadata: {page_url, visit_duration, signal_id}` |
| LinkedIn connection (HeyReach manual log) | `linkedin_connection` | `heyreach` | `metadata: {linkedin_url}` |
| LinkedIn message (HeyReach manual log) | `linkedin_message` | `heyreach` | `metadata: {linkedin_url, message_type}` |

### Outbound Sync (Supabase -> HubSpot)

Contact activities that originate in Supabase (e.g., from the meeting intelligence agent logging a meeting activity) can be pushed to HubSpot as timeline events via the Timeline Events API (`POST /crm/v3/timeline/events`).

| Activity Type | HubSpot Timeline Event | When |
|---|---|---|
| `meeting` (from meeting intelligence agent) | Custom timeline event: "Meeting Processed by Reddy" | When a Granola meeting is processed and stored in the `meetings` table |

### Activity -> Opportunity Rollup

When a `contact_activities` row is inserted:
1. Check if the contact has any associated opportunities via `contact_deal_roles`.
2. For each associated opportunity, update `opportunities.last_activity_date` to the maximum of its current value and the new `contact_activities.activity_date`.
3. This ensures deal health scoring can read `last_activity_date` directly from the opportunities table without querying contact_activities at scoring time.

---

## 7. Sending Accounts (no HubSpot sync)

The `sending_accounts` table does **not** sync to HubSpot. Sending mailbox health and warmup status are internal operational data managed via Instantly. HubSpot does not need visibility into sending infrastructure.

---

## 8. Association Labels (Contact <-> Deal)

Custom association labels that must be created in HubSpot to represent buying committee roles. These correspond to the `contact_deal_roles.role` column in Supabase.

| Label | Supabase Enum Value | Purpose |
|---|---|---|
| Champion | `champion` | Internal seller/advocate |
| Economic Buyer | `economic_buyer` | Budget authority |
| Technical Evaluator | `technical_evaluator` | Evaluates technical fit |
| Decision Maker | `decision_maker` | Final decision authority |
| Coach / Guide | `coach` | Internal advisor |
| Blocker | `blocker` | Opposes the deal |
| End User | `end_user` | Will use the product |
| Legal / Procurement | `legal_procurement` | Contract/compliance review |
| Executive Sponsor | `executive_sponsor` | Senior executive backing |

**API for creation:** `POST /crm/v3/associations/{fromObjectType}/{toObjectType}/labels`

---

## 9. Sync Triggers

### Event-Based Triggers (real-time)

| Trigger Event | Direction | What Syncs | HubSpot API | Supabase Table |
|---|---|---|---|---|
| Classification review committed | Supabase -> HubSpot | Company `is_competitor` flag for excluded companies; BPO/media tag | `PATCH /crm/v3/objects/companies/{id}` | `companies` |
| New contact created from conference list | Supabase -> HubSpot | Full contact with persona, lead source, conference name, email_status, linkedin_outreach_status | `POST /crm/v3/objects/contacts` or batch create | `contacts` |
| Contact enriched (Apollo/Clay) | Supabase -> HubSpot | Updated email, phone, title, seniority, linkedin_url, enrichment_source, enrichment_date, email_status, employment_history | `PATCH /crm/v3/objects/contacts/{id}` | `contacts`, `enrichment_runs` |
| Job change detected | Supabase -> HubSpot | `previous_company_name`, `job_change_detected_at`, updated `company_name` and `title` | `PATCH /crm/v3/objects/contacts/{id}` | `contacts` |
| Sequence enrolled | Apollo -> HubSpot (native) + Supabase update | sequence_status = "active", sequence_name | Native Apollo sync + Supabase `contacts` update | `contacts` |
| Contact replied to sequence | Apollo -> HubSpot (native) + Supabase update | sequence_status = "replied" | Native Apollo sync + Supabase update | `contacts` |
| Meeting processed (post-meeting agent) | Supabase -> HubSpot | Meeting engagement with summary, attendee associations, MEDDPIC extractions, competitive intel, action items | `POST /crm/v3/objects/meetings` + associations | `meetings` |
| Meeting follow-up approved | Supabase -> HubSpot | MEDDPIC field updates, deal stage change, task creation | `PATCH /crm/v3/objects/deals/{id}`, `POST /crm/v3/objects/tasks` | `opportunities` |
| Opportunity created | Supabase -> HubSpot | New deal in Opportunity Pipeline with account association | `POST /crm/v3/objects/deals` + association | `opportunities` |
| Opportunity stage changed | Supabase -> HubSpot | New stage, stage_entered_at reset | `PATCH /crm/v3/objects/deals/{id}` | `opportunities` |
| Deal converted from opportunity | Supabase -> HubSpot | New deal in Deal Pipeline with all carry-forward data | `POST /crm/v3/objects/deals` | `deals` |
| Contact associated to deal | Supabase -> HubSpot | Contact-deal association with buying role label | `POST /crm/v3/associations/contacts/deals/batch/create` | `contact_deal_roles` |
| Account enriched | Supabase -> HubSpot | Industry, employee count, revenue, tech stack, funding, intent_score, referred_by_company | `PATCH /crm/v3/objects/companies/{id}` | `accounts` |
| Lifecycle stage changed (HubSpot) | HubSpot -> Supabase | lifecycle_stage update on contact | Webhook to `/api/webhook/hubspot` | `contacts` |
| HubSpot deal manually updated | HubSpot -> Supabase | MEDDPIC fields, lost_reason, win_loss_notes | Webhook to `/api/webhook/hubspot` | `opportunities`, `deals` |
| HubSpot engagement activity | HubSpot -> Supabase | Email opens, clicks, replies, meetings, calls logged as contact_activities | Webhook to `/api/webhook/hubspot` | `contact_activities` |

### Scheduled Triggers (batch/cron)

| Schedule | Direction | What Syncs | Purpose |
|---|---|---|---|
| Weekly (Sunday night) | HubSpot -> Supabase -> HubSpot | Pull all open deals, calculate deal_health_score (using local contact_activities for activity recency), write back | Deal health scoring |
| Weekly (Sunday night) | HubSpot -> Supabase | Pull days_in_current_stage, single_thread_risk, champion_engaged for all open deals | Refresh deal intelligence |
| Every 60 days | Supabase -> Apollo -> Supabase -> HubSpot | Re-enrich stale contacts (last_enrichment_date > 60 days ago). Detect job changes (update previous_company_name, job_change_detected_at). | Data freshness + job change detection |
| Daily | HubSpot -> Supabase | Pull engagement_score updates for active pipeline contacts | Keep engagement scores current |
| Daily | HubSpot -> Supabase | Pull stakeholder_count for active accounts | Single-thread risk detection |
| Daily | HubSpot -> Supabase | Pull recent engagement activities (opens, clicks, replies, meetings, calls) as contact_activities | Keep activity data current for deal health scoring |
| Hourly | Instantly -> Supabase | Pull warmup_status and health_score for all sending_accounts | Keep sending infrastructure health current |

---

## 10. Conflict Resolution Rules

| Scenario | Winner | Rationale |
|---|---|---|
| **Contact email differs** between Supabase and HubSpot | HubSpot | HubSpot is CRM system of record for contact communication data. Email may have been manually updated by sales rep. |
| **Contact title differs** | Most recent update wins | Titles change when people get promoted or change roles. Compare `last_enrichment_date` (Supabase) vs. last HubSpot update timestamp. |
| **Contact name differs** | HubSpot | Names may be corrected manually in HubSpot by sales reps who have spoken to the person. |
| **Persona category** | Supabase | Claude classification is authoritative. Push only, never pull. |
| **ICP fit score** | Supabase | Claude-calculated. Push to HubSpot as read-only display property. |
| **Lifecycle stage** | HubSpot | HubSpot workflows manage lifecycle advancement. Only moves forward (subscriber -> lead -> MQL -> SQL -> opportunity -> customer). Never regress. Supabase reads but does not write. |
| **Lead status** | HubSpot | Managed by sales reps in HubSpot. Supabase reads but does not write. |
| **Engagement score** | HubSpot | Calculated from HubSpot activity data. Supabase reads but does not write. |
| **Email status** | Supabase | Apollo/Clay verification is authoritative for deliverability. Push to HubSpot, never pull. |
| **LinkedIn outreach status** | Supabase | Manually tracked. Push to HubSpot for CRM visibility. |
| **MEDDPIC fields updated by agent** | Supabase proposes, human approves in Slack, then writes to HubSpot | Agent-extracted MEDDPIC never auto-writes. Must pass through human approval gate. |
| **MEDDPIC fields manually updated in HubSpot** | HubSpot | Human manual input always wins over agent extraction. Pull to Supabase on next sync. |
| **Deal health score** | Supabase | Calculated by Deal Health agent weekly. Push to HubSpot as read-only. |
| **Last activity date** | Supabase | Rollup from contact_activities. Push to HubSpot as read-only. Updated as activities are logged. |
| **Meeting data** | Supabase | Granola transcripts and Claude extractions are authoritative. Push summary to HubSpot meeting engagement. |
| **Sequence status** | Apollo (via native sync to HubSpot) | Apollo is the sequence system of record. Supabase reads from Apollo and passes through to HubSpot where native sync does not cover. |
| **Company enrichment data** (industry, size, revenue, tech stack) | Most recent enrichment | Clay overwrites Apollo for overlapping fields (Clay waterfall is more comprehensive). Compare enrichment timestamps. |
| **Account tier / status** | Supabase | Internal ABM decisions. Push to HubSpot, never pull. |
| **Intent score** | Supabase | Bombora/Clay data. Push to HubSpot, never pull. |
| **Referral attribution** | Supabase | Internal tracking. Push referred_by_company name to HubSpot. |
| **Lost reason / win-loss notes** | HubSpot | Captured by sales reps at deal close. Pull to Supabase for analysis. |

---

## 11. Custom HubSpot Properties Summary

### Total Properties to Create

| Object | Property Group | Count |
|---|---|---|
| Contact | Reddy Intelligence | 21 (+4 new: email_deliverability_status, linkedin_outreach_status, previous_company, job_change_date) |
| Company | ABM Intelligence | 17 (+2 new: intent_score, referred_by_company) |
| Deal | MEDDPIC | 13 |
| Deal | Deal Intelligence | 10 (+1 new: last_activity_date) |
| Deal | Deal Closing | 12 |
| Meeting | Meeting Intelligence | 3 (new: meeting_meddpic_updates, meeting_competitive_intel, meeting_action_items) |
| **Total** | | **76** |

### Custom Pipelines to Create

| Pipeline | Object | Stages |
|---|---|---|
| Opportunity Pipeline | Deal | 6 stages (Target Identified through Disqualified) |
| Deal Pipeline | Deal | 8 stages (Solution Design through Closed Lost) |

### Custom Association Labels to Create

| Association | Labels |
|---|---|
| Contact <-> Deal | 9 buying committee roles |

### HubSpot API Calls for Setup

```
# Create property groups
POST /crm/v3/properties/contacts/groups  { "name": "reddy_intelligence", "label": "Reddy Intelligence" }
POST /crm/v3/properties/companies/groups { "name": "abm_intelligence", "label": "ABM Intelligence" }
POST /crm/v3/properties/deals/groups     { "name": "meddpic", "label": "MEDDPIC" }
POST /crm/v3/properties/deals/groups     { "name": "deal_intelligence", "label": "Deal Intelligence" }
POST /crm/v3/properties/deals/groups     { "name": "deal_closing", "label": "Deal Closing" }
POST /crm/v3/properties/meetings/groups  { "name": "meeting_intelligence", "label": "Meeting Intelligence" }

# Create each custom property (76 calls)
POST /crm/v3/properties/contacts  { "name": "persona_category", "label": "Persona Category", "type": "enumeration", "groupName": "reddy_intelligence", "options": [...] }
POST /crm/v3/properties/contacts  { "name": "email_deliverability_status", "label": "Email Deliverability Status", "type": "enumeration", "groupName": "reddy_intelligence", "options": [{"value": "valid"}, {"value": "risky"}, {"value": "invalid"}, {"value": "bounced"}, {"value": "unknown"}] }
POST /crm/v3/properties/contacts  { "name": "linkedin_outreach_status", "label": "LinkedIn Outreach Status", "type": "enumeration", "groupName": "reddy_intelligence", "options": [{"value": "not_contacted"}, {"value": "request_sent"}, {"value": "connected"}, {"value": "messaged"}] }
POST /crm/v3/properties/contacts  { "name": "previous_company", "label": "Previous Company", "type": "string", "groupName": "reddy_intelligence" }
POST /crm/v3/properties/contacts  { "name": "job_change_date", "label": "Job Change Detected Date", "type": "date", "groupName": "reddy_intelligence" }
POST /crm/v3/properties/companies { "name": "intent_score", "label": "Intent Score", "type": "number", "groupName": "abm_intelligence" }
POST /crm/v3/properties/companies { "name": "referred_by_company", "label": "Referred By Company", "type": "string", "groupName": "abm_intelligence" }
POST /crm/v3/properties/deals     { "name": "last_activity_date", "label": "Last Activity Date", "type": "date", "groupName": "deal_intelligence" }
POST /crm/v3/properties/meetings  { "name": "meeting_meddpic_updates", "label": "MEDDPIC Updates", "type": "string", "fieldType": "textarea", "groupName": "meeting_intelligence" }
POST /crm/v3/properties/meetings  { "name": "meeting_competitive_intel", "label": "Competitive Intelligence", "type": "string", "fieldType": "textarea", "groupName": "meeting_intelligence" }
POST /crm/v3/properties/meetings  { "name": "meeting_action_items", "label": "Action Items", "type": "string", "fieldType": "textarea", "groupName": "meeting_intelligence" }
...

# Create pipelines (2 calls)
POST /crm/v3/pipelines/deals  { "label": "Opportunity Pipeline", "stages": [...] }
POST /crm/v3/pipelines/deals  { "label": "Deal Pipeline", "stages": [...] }

# Create association labels (9 calls)
POST /crm/v3/associations/contacts/deals/labels  { "label": "Champion" }
...
```

---

## 12. Sync Implementation Architecture

### Sync Queue Pattern

Every sync operation follows this pattern:

1. **Entity changes in Supabase** (insert or update)
2. **Sync function checks** if the entity has a `hubspot_*_id` -- if yes, it is an update; if no, it is a create
3. **API call to HubSpot** with mapped properties
4. **On success:** store returned HubSpot ID in Supabase, log to `sync_log` with `success: true`
5. **On failure:** log to `sync_log` with `success: false`, `error_message`, `retry_count = 0`, and `next_retry_at` set to now + backoff interval. Failed syncs are automatically retried based on `next_retry_at`.

### Retry Logic (new)

Failed syncs are retried using exponential backoff:

| Retry Count | Backoff | next_retry_at |
|---|---|---|
| 0 (first failure) | 1 minute | `now() + 1 min` |
| 1 | 5 minutes | `now() + 5 min` |
| 2 | 30 minutes | `now() + 30 min` |
| 3 | 2 hours | `now() + 2 hr` |
| 4+ | Abandon (set `next_retry_at = null`) | Alert in Slack |

A daily cron queries `sync_log WHERE success = false AND next_retry_at <= now() AND retry_count < 4` to process retries.

### Deduplication Strategy

| Entity | Primary Match Key | Secondary Match Key | Strategy |
|---|---|---|---|
| Contact | `email` | `hubspot_contact_id` (after first sync) | Search HubSpot by email before creating. If found, store HubSpot ID and update instead. |
| Company/Account | `domain` | `hubspot_company_id` (after first sync) | Search HubSpot by domain before creating. If found, store HubSpot ID and update instead. |
| Deal/Opportunity | `hubspot_deal_id` | N/A | Always create from Supabase. HubSpot ID stored immediately. |
| Meeting | `hubspot_meeting_id` | N/A | Always create from Supabase. HubSpot engagement ID stored immediately. |

### Batch Sync Optimization

| Endpoint | Batch Size | Use Case |
|---|---|---|
| `POST /crm/v3/objects/contacts/batch/create` | Up to 100 | Post-conference list processing |
| `POST /crm/v3/objects/contacts/batch/update` | Up to 100 | Bulk enrichment updates |
| `POST /crm/v3/associations/{from}/{to}/batch/create` | Up to 100 | Bulk contact-deal associations |
| `POST /crm/v3/objects/contacts/search` | Up to 200 results | Pre-sync deduplication check |

### Rate Limit Handling

- HubSpot rate limits: 650K requests/day, 190 requests/10 seconds
- Implementation: exponential backoff with jitter on 429 responses
- Batch operations preferred over individual creates/updates
- Sync log tracks `duration_ms` for monitoring API health
