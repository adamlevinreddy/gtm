# Reddy GTM Strategy & Automation Plan

> Internal reference document — March 2026
> Adam + Tom | Not for external distribution

---

## Executive Summary

We are building an automated GTM flywheel that lets a 2-person founding team operate at the scale of a 20-person sales and marketing org. The system uses our existing SaaS tools (HubSpot, Apollo, Clay, Common Room, etc.) connected via Claude Code agents and MCP servers, with human approval gates at every critical action.

**Architecture:** Claude Code agents orchestrate MCP servers that connect to our tool stack. Agents handle research, enrichment, sequencing, meeting analysis, and pipeline management. Humans approve before anything is sent, spent, or updated.

**Source of truth:** HubSpot Professional. Everything flows into HubSpot. All reporting and pipeline management happens there.

**Two pipelines in HubSpot:**
- **Opportunity Pipeline** — Tracks MEDDPIC qualification (all 6 criteria must be validated)
- **Deal Pipeline** — Tracks the closing process from proposal through procurement

**Four entry points into the flywheel:**
1. Conferences (10+/year, large attendee lists)
2. Website visitors (Apollo pixel + Common Room person-level ID)
3. ABM targeting (proactive account selection + multi-threading)
4. Referrals & warm intros (highest conversion, mapped from network)

**Key decisions made:**
- Apollo for sequences (not HubSpot). Sync engagement back to HubSpot.
- Apollo's built-in conversation intelligence for meeting recording (already included in our plan). Granola MCP for programmatic transcript access by Claude agents.
- Common Room for signal intelligence and person-level website visitor identification.
- HeyReach for LinkedIn automation.
- Vercel for website hosting (TypeScript site, auto-indexing via deploy hooks).
- Human review before any CRM updates, emails sent, or credits spent.

**Monthly cost (ex. ad spend):** ~$2,365/mo

---

## The Flywheel

The flywheel has six phases. Every stage feeds the next. Customers generate referrals. Lost deals re-enter nurture. Nothing is wasted.

```
                    ┌─── Conferences
                    │
                    ▼
    ┌───────────────────────────────┐
    │         1. IDENTIFY           │◄──── ABM Targeting
    │  Find accounts & people       │◄──── Website Visitors
    │  Apollo, Common Room, Clay    │◄──── Referrals
    └───────────┬───────────────────┘
                │
                ▼
    ┌───────────────────────────────┐
    │         2. ENRICH             │
    │  Data & intelligence          │
    │  Apollo + Clay waterfall      │
    └───────────┬───────────────────┘
                │
                ▼
    ┌───────────────────────────────┐
    │         3. ENGAGE             │
    │  Sequences, ads, LinkedIn     │
    │  Apollo, HeyReach, Instantly  │
    └───────────┬───────────────────┘
                │
                ▼
    ┌───────────────────────────────┐
    │         4. QUALIFY            │
    │  MEDDPIC opportunity mgmt     │
    │  HubSpot, Apollo CI, Granola  │
    └───────────┬───────────────────┘
                │
                ▼
    ┌───────────────────────────────┐
    │         5. CLOSE              │
    │  Proposal → procurement       │
    │  HubSpot, Gmail, Claude       │
    └───────────┬───────────────────┘
                │
                ▼
    ┌───────────────────────────────┐
    │         6. EXPAND             │
    │  Grow, renew, feed flywheel   │────► Back to IDENTIFY
    │  HubSpot, Apollo              │      (referrals, expansion,
    └───────────────────────────────┘       re-engagement)
```

**How it connects:**

| Stage | What Happens | Feeds Into |
|---|---|---|
| Conference Leads | Pre/post-event lists enriched, filtered, sequenced | Enrichment → Outbound → MEDDPIC |
| Website Visitors | Common Room + Apollo pixel ID company/person → contacts found → sequenced | Enrichment → Outbound → MEDDPIC |
| ABM Targeting | Target accounts selected → People Search → enrich → sequence | Enrichment → Outbound → MEDDPIC |
| Referrals | Network mapped against targets → warm intros → fast-track to Discovery | MEDDPIC (Discovery stage) |
| Enrichment | Every contact/account enriched via Apollo + Clay | All outbound channels |
| Outbound Sequences | Apollo email sequences + HeyReach LinkedIn + Instantly warmup + ads | MEDDPIC when they reply/book |
| Meeting Intelligence | Apollo CI records + Granola MCP for Claude analysis → CRM updates | MEDDPIC fields, tasks, follow-ups |
| MEDDPIC Qualification | 6 criteria tracked per opportunity. Deal health scored weekly | Deal Pipeline when all 6 validated |
| Deal Pipeline | Solution design through procurement. Champion enablement, MAPs, battlecards | Closed Won → Expansion |
| Content Loop | Blog → indexed → visitor pixeled → retargeted | Website Visitors entry point |
| Re-engagement | Stale leads re-enriched, job changes detected → re-sequenced | Back into Enrichment → Outbound |

---

## Tool Stack & Architecture

### Tools

| Tool | Plan | Role | Monthly Cost |
|---|---|---|---|
| **HubSpot** | Professional | CRM, source of truth. Contacts, companies, deals, pipelines, tasks, workflows | ~$450 |
| **Apollo** | Professional+ | Prospecting, enrichment, sequences, website visitor tracking, conversation intelligence (recording, transcription, AI summaries, follow-up emails, pre-meeting briefs) | ~$160 (2 seats) |
| **Clay** | Growth | Waterfall enrichment (150+ sources), deep account research. HubSpot native integration | $495 |
| **Common Room** | Starter | Signal intelligence: person-level website visitor ID (50% US), 50+ signal channels, Bombora intent, RoomieAI agents, Slack alerts | $1,000 |
| **HeyReach** | Standard | LinkedIn automation: connection requests, messaging, InMail. Cloud-based, profile rotation | ~$80 |
| **Instantly** | Growth | Email warmup before cold sending. Warmup analytics, deliverability monitoring | ~$80 |
| **Granola** | Business | Meeting transcripts with programmatic access via MCP. Claude agents read transcripts for analysis | ~$28 (2 seats) |
| **Slack** | Existing | Internal comms, approval workflows, deal health alerts, agent notifications | Existing |
| **LinkedIn** | Sales Nav + Ads | Manual research via Sales Navigator. Ad campaigns via Campaign Manager | Existing + ad spend |
| **Google Ads** | Active | Search + remarketing campaigns. Customer Match audiences from HubSpot | Ad spend |
| **Vercel** | Free/Pro | TypeScript website hosting. Deploy hooks for Search Console indexing | Free or $20 |
| **Zapier** | Professional | Workflow glue for tools without native MCP. Fallback integration layer | ~$70 |
| **Total** | | | **~$2,365/mo** |

### MCP Servers (for Claude Code Agents)

| MCP Server | Tools | Purpose |
|---|---|---|
| `shinzo-labs/hubspot-mcp` | ~112 | CRM: contacts, deals, pipelines, tasks, associations, batch ops |
| `Chainscore/apollo-io-mcp` | 45 | Prospecting: search, enrich, sequences, contacts, engagement data |
| `taylorwilsdon/google_workspace_mcp` | Multi | Gmail (drafts, read sent mail, threads) + Calendar (attendees, events) |
| `AminForou/mcp-gsc` | Multi | Blog indexing: URL inspection, sitemaps, SEO analytics |
| `googleads/google-ads-mcp` | Multi | Google Ads campaign + audience management (official Google) |
| `bcharleson/instantly-mcp` | 38 | Email warmup + campaign management |
| `chris-trag/commonroom-mcp` | 10 | Signal data: segments, contacts, activities, tags |
| Granola MCP (official) | 5 | Meeting transcripts, summaries, natural language queries |
| Slack MCP (official) | 12 | Send messages, read channels, search, canvases, scheduling |
| `zapier/zapier-mcp` | 8000+ apps | Fallback for any tool without native MCP |

> Don't connect all at once — 4-5 active MCP servers per session max to avoid context window bloat.

### Claude Code Agents

| Agent | What It Does | MCP Servers | Human Gate |
|---|---|---|---|
| Conference Pipeline | CSV → enrich → filter → create contacts → enroll in sequence | Apollo, HubSpot, Clay | Approve list before spending credits |
| Website Visitor | Common Room signals → Apollo search → enrich → sequence | Common Room, Apollo, HubSpot | Approve contact list before sequencing |
| Pre-Meeting Brief | Calendar → enrich attendees → pull deal history → deliver brief | Calendar, Apollo, HubSpot, Slack | None (read-only) |
| Meeting Follow-up | Granola transcript → CRM updates + follow-up email + tasks → Slack | Granola, HubSpot, Gmail, Slack | Approve all updates before executing |
| ABM Multi-Thread | Check MEDDPIC gaps → find missing roles → enrich → sequence | HubSpot, Apollo | Approve new contacts before sequencing |
| Deal Health | Weekly pipeline scan → score each deal → flag at-risk → Slack report | HubSpot, Slack | None (report only) |
| Re-Engagement | Find stale leads → re-enrich → detect job changes → re-sequence | HubSpot, Apollo, Instantly | Approve re-engagement list |
| Content Pipeline | New blog post → submit sitemap → inspect URL → IndexNow | Search Console | None (automated) |

---

## Workflows

### Conference Pipeline

> 10+ events/year. Large attendee lists. Two sub-flows: pre-conference (targeted) and post-conference (bulk). ~95% automatable.

**Pre-Conference:**

1. Receive attendee list (CSV with names, titles, companies) — *Manual*
2. Import into Apollo via bulk People Enrichment (10/batch) — *Apollo, 1 credit/person*
3. Filter: remove competitors, non-ICP, irrelevant titles — *Apollo + Claude*
4. Categorize by persona: L&D, QA, or Operations — *Claude*
5. Prioritize contacts (1/2/3 ranking by title fit) — *Claude*
6. **HUMAN GATE:** Submit to leadership for approval via Slack — before spending credits on reveals
7. Reveal emails + LinkedIn URLs for approved contacts — *Apollo, credits spent here*
8. Create contacts in Apollo — *Apollo API, free, bulk 100/call*
9. Enroll in persona-specific sequence (L&D / QA / Ops) — *Apollo API, sequences pre-built in UI*
10. Contacts sync to HubSpot via native integration — *automatic*
11. Create opportunity deal in HubSpot for each target account — *HubSpot API, stage: Target Identified*

**Post-Conference:**

1. Receive full/expanded attendee list after event — *Manual*
2. Cross-reference against pre-conference contacts (avoid double-sequencing) — *Apollo + Claude*
3. Enrich new contacts not already in pipeline — *Apollo*
4. Filter competitors + non-ICP — *same filters*
5. Tag as "met at conference" vs "did not meet" — *HubSpot*
6. Sequence the unmet, high-priority contacts — *Apollo, "we were both at [conference]" angle*
7. LinkedIn connection requests to approved contacts — *HeyReach*

---

### Website Visitors

> Common Room identifies visitors at person-level (50% US). Apollo pixel for company-level backup. ~85% automatable.

1. Visitor hits website — Common Room JS snippet + Apollo pixel + GTM fires all tags
2. Common Room identifies person (50% US) or company. Scores intent via Bombora + behavioral signals
3. Common Room sends real-time Slack alert via RoomieAI Spark for high-intent visitors
4. High-fit visitors auto-pushed to Apollo via native Common Room → Apollo integration
5. For company-level only IDs: Apollo People Search by target titles (L&D, QA, Ops) — *free, no credits*
6. Filter by seniority (Director+), department, title relevance — *Claude*
7. Enrich top matches (email, phone, LinkedIn) — *Apollo, 1 credit/person*
8. Check if contact/company already exists in HubSpot — *HubSpot API*
9. **HUMAN GATE:** Submit new contacts for approval via Slack
10. Create contacts in Apollo + enroll in "Website Visitor" sequence — *"We noticed your team is researching..."*
11. Sync to HubSpot. Create opportunity if company is ICP Tier 1/2
12. Company enters retargeting audiences via HubSpot list sync — *auto to Google + LinkedIn*

---

### ABM & Multi-Threading

> Account-level targeting. Multi-thread into existing opportunities to complete MEDDPIC. ~90% automatable.

**New Account Targeting:**

1. Identify target company (leadership decision, intent signal from Common Room, or ICP match) — *Manual + Common Room*
2. Search company in Apollo — pull contacts in L&D, QA, Operations — *Apollo, free*
3. Export Name, Title, Company (no email reveal yet — preserve credits) — *Apollo*
4. Prioritize by seniority + persona + fit — *Claude*
5. **HUMAN GATE:** Submit to Adam/Tom for approval via Slack
6. Reveal emails + LinkedIn for approved contacts — *Apollo, credits spent here*
7. Create contacts, enroll in campaign-specific sequences — *Apollo*
8. Send LinkedIn connection requests — *HeyReach*
9. Create opportunity in HubSpot Opportunity Pipeline — *stage: Target Identified*

**Multi-Threading Existing Opportunities:**

1. Scan HubSpot opportunities for incomplete MEDDPIC criteria — *HubSpot API*
2. Identify which buying committee roles are missing (no Champion? no Economic Buyer?) — *HubSpot + Claude*
3. Apollo People Search at that company for matching titles — *free*
4. Enrich top candidates — *Apollo, 1 credit each*
5. Craft personalized outreach (reference the initiative, not cold) — *Claude*
6. Enroll in targeted multi-thread sequence — *Apollo*
7. Associate new contacts to deal with appropriate role label — *HubSpot Associations API*
8. Update MEDDPIC status as new contacts engage

**Warm Introduction Path:**

1. When new target account enters pipeline: check if anyone in our network knows someone there — *HubSpot + LinkedIn*
2. If warm path exists: flag `warm_intro_available` + `warm_intro_path` in HubSpot
3. Request intro from connector — *Manual, highest conversion channel*
4. Warm intro contacts fast-track to Discovery stage (skip Target Identified + Outreach Active)

---

### Enrichment Engine

> Every contact and account gets enriched before any outreach. Two tiers: Apollo for volume, Clay for depth. ~95% automatable.

**Standard Enrichment (Apollo — Every Contact):**

1. Input: name + company (or email, LinkedIn URL, domain)
2. People Enrichment API returns: email, phone, title, seniority, department, LinkedIn URL, employment history — *1 credit/person, bulk 10/call*
3. Organization Enrichment returns: industry, size, revenue, funding, tech stack — *1 credit/company*
4. Classify persona (L&D / QA / Ops) based on title + department — *Claude*
5. Score ICP fit based on company size, industry, seniority — *write `icp_fit_score` to HubSpot*
6. Tag `last_enrichment_date` on contact and company for freshness tracking

**Deep Enrichment (Clay — High-Value Accounts):**

1. **ONE-TIME SETUP:** Create Clay table with enrichment columns pre-configured — *UI only*
2. Push account/contact data into Clay table via webhook — *POST JSON, 50K row limit*
3. Clay runs waterfall enrichment across 150+ sources (Apollo, Clearbit, Hunter, PDL, etc.)
4. Returns: verified email, phone, tech stack, funding, hiring signals — *~95% email accuracy*
5. HTTP API action pushes enriched data back to HubSpot — *outbound webhook*
6. Use Clay for: competitive tech detection, intent signals, custom AI research via Claygent

---

### Outbound & Sequences

> Multi-channel: Apollo email sequences + HeyReach LinkedIn + Instantly warmup + Google/LinkedIn ads. ~85% automatable.

**Email Sequences (Apollo):**

1. **PRE-REQUISITE:** Build template sequences in Apollo UI — L&D, QA, Ops, Website Visitor, Re-engagement, Multi-thread. *Cannot create sequences via API.*
2. **PRE-REQUISITE:** Warm sending mailboxes via Instantly — *enable warmup via API, monitor health scores*
3. Enroll approved contacts in persona-specific sequence via API — *Apollo*
4. Apollo sends multi-step email sequences from warmed mailboxes — *A/B testing per step, auto-pause on reply/OOO/opt-out*
5. Monitor engagement: opens, clicks, replies — *Apollo API*
6. Engagement data syncs to HubSpot as activity logs — *native sync*
7. Replies → pause sequence, notify in Slack, create HubSpot task

**LinkedIn Outreach (HeyReach):**

1. Import target contacts to HeyReach — *from Apollo/HubSpot export*
2. Send connection requests with personalized notes — *HeyReach, cloud-based, profile rotation*
3. Follow-up messages to accepted connections — *HeyReach sequences*
4. Keep under 25 connection requests/week per profile for best acceptance rate
5. Log LinkedIn activity to HubSpot — *manual or via Hublead extension*

**Ad Retargeting:**

1. HubSpot contact lists auto-sync to LinkedIn Matched Audiences — *native*
2. HubSpot contact lists auto-sync to Google Ads Customer Match — *native, migrate to Data Manager API before April 1, 2026*
3. Run LinkedIn awareness campaigns to opportunity accounts — *company + persona targeting*
4. Run Google remarketing to website visitors — *Google Ads remarketing tag via GTM*

---

### Meeting Intelligence

> Apollo CI handles in-product recording/summaries. Granola MCP gives Claude programmatic transcript access. ~95% automatable.

**Pre-Meeting Brief (Auto-Generated 30 Min Before Call):**

1. Read upcoming calendar events + extract attendee emails — *Google Calendar API*
2. Look up each attendee in HubSpot by email — *contact record, deal associations, lifecycle stage*
3. Enrich unknown attendees via Apollo — *title, seniority, LinkedIn, company data*
4. Pull deal context: MEDDPIC status, stage, last notes, open tasks — *HubSpot API*
5. Query past Granola meetings with this contact/company — *Granola MCP: `query_granola_meetings`*
6. Check for competitive presence at this account — *HubSpot `competitor_present` property*
7. Claude synthesizes into 1-page brief: who, context, MEDDPIC gaps to probe, suggested questions
8. Deliver brief to Slack `#meeting-prep` — *30 minutes before meeting*

> Apollo CI also generates its own pre-meeting brief in-product. Between both, you walk into every call fully prepared.

**Post-Meeting Follow-Up (Human Review Gate):**

1. Meeting ends — Apollo CI records, transcribes, generates AI summary + action items + follow-up email draft — *automatic, in Apollo UI*
2. Apollo auto-populates HubSpot fields from conversation content — *native*
3. In parallel: Claude reads Granola transcript via MCP — *for deeper/custom analysis*
4. Claude extracts: MEDDPIC updates, competitive intel, objections, buying signals — *structured data from unstructured conversation*
5. Claude drafts follow-up email in your voice (once voice guidelines created) — *references specific discussion points*
6. Agent posts to Slack `#sales-approvals`: proposed HubSpot updates + draft email + suggested tasks
7. **HUMAN GATE:** Review in Slack — approve, edit, or reject each item
8. On approval: update MEDDPIC fields + deal stage in HubSpot — *API*
9. On approval: create tasks in HubSpot for agreed next steps — *API*
10. On approval: create Gmail draft of follow-up email in correct thread — *Gmail API `drafts.create`*
11. If new contacts mentioned: search/enrich via Apollo, associate to deal

**Voice Guidelines (To Be Created):**

1. Read sent emails from Gmail API to analyze writing patterns
2. Claude analyzes: sentence length, word choice, tone, formality, sign-off style
3. Create voice/tone guide document
4. Store as prompt template for meeting follow-up agent

---

### MEDDPIC & Qualification (Opportunity Pipeline)

> Track 6 MEDDPIC criteria per opportunity. All 6 must be Validated to convert to Deal. ~80% automatable.

**Pipeline Stages (Board View):**

| Stage | What's Happening | Exit Criteria |
|---|---|---|
| 1. Target Identified | Account flagged, contacts being found/enriched | At least 1 contact sequenced |
| 2. Outreach Active | Sequences running, ads targeting this account | Meeting booked or reply received |
| 3. Discovery | First meetings, learning the org and pain | At least 2 MEDDPIC criteria have data |
| 4. Qualification In Progress | Actively working all MEDDPIC, multi-threading | 4+ criteria have data, Champion identified |
| 5. Fully Qualified | All 6 MEDDPIC validated | Convert to Deal Pipeline (manual + Slack prompt) |
| Disqualified | Not a fit | Reason documented, enter re-engagement after 90 days |

**MEDDPIC Criteria:**

| Letter | Criterion | What You're Establishing | HubSpot Properties |
|---|---|---|---|
| M | Metrics | What quantifiable outcomes are they trying to achieve? How do they measure success? | `meddpic_metrics_status` + `meddpic_metrics_detail` |
| E | Economic Buyer | Who signs the check? Who has budget authority? | `meddpic_economic_buyer_status` + `meddpic_economic_buyer_detail` |
| D | Decision Criteria | What factors will they use to choose a vendor? | `meddpic_decision_criteria_status` + `meddpic_decision_criteria_detail` |
| D | Decision Process | What's the buying process? Who's involved? Timeline? | `meddpic_decision_process_status` + `meddpic_decision_process_detail` |
| I | Identify Pain | What pain does the champion feel? What happens if they do nothing? | `meddpic_identify_pain_status` + `meddpic_identify_pain_detail` |
| C | Champion | Who sells internally on your behalf? What's their personal win? | `meddpic_champion_status` + `meddpic_champion_detail` |

Each status progresses: **Not Started → Exploring → Identified → Validated**

`meddpic_completion_score` = count of "Validated" / 6 × 100

**Deal Health Score (Weekly Automated Report):**

| Factor | Weight | Scoring |
|---|---|---|
| MEDDPIC completion | 25% | 0-100 based on validated criteria ratio |
| Days in current stage vs. average | 20% | 100 if on pace, decays as deal ages |
| Last activity recency | 20% | 100 if <7d, 50 if 7-14d, 25 if 14-30d, 0 if >30d |
| Stakeholder coverage | 15% | 100 if 3+ contacts, 50 if 2, 0 if single-threaded |
| Champion engagement | 10% | 100 if active in last 14 days, 0 if not |
| Next step defined | 10% | 100 if next_step + next_step_date set, 0 if not |

Score 0-100. Below 50 = flagged in weekly Slack `#deal-health` report.

---

### Deal Pipeline (Post-Qualification)

> Once all 6 MEDDPIC validated, opportunity converts to deal. ~70% automatable.

**Pipeline Stages:**

| Stage | What's Happening | Exit Criteria | Key Deliverables |
|---|---|---|---|
| 1. Solution Design | Scoping requirements | Proposal drafted | MAP generated, requirements doc |
| 2. Proposal Delivered | Prospect reviewing | Feedback received | Proposal, pricing, ROI calculator |
| 3. Technical Evaluation | Demo, POC, or trial | Technical signoff | Demo script, POC plan, tech docs |
| 4. Business Case / ROI | Champion building internal case | Exec sponsor briefed | Champion enablement package, exec summary |
| 5. Procurement / Legal / Security | Vendor assessment, contracts | All requirements met | Security questionnaire, MSA/DPA, compliance |
| 6. Final Negotiation | Terms, pricing, timing | Verbal commit | Final contract, battlecard |
| 7. Closed Won | Signed | — | Handoff to implementation |
| 8. Closed Lost | Did not close | Reason captured | Win/loss analysis, re-engagement in 90 days |

**Deal Acceleration Tools (Built by Claude Agents):**

1. **Mutual Action Plan** — Auto-generated when deal enters pipeline. Template with standard enterprise milestones, customized per deal.
2. **Champion enablement** — Internal-facing docs for your champion: business case, ROI summary, exec summary in their company's language.
3. **Competitive battlecards** — Maintained from win/loss data + enrichment. Updated as new intel comes in from meetings.
4. **Procurement readiness** — Pre-built security questionnaire response bank. Claude fills per-prospect from the bank.
5. **ROI calculator** — Pre-populated with prospect's metrics data from MEDDPIC.
6. **Win/loss capture** — HubSpot workflow requires `lost_reason` before deal can close as lost.

---

### Content & Retargeting Loop

> Blog → index → pixel → retarget. ~70% automatable. Google indexing takes hours-days, not minutes.

1. Publish blog post on Vercel-hosted TypeScript site
2. Deploy hook fires: regenerate XML sitemap
3. Submit updated sitemap via Search Console API — *Sitemaps API*
4. Inspect new URL via URL Inspection API — *triggers re-evaluation, 2K/day*
5. Submit to IndexNow for instant Bing/Yandex/Naver indexing — *free POST request*
6. Google indexes page — **hours to days, NOT instant** (known limitation)
7. Visitor lands on site → GTM fires all tracking pixels (Google Ads, LinkedIn Insight Tag, Apollo pixel)
8. Common Room identifies visitor (person-level 50% US, company-level otherwise)
9. HubSpot contact lists auto-sync to Google Customer Match + LinkedIn Matched Audiences
10. Visitor enters Website Visitor pipeline (see above)

---

### Re-engagement & Expansion

> Stale leads re-enriched and re-sequenced. Lost deals re-enter nurture. Customers expand. ~85% automatable.

**Stale Lead Re-engagement:**

1. HubSpot search: contacts with no activity >60 days, not customer, not disqualified
2. Re-enrich via Apollo (email/phone may have changed) — *22.5% of CRM data goes stale annually*
3. Check for job changes: if at a new company, flag as new opportunity
4. Job changed → create new opportunity + re-sequence with warm angle ("they already know you")
5. Same role, stale → enroll in re-engagement sequence (different tone, not cold)
6. Bad data → archive contact
7. Re-warm sending mailboxes via Instantly if they've gone cold

**Lost Deal Recovery:**

1. When deal closes Lost: require `lost_reason` + `lost_to_competitor` + `win_loss_notes` — *HubSpot workflow gate*
2. Add to "Lost Deals" list
3. After 90 days: re-enter nurture with new angle (new feature, case study, insight)
4. Track competitive losses separately → feed battlecard updates

**Customer Expansion:**

1. Track `expansion_potential` on closed-won deals (High/Medium/Low/None)
2. For High: identify additional teams/use cases at the account — *Apollo People Search*
3. Request referrals and intros to other target accounts — *manual, highest conversion channel*
4. Long-cycle nurture for non-expansion customers (content drip, event invites)

---

## HubSpot Data Model

### Company Properties (Group: "ABM Intelligence")

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

### Contact Properties

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

### Deal Properties (Opportunity Pipeline — MEDDPIC)

6 status + 6 detail properties for MEDDPIC (see MEDDPIC section above), plus:

| Property | Type | Purpose |
|---|---|---|
| `meddpic_completion_score` | Number | Validated count / 6 × 100 |
| `deal_health_score` | Number | Composite 0-100 (see scoring above) |
| `days_in_current_stage` | Number | Calculated from stage entry |
| `single_thread_risk` | Checkbox | True if only 1 contact associated |
| `competitor_in_evaluation` | Dropdown | None, [Competitor names], Unknown |
| `next_step` | Text | Agreed next action |
| `next_step_date` | Date | When |
| `last_meeting_date` | Date | From engagement tracking |
| `champion_engaged` | Checkbox | Active in last 14 days |
| `mutual_action_plan_link` | URL | Link to MAP doc |

### Deal Properties (Deal Pipeline — Closing)

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

### Contact ↔ Deal Association Labels (Buying Committee)

- Champion
- Economic Buyer
- Technical Evaluator
- Decision Maker
- Coach / Guide
- Blocker
- End User
- Legal / Procurement
- Executive Sponsor

### Lifecycle Stages (Standard HubSpot)

| Stage | Definition | Trigger |
|---|---|---|
| Subscriber | Known contact, no engagement | Added from conference list or enrichment |
| Lead | Engaged (opened email, clicked, visited site) | Apollo engagement or website activity |
| MQL | Meets ICP + engagement threshold | Lead score crosses threshold |
| SQL | Sales-accepted, meeting booked or direct conversation | Manual or meeting-booked trigger |
| Opportunity | Associated to an active Opportunity pipeline deal | Deal created |
| Customer | Closed-won deal | Deal stage = Closed Won |
| Evangelist | Active reference / referral source | Manual |

### Automated Workflows (9)

| Workflow | Trigger | Action |
|---|---|---|
| Lifecycle auto-advance | Engagement score crosses MQL threshold | Set lifecycle = MQL, Slack notification |
| Meeting booked → SQL | Meeting activity logged with prospect | Set lifecycle = SQL |
| New deal → associate company | Deal created | Auto-associate to contact's company |
| Stage change tracking | Deal stage changes | Reset `days_in_current_stage`, log timestamp |
| Single-thread risk | Deal has only 1 contact after 14 days | Set `single_thread_risk` = true, Slack alert |
| Champion gone quiet | Champion last activity >14 days | Set `champion_engaged` = false, Slack alert |
| MEDDPIC complete | All 6 statuses = Validated | Slack: "Ready to convert to Deal Pipeline" |
| Win/loss capture gate | Deal closing as Won or Lost | Require `lost_reason` or `expansion_potential` |
| Re-engagement trigger | Contact inactive >60 days, not customer/disqualified | Add to re-engagement list |

---

## Known Limitations & Workarounds

| Limitation | Severity | Workaround |
|---|---|---|
| No LinkedIn outreach API | Medium | HeyReach (cloud automation, TOS risk). Sales Nav for manual. Ads fully automatable. |
| No instant Google blog indexing | Medium | Sitemap + URL Inspection + IndexNow (Bing instant). Google: hours-days. |
| Can't create sequences via API (Apollo or HubSpot) | Low | Pre-build template sequences in UI. API handles enrollment only. |
| Apollo website visitor data has no API | Low | Common Room replaces this need (person-level ID + API + webhooks). |
| Clay tables must be configured in UI | Low | Set up once. Webhook-in / webhook-out runs automatically. |
| Google Ads Customer Match API changing | **High (deadline)** | Migrate to Data Manager API before **April 1, 2026**. |
| Sales Navigator API closed (SNAP paused Aug 2025) | Medium | Apollo People Search as programmatic alternative. Sales Nav for manual research. |
| No Slack interactive buttons via MCP | Low | Thread-based approval works today. Build Slack app later for button UX. |
| Apollo transcript data not in API | Medium | Use Granola MCP for programmatic transcript access. Apollo CI for in-product experience. |
| Common Room API is mostly push-in, limited pull-out | Low | Use webhooks for outbound triggers. S3 export for bulk data. |

---

## Build Sequence & Roadmap

### Phase 0: Foundation (Week 1-2)

- [ ] Set up HubSpot data model: create all custom properties, property groups, pipelines, stages
- [ ] Create MEDDPIC deal properties (6 status + 6 detail)
- [ ] Create association labels for buying committee roles
- [ ] Set up 9 automated workflows
- [ ] Configure Apollo → HubSpot sync field mapping
- [ ] Create template sequences in Apollo UI (L&D, QA, Ops, Website Visitor, Re-engagement, Multi-thread)
- [ ] Set up Instantly warmup for sending mailboxes
- [ ] Create Clay enrichment table with pre-configured columns

### Phase 1: Signal Intelligence (Week 2-3)

- [ ] Sign up for Common Room Starter
- [ ] Install Common Room JS snippet on website
- [ ] Connect Common Room → HubSpot integration
- [ ] Connect Common Room → Apollo integration
- [ ] Connect Common Room → Slack for RoomieAI alerts
- [ ] Configure Bombora intent topics
- [ ] Set up HeyReach and connect LinkedIn profiles
- [ ] Move website to Vercel + set up deploy hooks for Search Console

### Phase 2: Core Agents (Week 3-5)

- [ ] Install MCP servers: HubSpot, Apollo, Google Workspace, Granola, Slack
- [ ] Build Conference Pipeline agent
- [ ] Build Pre-Meeting Brief agent
- [ ] Build Meeting Follow-up agent
- [ ] Create voice/tone guidelines from sent email analysis
- [ ] Test full meeting flow: brief → call → transcript → Slack approval → HubSpot update

### Phase 3: Outbound & ABM (Week 5-7)

- [ ] Build Website Visitor agent (Common Room → Apollo → HubSpot)
- [ ] Build ABM Multi-Thread agent
- [ ] Set up ad retargeting: HubSpot lists → LinkedIn Matched Audiences + Google Customer Match
- [ ] Build Content Pipeline agent (deploy hook → Search Console → IndexNow)
- [ ] Test full conference flow end-to-end with a real event list

### Phase 4: Intelligence & Health (Week 7-8)

- [ ] Build Deal Health agent (weekly pipeline scoring + Slack report)
- [ ] Build Re-Engagement agent
- [ ] Build champion enablement content generation
- [ ] Build competitive battlecard generation from win/loss data
- [ ] Build procurement questionnaire response bank
- [ ] Set up MAP template auto-generation

### Phase 5: Polish & Optimize (Ongoing)

- [ ] Tune deal health scoring weights based on actual deal outcomes
- [ ] Refine ICP scoring model from win/loss data
- [ ] Build Slack app for interactive approval buttons (replace thread-based)
- [ ] Migrate Google Ads to Data Manager API (before April 1, 2026)
- [ ] Evaluate: is Common Room Starter sufficient or upgrade to Team?
- [ ] Evaluate: as team grows, do we need Gong/Avoma or is Apollo CI + Granola sufficient?

---

## Appendix: API Research Summary

Full API research was conducted across all tools. Key findings per tool:

| Tool | API Quality | Key Endpoints | Rate Limits | MCP Available |
|---|---|---|---|---|
| HubSpot | Excellent | Full CRUD on all objects, pipelines, search, batch (100/call), associations, workflows | 650K/day, 190/10sec | Yes (112 tools) |
| Apollo | Good | People search (free), enrichment (1 credit), sequences (enroll only), contacts CRUD | 200+/min (Pro) | Yes (45 tools) |
| Clay | Limited | Webhooks in, HTTP actions out. No table creation. Enterprise API thin | 50K webhook rows | Yes (6 tools, read-only) |
| LinkedIn Marketing | Good (gated) | Campaign CRUD, reporting, Conversions API. Matched Audiences requires separate approval | 100K/day | Yes (ads only) |
| Google Search Console | Good | URL Inspection (2K/day), Sitemaps, Performance data | 2K inspections/day | Yes |
| Gmail | Excellent | Draft/send/read, thread management, labels | 1B quota units/day | Yes (via Workspace MCP) |
| Google Calendar | Excellent | Full event CRUD, attendee data | 1M queries/day | Yes (via Workspace MCP) |
| Google Ads | Excellent (changing) | Campaign management, Customer Match (→ Data Manager API by Apr 2026), reporting | Token-based | Yes (official) |
| Granola | Good | Notes list/get, transcript access (Business plan+) | 25 req/5sec burst | Yes (official, 5 tools) |
| Instantly | Excellent | 38+ endpoints: accounts, campaigns, leads, warmup, emails | 100 req/sec | Yes (38 tools) |
| Zoom | Good | Recordings, transcripts (1-24hr delay), meetings CRUD | 30-80 req/sec (Pro) | Yes |
| Slack | Excellent | Full messaging, search, canvases, scheduling | Standard Slack limits | Yes (official, 12 tools) |
| Common Room | Limited | Push data in, limited pull out. Webhooks for outbound triggers | ~20 req/sec | Yes (community, 10 tools) |

---

*Document generated from collaborative planning session, March 2026. Research based on 7 parallel API research agents covering HubSpot, Apollo, Clay, LinkedIn, Google, meeting tools, and the MCP ecosystem.*
