// Full Drizzle ORM schema -- ready to paste into src/lib/schema.ts
// Compatible with postgres.js driver (prepare: false for Supabase PgBouncer)

import {
  pgTable,
  text,
  serial,
  date,
  pgEnum,
  integer,
  timestamp,
  boolean,
  uuid,
  jsonb,
  real,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

// ============================================================================
// ENUMS
// ============================================================================

/** Existing enum -- preserved for backward compatibility */
export const actionEnum = pgEnum("action", ["exclude", "tag", "prospect"]);

/** Account tier for ABM prioritization */
export const accountTierEnum = pgEnum("account_tier", [
  "tier_1",
  "tier_2",
  "tier_3",
]);

/** Account sales status lifecycle */
export const accountStatusEnum = pgEnum("account_status", [
  "target",
  "prospecting",
  "engaged",
  "opportunity_open",
  "customer",
  "churned",
  "disqualified",
]);

/** Persona categories for contact center buyers */
export const personaEnum = pgEnum("persona", [
  "cx_leadership",
  "ld",
  "qa",
  "wfm",
  "km",
  "sales_marketing",
  "it",
  "excluded",
  "unknown",
]);

/** Buying role on a deal's buying committee */
export const buyingRoleEnum = pgEnum("buying_role", [
  "champion",
  "economic_buyer",
  "technical_evaluator",
  "decision_maker",
  "coach",
  "blocker",
  "end_user",
  "legal_procurement",
  "executive_sponsor",
  "unknown",
]);

/** Seniority level from enrichment */
export const seniorityEnum = pgEnum("seniority_level", [
  "c_suite",
  "vp",
  "director",
  "manager",
  "ic",
  "unknown",
]);

/** Lead source -- how we first learned about this contact */
export const leadSourceEnum = pgEnum("lead_source", [
  "conference_pre",
  "conference_post",
  "website_visitor",
  "abm",
  "inbound",
  "referral",
  "apollo_search",
  "common_room",
  "manual",
]);

/** Enrichment data source */
export const enrichmentSourceEnum = pgEnum("enrichment_source", [
  "apollo",
  "clay",
  "common_room",
  "manual",
  "conference_list",
]);

/** Sequence enrollment status */
export const sequenceStatusEnum = pgEnum("sequence_status", [
  "not_sequenced",
  "active",
  "completed",
  "replied",
  "opted_out",
  "bounced",
]);

/** MEDDPIC criterion status (same 4 values for all 6 criteria) */
export const meddpicStatusEnum = pgEnum("meddpic_status", [
  "not_started",
  "exploring",
  "identified",
  "validated",
]);

/** Opportunity pipeline stages */
export const opportunityStageEnum = pgEnum("opportunity_stage", [
  "target_identified",
  "outreach_active",
  "discovery",
  "qualification_in_progress",
  "fully_qualified",
  "disqualified",
]);

/** Deal (closing) pipeline stages */
export const dealStageEnum = pgEnum("deal_stage", [
  "solution_design",
  "proposal_delivered",
  "technical_evaluation",
  "business_case_roi",
  "procurement_legal_security",
  "final_negotiation",
  "closed_won",
  "closed_lost",
]);

/** Procurement status during deal closing */
export const procurementStatusEnum = pgEnum("procurement_status", [
  "not_started",
  "security_review",
  "legal_review",
  "contract_redlines",
  "approved",
]);

/** Contract type */
export const contractTypeEnum = pgEnum("contract_type", [
  "msa_sow",
  "single_agreement",
  "po_based",
]);

/** Close confidence level */
export const closeConfidenceEnum = pgEnum("close_confidence", [
  "high",
  "medium",
  "low",
]);

/** Lost reason for closed-lost deals */
export const lostReasonEnum = pgEnum("lost_reason", [
  "price",
  "competitor",
  "timing",
  "no_decision",
  "champion_left",
  "budget_cut",
  "product_gap",
  "other",
]);

/** Expansion potential for closed-won deals */
export const expansionPotentialEnum = pgEnum("expansion_potential", [
  "high",
  "medium",
  "low",
  "none",
]);

/** Conference type */
export const conferenceTypeEnum = pgEnum("conference_type", [
  "in_person",
  "virtual",
  "hybrid",
]);

/** Conference list type (pre vs post event) */
export const listTypeEnum = pgEnum("list_type", [
  "pre_conference",
  "post_conference",
  "full",
  "other",
]);

/** Sync direction for audit log */
export const syncDirectionEnum = pgEnum("sync_direction", [
  "outbound",    // Supabase -> external
  "inbound",     // external -> Supabase
  "bidirectional",
]);

/** Signal type from Common Room / intent sources */
export const signalTypeEnum = pgEnum("signal_type", [
  "website_visit",
  "g2_research",
  "job_posting",
  "funding",
  "technology_install",
  "technology_removal",
  "news_mention",
  "social_activity",
  "intent_surge",
  "other",
]);

/** Enrichment run status */
export const enrichmentStatusEnum = pgEnum("enrichment_run_status", [
  "pending",
  "running",
  "success",
  "partial",
  "failed",
]);

/** Agent run status */
export const agentRunStatusEnum = pgEnum("agent_run_status", [
  "running",
  "success",
  "failed",
  "timeout",
]);

/** Disqualification reason for filtered contacts (G1) */
export const disqualificationReasonEnum = pgEnum("disqualification_reason", [
  "competitor",
  "wrong_role",
  "wrong_company_size",
  "bad_fit",
  "other",
]);

/** Processing status for conference list uploads (G2) */
export const processingStatusEnum = pgEnum("processing_status", [
  "pending",
  "processing",
  "completed",
  "failed",
]);

/** Email deliverability status from Apollo/Clay verification (G5) */
export const emailStatusEnum = pgEnum("email_status", [
  "valid",
  "risky",
  "invalid",
  "bounced",
  "unknown",
]);

/** LinkedIn outreach tracking status (G13) */
export const linkedinOutreachStatusEnum = pgEnum("linkedin_outreach_status", [
  "not_contacted",
  "request_sent",
  "connected",
  "messaged",
]);

/** Contact activity type for engagement tracking (Blocker 2) */
export const activityTypeEnum = pgEnum("activity_type", [
  "email_open",
  "email_click",
  "email_reply",
  "email_bounce",
  "meeting",
  "call",
  "linkedin_message",
  "linkedin_connection",
  "website_visit",
  "other",
]);

/** Email sending account warmup status (Blocker 3) */
export const warmupStatusEnum = pgEnum("warmup_status", [
  "not_started",
  "active",
  "paused",
  "complete",
]);

/**
 * Coarse family ("type"). FROZEN at 4 values — the digest + dedup depend on it.
 * The fine-grained taxonomy is `kind` (below); KIND_TO_TYPE in work-items.ts
 * derives this. Never add values here; add kinds instead.
 */
export const workItemTypeEnum = pgEnum("work_item_type", [
  "followup",
  "crm_update",
  "prep",
  "task",
]);

/** The real GTM task taxonomy (rolls up to `type` via KIND_TO_TYPE). */
export const workItemKindEnum = pgEnum("work_item_kind", [
  "pricing_proposal",
  "deck_qbr",
  "meeting_prep",
  "prep_custom_demo",
  "rfp_response",
  "contract_redline",
  "followup_email",
  "book_meeting",
  "reengage_tickler",
  "recording_link",
  "scheduling",
  "account_research",
  "enablement_collateral",
  "crm_update",
  "log_to_hubspot",
  "propose_stage_move",
  "action_items",
  "generic",
]);

/**
 * Lifecycle status (9 values). Columns are a VIEW over this via COLUMN_OF()
 * in work-items.ts — there is NO stored column field. `triage` = needs scoping
 * (post-meeting/internal dumps); `suggested` = live bot chat proposals (both
 * render in Unsorted but stay distinct for the suggest-latency metric).
 */
export const workItemStatusEnum = pgEnum("work_item_status", [
  "triage",
  "suggested",
  "approved",
  "in_progress",
  "waiting",
  "blocked",
  "ready_for_review",
  "done",
  "dismissed",
]);

/** Where a work item came from */
export const workItemSourceEnum = pgEnum("work_item_source", [
  "post_meeting",
  "cron",
  "manual",
  "slack_chat",
  "gmail",
]);

/** Whether the owner is a human teammate or the bot itself */
export const workItemOwnerKindEnum = pgEnum("work_item_owner_kind", [
  "human",
  "bot",
]);

/** Who/what performed an activity-ledger entry */
export const actorKindEnum = pgEnum("actor_kind", ["human", "bot", "system"]);

/** Kinds of entries in the append-only activity ledger */
export const workItemActivityKindEnum = pgEnum("work_item_activity_kind", [
  "created",
  "status_change",
  "stage_changed",
  "field_change",
  "assignment",
  "comment",
  "logged_activity",
  "bot_run",
  "bot_draft",
  "artifact",
  "email_drafted",
  "email_forwarded",
  "email_received",
  "hubspot_sync",
  "due_change",
  "conflict",
  "conflict_resolved",
  "cascade_deferred",
  "cascade_skipped",
]);

/** Reference graph between items (distinct from parent/child containment) */
export const workItemRelationKindEnum = pgEnum("work_item_relation_kind", [
  "blocks",
  "relates_to",
  "duplicate_of",
]);

/** Bot first-pass attempt state */
export const botAttemptStatusEnum = pgEnum("work_item_bot_attempt_status", [
  "running",
  "succeeded",
  "failed",
]);

/** Per-user notification kinds (the /board/inbox feed) */
export const notificationKindEnum = pgEnum("notification_kind", [
  "assigned",
  "bot_draft_ready",
  "became_high_priority",
  "stalled",
  "mentioned",
  "comment",
  "cascade_completed",
  "stage_changed",
]);

/** Cadence of a cycle (the weekly pipeline rhythm / CCW daily blitz) */
export const cycleCadenceEnum = pgEnum("cycle_cadence", [
  "weekly",
  "daily",
  "adhoc",
]);

/** Project (deal-room) status */
export const projectStatusEnum = pgEnum("project_status", [
  "target",
  "active",
  "won",
  "lost",
  "no_decision",
]);

// ============================================================================
// EXISTING TABLES (preserved exactly as-is)
// ============================================================================

/**
 * Single table for all known companies -- exclusions, tags, and prospects.
 * The `action` column determines how the company is treated during classification.
 */
export const companies = pgTable("companies", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  action: actionEnum("action").notNull(),
  /** Category slug (e.g. "ccaas", "bpo"). Null for prospects. */
  category: text("category"),
  /** Human-readable category label */
  categoryLabel: text("category_label"),
  added: date("added").notNull(),
  source: text("source").notNull(),
  /** Notes -- used for prospects and rejected classifications */
  note: text("note"),
});

/**
 * Aliases for fuzzy/exact matching. One company can have many aliases.
 */
export const companyAliases = pgTable("company_aliases", {
  id: serial("id").primaryKey(),
  companyId: integer("company_id")
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" }),
  alias: text("alias").notNull(),
});

/**
 * Category definitions -- stores the label and default action for each category slug.
 */
export const categories = pgTable("categories", {
  slug: text("slug").primaryKey(),
  label: text("label").notNull(),
  action: actionEnum("action").notNull(),
});

// ============================================================================
// NEW TABLES
// ============================================================================

// --- Accounts (sales pipeline companies) ---

/**
 * Companies as sales targets with enrichment data, ABM tiering, and external IDs.
 * Distinct from the `companies` table which is a classification reference list.
 * A prospect in `companies` may link here via `classification_company_id`.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Canonical company name */
    name: text("name").notNull(),
    /** Primary web domain (e.g. "acme.com") -- secondary match key for HubSpot */
    domain: text("domain"),
    /** Link to classification table -- null if account sourced outside classification */
    classificationCompanyId: integer("classification_company_id").references(
      () => companies.id
    ),

    // -- ABM fields --
    tier: accountTierEnum("tier"),
    status: accountStatusEnum("status").default("target"),
    leadSourceOriginal: leadSourceEnum("lead_source_original"),
    conferenceSource: text("conference_source"),

    // -- Enrichment fields (from Apollo / Clay) --
    industry: text("industry"),
    employeeCount: integer("employee_count"),
    annualRevenue: real("annual_revenue"),
    totalFunding: real("total_funding"),
    latestFundingDate: date("latest_funding_date"),
    /** JSON array of technologies from BuiltWith/Wappalyzer via Clay/Apollo */
    techStack: jsonb("tech_stack"),
    /** JSON array of industry/product keywords */
    keywords: jsonb("keywords"),
    linkedinUrl: text("linkedin_url"),
    phone: text("phone"),
    city: text("city"),
    state: text("state"),
    country: text("country"),

    // -- Intelligence fields --
    icpFitScore: real("icp_fit_score"),
    competitorPresent: text("competitor_present"),
    compellingEvent: text("compelling_event"),
    compellingEventDate: date("compelling_event_date"),
    warmIntroAvailable: boolean("warm_intro_available").default(false),
    warmIntroPath: text("warm_intro_path"),
    intentSignals: text("intent_signals"),
    accountPlanNotes: text("account_plan_notes"),
    stakeholderCount: integer("stakeholder_count").default(0),

    /** Bombora/Clay intent score rollup (G7) */
    intentScore: real("intent_score"),

    /** Structured Claygent research output (G8) */
    clayResearch: jsonb("clay_research"),

    // -- Referral tracking (Blocker 4) --
    /** Self-referential FK: which existing customer referred this account */
    referredByAccountId: uuid("referred_by_account_id").references((): AnyPgColumn => accounts.id, { onDelete: "set null" }),
    /** When the referral was made */
    referralDate: timestamp("referral_date"),

    // -- Enrichment tracking --
    lastEnrichmentDate: date("last_enrichment_date"),
    lastEnrichmentSource: enrichmentSourceEnum("last_enrichment_source"),

    // -- External IDs --
    hubspotCompanyId: text("hubspot_company_id"),
    apolloOrgId: text("apollo_org_id"),
    commonRoomOrgId: text("common_room_org_id"),

    // -- Timestamps --
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_accounts_domain").on(table.domain),
    index("idx_accounts_hubspot").on(table.hubspotCompanyId),
    index("idx_accounts_apollo").on(table.apolloOrgId),
    index("idx_accounts_name").on(table.name),
    index("idx_accounts_tier_status").on(table.tier, table.status),
    index("idx_accounts_classification").on(table.classificationCompanyId),
    index("idx_accounts_referred_by").on(table.referredByAccountId),
  ]
);

// --- Contacts (individual people) ---

/**
 * Individual people from conference lists, Apollo enrichment, Clay enrichment,
 * Common Room signals, or manual entry. First-class entities that persist
 * beyond the 7-day KV review TTL.
 */
export const contacts = pgTable(
  "contacts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Primary company association */
    accountId: uuid("account_id").references(() => accounts.id),
    /** Denormalized company name -- avoids join for most reads */
    companyName: text("company_name"),

    // -- Identity --
    firstName: text("first_name"),
    lastName: text("last_name"),
    email: text("email"),
    phone: text("phone"),
    linkedinUrl: text("linkedin_url"),
    title: text("title"),

    // -- Classification --
    persona: personaEnum("persona"),
    buyingRole: buyingRoleEnum("buying_role"),
    seniority: seniorityEnum("seniority"),
    department: text("department"),

    // -- Pipeline --
    leadSource: leadSourceEnum("lead_source"),
    conferenceName: text("conference_name"),
    sequenceStatus: sequenceStatusEnum("sequence_status").default("not_sequenced"),
    sequenceName: text("sequence_name"),
    outreachPriority: integer("outreach_priority"),
    engagementScore: real("engagement_score"),
    icpFitScore: real("icp_fit_score"),

    // -- Qualification flags --
    isCompetitor: boolean("is_competitor").default(false),
    isDisqualified: boolean("is_disqualified").default(false),
    /** Changed from text to enum (G1) */
    disqualificationReason: disqualificationReasonEnum("disqualification_reason"),

    // -- HubSpot lifecycle --
    lifecycleStage: text("lifecycle_stage"),
    leadStatus: text("lead_status"),

    // -- Enrichment tracking --
    lastEnrichmentDate: date("last_enrichment_date"),
    lastEnrichmentSource: enrichmentSourceEnum("last_enrichment_source"),
    emailVerified: boolean("email_verified"),

    /** Email deliverability status: valid, risky, invalid, bounced, unknown (G5) */
    emailStatus: emailStatusEnum("email_status").default("unknown"),

    /** Employment history from Apollo enrichment (G6) */
    employmentHistory: jsonb("employment_history"),

    /** Previous company name before job change (G12) */
    previousCompanyName: text("previous_company_name"),
    /** When a job change was detected during re-enrichment (G12) */
    jobChangeDetectedAt: timestamp("job_change_detected_at"),

    /** LinkedIn outreach status: not_contacted, request_sent, connected, messaged (G13) */
    linkedinOutreachStatus: linkedinOutreachStatusEnum("linkedin_outreach_status").default("not_contacted"),

    // -- Location (from enrichment) --
    city: text("city"),
    state: text("state"),
    country: text("country"),

    // -- External IDs --
    hubspotContactId: text("hubspot_contact_id"),
    apolloContactId: text("apollo_contact_id"),
    commonRoomPersonId: text("common_room_person_id"),

    // -- Timestamps --
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("idx_contacts_email").on(table.email),
    index("idx_contacts_account").on(table.accountId),
    index("idx_contacts_hubspot").on(table.hubspotContactId),
    index("idx_contacts_apollo").on(table.apolloContactId),
    index("idx_contacts_persona").on(table.persona),
    index("idx_contacts_sequence").on(table.sequenceStatus),
    index("idx_contacts_company_name").on(table.companyName),
    index("idx_contacts_lead_source").on(table.leadSource),
    /** Composite index for cross-conference queries (S1) */
    index("idx_contacts_account_persona_sequence").on(
      table.accountId,
      table.persona,
      table.sequenceStatus
    ),
  ]
);

// --- Conferences ---

/**
 * Conference/event metadata. Anchor for tracking which lists came from
 * which events.
 */
export const conferences = pgTable(
  "conferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    /** Start date of the conference */
    startDate: date("start_date"),
    /** End date of the conference */
    endDate: date("end_date"),
    location: text("location"),
    type: conferenceTypeEnum("type"),
    notes: text("notes"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_conferences_name").on(table.name),
    index("idx_conferences_dates").on(table.startDate, table.endDate),
  ]
);

// --- Conference Lists (uploaded CSV files) ---

/**
 * Each uploaded CSV/XLSX file linked to a conference. Tracks file metadata,
 * processing status, and aggregate stats.
 */
export const conferenceLists = pgTable(
  "conference_lists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conferenceId: uuid("conference_id").references(() => conferences.id),
    /** Original file name (e.g. "ccw-2026-pre.csv") */
    fileName: text("file_name").notNull(),
    listType: listTypeEnum("list_type").default("other"),
    /** The Vercel KV review ID that processed this list */
    reviewId: text("review_id"),
    /** Who uploaded (Slack user ID or "api" or "webhook") */
    uploadedBy: text("uploaded_by"),
    /** Total rows in the file */
    totalRows: integer("total_rows"),
    /** Total unique companies in the file */
    totalCompanies: integer("total_companies"),
    /** Total contacts linked to this list */
    totalContacts: integer("total_contacts"),
    /** Processing status: pending, processing, completed, failed (G2) */
    processingStatus: processingStatusEnum("processing_status").default("pending"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_conference_lists_conference").on(table.conferenceId),
    index("idx_conference_lists_review").on(table.reviewId),
    index("idx_conference_lists_status").on(table.processingStatus),
  ]
);

// --- List Contacts (junction: which contacts from which lists) ---

/**
 * Junction table connecting contacts to conference lists. Tracks the original
 * title as it appeared on that specific list (titles may differ across lists).
 */
export const listContacts = pgTable(
  "list_contacts",
  {
    id: serial("id").primaryKey(),
    listId: uuid("list_id")
      .notNull()
      .references(() => conferenceLists.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** Title as it appeared on this specific list */
    originalTitle: text("original_title"),
    /** Whether this contact was already in HubSpot when the list was processed */
    wasInHubspot: boolean("was_in_hubspot").default(false),
    /** Whether this contact was physically met at the conference (G3) */
    metAtConference: boolean("met_at_conference").default(false),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_list_contacts_list").on(table.listId),
    index("idx_list_contacts_contact").on(table.contactId),
    uniqueIndex("idx_list_contacts_unique").on(table.listId, table.contactId),
  ]
);

// --- Enrichment Runs ---

/**
 * Log of enrichment operations. Tracks what was enriched, by whom,
 * success/failure, and stores raw payload for audit.
 */
export const enrichmentRuns = pgTable(
  "enrichment_runs",
  {
    id: serial("id").primaryKey(),
    /** Which contact was enriched (null for account-level enrichment) */
    contactId: uuid("contact_id").references(() => contacts.id),
    /** Which account was enriched (null for contact-level-only enrichment) */
    accountId: uuid("account_id").references(() => accounts.id),
    source: enrichmentSourceEnum("source").notNull(),
    status: enrichmentStatusEnum("status").default("pending").notNull(),
    /** Credits consumed for this enrichment (for cost tracking) */
    creditsUsed: integer("credits_used").default(0),
    /** Raw API response payload */
    rawPayload: jsonb("raw_payload"),
    /** Error message if failed */
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    index("idx_enrichment_runs_contact").on(table.contactId),
    index("idx_enrichment_runs_account").on(table.accountId),
    index("idx_enrichment_runs_source").on(table.source),
    index("idx_enrichment_runs_created").on(table.createdAt),
  ]
);

// --- Opportunities (MEDDPIC pipeline) ---

/**
 * Deals in the MEDDPIC Opportunity Pipeline. Each opportunity tracks all six
 * MEDDPIC qualification criteria with both a status enum and free-text detail.
 */
export const opportunities = pgTable(
  "opportunities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    name: text("name").notNull(),
    stage: opportunityStageEnum("stage").default("target_identified").notNull(),
    amount: real("amount"),
    closeDate: date("close_date"),
    /** HubSpot owner ID */
    ownerId: text("owner_id"),

    // -- MEDDPIC: Metrics --
    meddpicMetricsStatus: meddpicStatusEnum("meddpic_metrics_status").default("not_started"),
    meddpicMetricsDetail: text("meddpic_metrics_detail"),

    // -- MEDDPIC: Economic Buyer --
    meddpicEconomicBuyerStatus: meddpicStatusEnum("meddpic_economic_buyer_status").default("not_started"),
    meddpicEconomicBuyerDetail: text("meddpic_economic_buyer_detail"),

    // -- MEDDPIC: Decision Criteria --
    meddpicDecisionCriteriaStatus: meddpicStatusEnum("meddpic_decision_criteria_status").default("not_started"),
    meddpicDecisionCriteriaDetail: text("meddpic_decision_criteria_detail"),

    // -- MEDDPIC: Decision Process --
    meddpicDecisionProcessStatus: meddpicStatusEnum("meddpic_decision_process_status").default("not_started"),
    meddpicDecisionProcessDetail: text("meddpic_decision_process_detail"),

    // -- MEDDPIC: Identify Pain --
    meddpicIdentifyPainStatus: meddpicStatusEnum("meddpic_identify_pain_status").default("not_started"),
    meddpicIdentifyPainDetail: text("meddpic_identify_pain_detail"),

    // -- MEDDPIC: Champion --
    meddpicChampionStatus: meddpicStatusEnum("meddpic_champion_status").default("not_started"),
    meddpicChampionDetail: text("meddpic_champion_detail"),

    /** Calculated: (validated count / 6) * 100 */
    meddpicCompletionScore: real("meddpic_completion_score").default(0),

    // -- Deal intelligence --
    dealHealthScore: real("deal_health_score"),
    daysInCurrentStage: integer("days_in_current_stage").default(0),
    /** True if only 1 contact after 14 days */
    singleThreadRisk: boolean("single_thread_risk").default(false),
    competitorInEvaluation: text("competitor_in_evaluation"),
    nextStep: text("next_step"),
    nextStepDate: date("next_step_date"),
    lastMeetingDate: date("last_meeting_date"),
    championEngaged: boolean("champion_engaged").default(false),
    mutualActionPlanLink: text("mutual_action_plan_link"),

    /** Denormalized rollup from contact_activities (Blocker 5 / G9) */
    lastActivityDate: timestamp("last_activity_date"),

    /** Timestamp when the deal entered the current stage */
    stageEnteredAt: timestamp("stage_entered_at").defaultNow(),

    // -- External IDs --
    hubspotDealId: text("hubspot_deal_id"),

    // -- Timestamps --
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_opportunities_account").on(table.accountId),
    index("idx_opportunities_stage").on(table.stage),
    index("idx_opportunities_hubspot").on(table.hubspotDealId),
    index("idx_opportunities_health").on(table.dealHealthScore),
    index("idx_opportunities_last_activity").on(table.lastActivityDate),
  ]
);

// --- Deals (closing pipeline) ---

/**
 * Deals in the Closing Pipeline -- post-qualification. Created when an
 * opportunity has all 6 MEDDPIC criteria validated.
 */
export const deals = pgTable(
  "deals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** The opportunity this deal was converted from */
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    name: text("name").notNull(),
    stage: dealStageEnum("stage").default("solution_design").notNull(),
    amount: real("amount"),
    closeDate: date("close_date"),
    ownerId: text("owner_id"),

    // -- Closing process --
    procurementStatus: procurementStatusEnum("procurement_status").default("not_started"),
    securityQuestionnaireSent: boolean("security_questionnaire_sent").default(false),
    securityQuestionnaireCompleted: boolean("security_questionnaire_completed").default(false),
    contractType: contractTypeEnum("contract_type"),
    decisionDateTarget: date("decision_date_target"),
    budgetConfirmed: boolean("budget_confirmed").default(false),
    closeConfidence: closeConfidenceEnum("close_confidence"),

    // -- Win/Loss --
    lostReason: lostReasonEnum("lost_reason"),
    lostToCompetitor: text("lost_to_competitor"),
    winLossNotes: text("win_loss_notes"),

    // -- Expansion --
    expansionPotential: expansionPotentialEnum("expansion_potential"),
    landUseCase: text("land_use_case"),

    // -- External IDs --
    hubspotDealId: text("hubspot_deal_id"),

    // -- Timestamps --
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_deals_opportunity").on(table.opportunityId),
    index("idx_deals_account").on(table.accountId),
    index("idx_deals_stage").on(table.stage),
    index("idx_deals_hubspot").on(table.hubspotDealId),
  ]
);

// --- Contact Deal Roles (buying committee junction) ---

/**
 * Which contacts are involved in which opportunities, and what role
 * they play on the buying committee.
 */
export const contactDealRoles = pgTable(
  "contact_deal_roles",
  {
    id: serial("id").primaryKey(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    role: buyingRoleEnum("role").default("unknown").notNull(),
    /** Is this contact actively engaged in the last 14 days? */
    isActive: boolean("is_active").default(true),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_contact_deal_roles_contact").on(table.contactId),
    index("idx_contact_deal_roles_opportunity").on(table.opportunityId),
    uniqueIndex("idx_contact_deal_roles_unique").on(
      table.contactId,
      table.opportunityId
    ),
    /** Composite index for role-gap queries (S4) */
    index("idx_contact_deal_roles_opp_role").on(
      table.opportunityId,
      table.role
    ),
  ]
);

// --- Signals (intent / buying signals) ---

/**
 * Intent signals from Common Room, Bombora, G2, job postings, funding events.
 * Each signal links to an account and optionally a contact.
 */
export const signals = pgTable(
  "signals",
  {
    id: serial("id").primaryKey(),
    accountId: uuid("account_id").references(() => accounts.id),
    contactId: uuid("contact_id").references(() => contacts.id),
    type: signalTypeEnum("type").notNull(),
    /** Which system generated this signal */
    source: text("source").notNull(),
    /** External system signal ID for deduplication (G4) */
    externalId: text("external_id"),
    /** Human-readable description of the signal */
    description: text("description"),
    /** URL associated with the signal (page visited, job posting URL, etc.) */
    url: text("url"),
    /** Intent score from Bombora or similar (0-100) */
    intentScore: real("intent_score"),
    /** JSON array of intent topics */
    intentTopics: jsonb("intent_topics"),
    /** Common Room segment that triggered this signal */
    segment: text("segment"),
    /** When the signal was detected by the source system */
    detectedAt: timestamp("detected_at").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_signals_account").on(table.accountId),
    index("idx_signals_contact").on(table.contactId),
    index("idx_signals_type").on(table.type),
    index("idx_signals_detected").on(table.detectedAt),
    /** Unique index for deduplication -- only applies when external_id is not null (G4) */
    uniqueIndex("idx_signals_source_external_id")
      .on(table.source, table.externalId)
      .where(sql`external_id IS NOT NULL`),
  ]
);

// --- Sync Log (audit trail) ---

/**
 * Audit trail of every sync operation between Supabase and external systems.
 * Enables debugging and retry logic.
 */
export const syncLog = pgTable(
  "sync_log",
  {
    id: serial("id").primaryKey(),
    /** External system (hubspot, apollo, clay, common_room) */
    system: text("system").notNull(),
    direction: syncDirectionEnum("direction").notNull(),
    /** Entity type (contact, account, opportunity, deal) */
    entityType: text("entity_type").notNull(),
    /** Our Supabase record ID */
    entityId: text("entity_id").notNull(),
    /** External system record ID */
    externalId: text("external_id"),
    /** What operation was performed (create, update, delete) */
    operation: text("operation").notNull(),
    /** JSON diff of what changed */
    changeset: jsonb("changeset"),
    /** Did the sync succeed? */
    success: boolean("success").notNull(),
    /** Error message if failed */
    errorMessage: text("error_message"),
    /** How long the sync took in ms */
    durationMs: integer("duration_ms"),
    /** Number of retry attempts for this sync operation (S8) */
    retryCount: integer("retry_count").default(0),
    /** When to attempt the next retry for failed syncs (S8) */
    nextRetryAt: timestamp("next_retry_at"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_sync_log_system").on(table.system),
    index("idx_sync_log_entity").on(table.entityType, table.entityId),
    index("idx_sync_log_created").on(table.createdAt),
    index("idx_sync_log_success").on(table.success),
    index("idx_sync_log_retry").on(table.nextRetryAt),
  ]
);

// --- Agent Runs (Claude agent execution log) ---

/**
 * Log of every Claude agent execution -- classification, persona tagging,
 * meeting briefs, deal health scoring, etc.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: serial("id").primaryKey(),
    /** Agent type (classification, persona, conference_pipeline, meeting_brief, etc.) */
    agentType: text("agent_type").notNull(),
    /** Status of the run */
    status: agentRunStatusEnum("status").default("running").notNull(),
    /** Model used (e.g. "claude-opus-4-6", "claude-sonnet-4-6") */
    model: text("model"),
    /** JSON summary of input parameters */
    inputSummary: jsonb("input_summary"),
    /** JSON summary of output */
    outputSummary: jsonb("output_summary"),
    /** Error message if failed */
    errorMessage: text("error_message"),
    /** How long the run took in ms */
    durationMs: integer("duration_ms"),
    /** Input token count */
    inputTokens: integer("input_tokens"),
    /** Output token count */
    outputTokens: integer("output_tokens"),
    /** Associated review ID (if classification/persona run) */
    reviewId: text("review_id"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    index("idx_agent_runs_type").on(table.agentType),
    index("idx_agent_runs_status").on(table.status),
    index("idx_agent_runs_created").on(table.createdAt),
    index("idx_agent_runs_review").on(table.reviewId),
  ]
);

// --- Meetings (Blocker 1: meeting intelligence) ---

/**
 * Meeting records from Granola transcripts, Apollo Conversation Intelligence,
 * or manual entry. Stores transcripts, summaries, Claude-extracted MEDDPIC
 * updates, competitive intelligence, action items, and pre-meeting briefs.
 */
export const meetings = pgTable(
  "meetings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Associated account (nullable -- may not be identified yet) */
    accountId: uuid("account_id").references(() => accounts.id),
    /** Associated opportunity (nullable -- may be a discovery call with no deal yet) */
    opportunityId: uuid("opportunity_id").references(() => opportunities.id),
    /** Meeting title / subject */
    title: text("title").notNull(),
    /** When the meeting occurred */
    meetingDate: timestamp("meeting_date").notNull(),
    /** Array of attendees: [{name, email, role}] */
    attendees: jsonb("attendees"),
    /** Full Granola transcript text (nullable -- not always available) */
    transcript: text("transcript"),
    /** Granola or Claude-generated meeting summary */
    summary: text("summary"),
    /** Structured MEDDPIC updates extracted by Claude from the transcript */
    meddpicExtractions: jsonb("meddpic_extractions"),
    /** Competitive intel: {competitors: [], objections: [], buying_signals: []} */
    competitiveIntel: jsonb("competitive_intel"),
    /** Extracted action items from the meeting */
    actionItems: jsonb("action_items"),
    /** Pre-meeting brief text generated by Claude (G10, G11) */
    briefText: text("brief_text"),
    /** Where the meeting data came from */
    source: text("source").notNull(),
    /** Which agent processed this meeting (nullable) */
    agentRunId: integer("agent_run_id").references(() => agentRuns.id),
    /** HubSpot engagement ID for the meeting */
    hubspotMeetingId: text("hubspot_meeting_id"),
    /** Granola meeting ID for dedup */
    granolaMeetingId: text("granola_meeting_id"),

    // -- Timestamps --
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_meetings_account").on(table.accountId),
    index("idx_meetings_opportunity").on(table.opportunityId),
    index("idx_meetings_date").on(table.meetingDate),
    index("idx_meetings_hubspot").on(table.hubspotMeetingId),
  ]
);

// --- Contact Activities (Blocker 2: engagement event tracking) ---

/**
 * Individual engagement events per contact: email opens, clicks, replies,
 * bounces, meetings, calls, LinkedIn messages, website visits.
 * Feeds into deal health scoring (last activity recency) and historical
 * contact engagement analysis.
 */
export const contactActivities = pgTable(
  "contact_activities",
  {
    id: serial("id").primaryKey(),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    /** Associated account (nullable -- denormalized for efficient account-level queries) */
    accountId: uuid("account_id").references(() => accounts.id),
    /** Associated opportunity (nullable -- links activity to a deal for health scoring) */
    opportunityId: uuid("opportunity_id").references(() => opportunities.id),
    /** Type of activity */
    activityType: activityTypeEnum("activity_type").notNull(),
    /** When the activity occurred */
    activityDate: timestamp("activity_date").notNull(),
    /** Which system reported this activity */
    source: text("source").notNull(),
    /** Flexible payload: sequence name, email subject, page URL, call duration, etc. */
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_contact_activities_contact").on(table.contactId),
    index("idx_contact_activities_account").on(table.accountId),
    index("idx_contact_activities_opportunity").on(table.opportunityId),
    index("idx_contact_activities_date").on(table.activityDate),
    index("idx_contact_activities_type").on(table.activityType),
    /** Composite index for per-contact timeline queries */
    index("idx_contact_activities_contact_date").on(
      table.contactId,
      table.activityDate
    ),
  ]
);

// --- Sending Accounts (Blocker 3: email warmup tracking) ---

/**
 * Email sending mailboxes tracked for Instantly warmup status and health.
 * Used to determine which sending accounts are healthy enough for cold outreach
 * before enrolling contacts in Apollo sequences.
 */
export const sendingAccounts = pgTable(
  "sending_accounts",
  {
    id: serial("id").primaryKey(),
    /** Email address of the sending mailbox */
    email: text("email").notNull().unique(),
    /** Email provider */
    provider: text("provider").notNull(),
    /** Warmup status from Instantly */
    warmupStatus: warmupStatusEnum("warmup_status").default("not_started").notNull(),
    /** Instantly health score (0-100) */
    healthScore: real("health_score"),
    /** Maximum emails this account can send per day */
    dailySendLimit: integer("daily_send_limit"),
    /** Instantly account ID for API calls */
    instantlyAccountId: text("instantly_account_id"),
    /** Last time health was checked via Instantly API */
    lastHealthCheck: timestamp("last_health_check"),

    // -- Timestamps --
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_sending_accounts_warmup").on(table.warmupStatus),
  ]
);

// --- Work Items (tracking board: bot-suggested + manual tasks) ---

/**
 * The unit the GTM tracking board renders and the proactive bot writes into.
 *
 * Every suggestion the bot makes (post-meeting follow-ups, CRM updates, prep)
 * is a row here with status `suggested` -- it is NEVER auto-applied. A human
 * approves, which flips status to `approved` and (later) triggers the write.
 * The morning digest reads this table to summarize what was added / completed.
 *
 * FKs to accounts/opportunities/meetings are all nullable on purpose: a
 * suggestion can fire from the recall webhook before the matching account or
 * meeting row exists. `customerSlug` + `sourceRef` (the recall botId) are the
 * durable join keys; the typed FKs get backfilled when the rows appear.
 */
export const workItems = pgTable(
  "work_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Coarse family (digest/dedup). Derived from `kind` via KIND_TO_TYPE. */
    type: workItemTypeEnum("type").notNull(),
    /** Fine-grained GTM task kind (the real taxonomy) */
    kind: workItemKindEnum("kind").default("generic").notNull(),
    /** One-line human summary -- what the board card and list render */
    title: text("title").notNull(),
    /** Lifecycle status. Columns derive from this via COLUMN_OF(). */
    status: workItemStatusEnum("status").default("triage").notNull(),
    /** How this item was created */
    source: workItemSourceEnum("source").notNull(),
    /** Whether the owner is a human teammate or the bot */
    ownerKind: workItemOwnerKindEnum("owner_kind").default("human").notNull(),
    /** Teammate email (assignee + HubSpot ownership rule); null if unassigned */
    ownerEmail: text("owner_email"),
    /** Bot is a co-owner doing a first pass (acts AS ownerEmail) */
    botAssigned: boolean("bot_assigned").default(false).notNull(),

    // -- attribution / grouping FKs (all nullable) --
    accountId: uuid("account_id").references(() => accounts.id),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id),
    meetingId: uuid("meeting_id").references(() => meetings.id),
    /** Which top-level board this item lives on (GTM / Success / Operations) */
    boardId: uuid("board_id").references(() => boards.id),
    projectId: uuid("project_id").references(() => projects.id),
    cycleId: uuid("cycle_id").references(() => cycles.id),
    templateId: uuid("template_id").references(() => templates.id),
    /** Subtask containment spine (self-FK); orphan-not-destroy */
    parentId: uuid("parent_id").references((): AnyPgColumn => workItems.id, {
      onDelete: "set null",
    }),
    /** Denormalized recall slug -- survives even with no account row */
    customerSlug: text("customer_slug"),
    /** Recall botId (post_meeting) / cron run id / gmail:{msgId} / null */
    sourceRef: text("source_ref"),

    /** The machine-actionable payload, shaped per `kind` */
    payload: jsonb("payload").notNull(),

    // -- subtask rollup (denormalized; choke-point-maintained, sweep-reconciled) --
    childOpenCount: integer("child_open_count").default(0).notNull(),
    childTotalCount: integer("child_total_count").default(0).notNull(),

    // -- dates + aging --
    dueAt: timestamp("due_at"),
    /** First-ever entry to in_progress (total cycle age) */
    startedAt: timestamp("started_at"),
    /** Stamped on EVERY column/stage change (per-stage aging / SLA) */
    stageEnteredAt: timestamp("stage_entered_at"),
    waitingOn: text("waiting_on"),
    slaTarget: timestamp("sla_target"),

    // -- priority --
    /** Manual high-priority flag; OR'd with the derived due<7d rule at read */
    highPriority: boolean("high_priority").default(false).notNull(),
    /** Email of a human who pinned priority; auto-bump won't override */
    priorityLockedBy: text("priority_locked_by"),
    /** Cron bookkeeping for the "became urgent" ping; never read for color */
    priorityStampedAt: timestamp("priority_stamped_at"),

    /** LexoRank fractional key for manual within-column ordering */
    boardRank: text("board_rank"),

    // -- bot first-pass --
    botTaskRevision: integer("bot_task_revision").default(0).notNull(),

    // -- recurrence (hooks) --
    recurrenceRule: text("recurrence_rule"),
    nextRecurAt: timestamp("next_recur_at"),
    recurrenceParentId: uuid("recurrence_parent_id").references(
      (): AnyPgColumn => workItems.id,
      { onDelete: "set null" }
    ),

    // -- HubSpot sync state (P3 hooks) --
    hubspotSyncStatus: text("hubspot_sync_status").default("none").notNull(),
    hubspotObjectType: text("hubspot_object_type"),
    hubspotObjectId: text("hubspot_object_id"),
    hubspotSyncedAt: timestamp("hubspot_synced_at"),
    hubspotSyncKey: text("hubspot_sync_key"),
    syncError: text("sync_error"),

    // -- concurrency: THE optimistic-lock guard token --
    version: integer("version").default(1).notNull(),

    // -- lifecycle --
    dismissedReason: text("dismissed_reason"),
    approvedBy: text("approved_by"),
    approvedAt: timestamp("approved_at"),
    completedAt: timestamp("completed_at"),
    /** 'bot' | 'seed' | 'system' | slack user id / email */
    createdBy: text("created_by").default("bot").notNull(),

    // -- timestamps --
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (table) => [
    index("idx_work_items_status").on(table.status),
    index("idx_work_items_kind").on(table.kind),
    index("idx_work_items_owner").on(table.ownerEmail),
    index("idx_work_items_account").on(table.accountId),
    index("idx_work_items_opportunity").on(table.opportunityId),
    index("idx_work_items_meeting").on(table.meetingId),
    index("idx_work_items_board").on(table.boardId),
    index("idx_work_items_project").on(table.projectId),
    index("idx_work_items_cycle").on(table.cycleId),
    index("idx_work_items_parent").on(table.parentId),
    index("idx_work_items_due").on(table.dueAt),
    index("idx_work_items_high_priority").on(table.highPriority),
    index("idx_work_items_bot_assigned").on(table.botAssigned),
    index("idx_work_items_rank").on(table.status, table.boardRank),
    index("idx_work_items_source_ref").on(table.sourceRef),
    index("idx_work_items_customer_slug").on(table.customerSlug),
    /** Idempotency for automation creates (tightened to kind in v2). */
    uniqueIndex("idx_work_items_dedup")
      .on(table.sourceRef, table.kind, table.title)
      .where(sql`${table.sourceRef} IS NOT NULL`),
  ]
);

export type WorkItem = typeof workItems.$inferSelect;
export type NewWorkItem = typeof workItems.$inferInsert;

// --- Activity ledger (append-only timeline; comments live here too) ---

export const workItemActivities = pgTable(
  "work_item_activities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workItemId: uuid("work_item_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    kind: workItemActivityKindEnum("kind").notNull(),
    actorKind: actorKindEnum("actor_kind").notNull(),
    actorEmail: text("actor_email"),
    /** Human-readable timeline line / comment text */
    body: text("body"),
    /** Structured per kind (e.g. {field, before, after}) */
    meta: jsonb("meta"),
    /** work_items.version AFTER this write (for guarded writes) */
    resultingVersion: integer("resulting_version"),
    /** When it really happened; backdatable for logged_activity */
    occurredAt: timestamp("occurred_at").defaultNow().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    /** Automation idempotency; NULL for human comments */
    dedupeKey: text("dedupe_key"),
  },
  (t) => [
    index("idx_wia_item_occurred").on(t.workItemId, t.occurredAt),
    index("idx_wia_kind").on(t.kind),
    uniqueIndex("idx_wia_dedupe")
      .on(t.dedupeKey)
      .where(sql`${t.dedupeKey} IS NOT NULL`),
  ]
);
export type WorkItemActivity = typeof workItemActivities.$inferSelect;
export type NewWorkItemActivity = typeof workItemActivities.$inferInsert;

// --- Bot first-pass output (inert drafts) ---

export const workItemDrafts = pgTable(
  "work_item_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workItemId: uuid("work_item_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    kind: text("kind"),
    title: text("title"),
    body: text("body"),
    artifactUrl: text("artifact_url"),
    /** {gmailDraftId?, hubspotProposed?, muxUrl?, calendarSlots?} */
    externalRef: jsonb("external_ref"),
    producedBy: text("produced_by").default("bot").notNull(),
    actedAsEmail: text("acted_as_email"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("idx_wid_item").on(t.workItemId)]
);

// --- Bot attempt bookkeeping (exactly one non-failed pass per revision) ---

export const workItemBotAttempts = pgTable(
  "work_item_bot_attempts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workItemId: uuid("work_item_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    attemptNo: integer("attempt_no").default(1).notNull(),
    status: botAttemptStatusEnum("status").default("running").notNull(),
    oneshotRequestId: text("oneshot_request_id"),
    actedAsEmail: text("acted_as_email").notNull(),
    taskRevision: integer("task_revision").notNull(),
    draftId: uuid("draft_id").references(() => workItemDrafts.id),
    error: text("error"),
    startedAt: timestamp("started_at").defaultNow().notNull(),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [
    index("idx_wba_item").on(t.workItemId),
    /** At most one non-failed attempt per revision */
    uniqueIndex("idx_wba_one_per_rev")
      .on(t.workItemId, t.taskRevision)
      .where(sql`${t.status} <> 'failed'`),
  ]
);

// --- Boards (top-level: GTM / Success / Operations) ---

export const boards = pgTable("boards", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Stable key used in URLs/APIs: 'gtm' | 'success' | 'operations' */
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  sortOrder: integer("sort_order").default(0).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
export type Board = typeof boards.$inferSelect;

// --- Projects (deal rooms) — empty hook until P2 ---

export const projects = pgTable("projects", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  accountId: uuid("account_id").references(() => accounts.id),
  opportunityId: uuid("opportunity_id").references(() => opportunities.id),
  dealStage: text("deal_stage"),
  forecastWeight: real("forecast_weight"),
  health: text("health"),
  channelPartner: text("channel_partner"),
  status: projectStatusEnum("status").default("active").notNull(),
  ownerEmail: text("owner_email"),
  customFields: jsonb("custom_fields"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// --- Cycles (weekly cadence / CCW blitz) — empty hook ---

export const cycles = pgTable("cycles", {
  id: uuid("id").primaryKey().defaultRandom(),
  number: integer("number"),
  name: text("name"),
  cadence: cycleCadenceEnum("cadence").default("weekly").notNull(),
  startsAt: timestamp("starts_at"),
  endsAt: timestamp("ends_at"),
  status: text("status").default("active").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// --- Relations graph (blocks / relates / duplicate) — empty hook ---

export const workItemRelations = pgTable(
  "work_item_relations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    targetId: uuid("target_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    kind: workItemRelationKindEnum("kind").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("idx_wir_source").on(t.sourceId),
    index("idx_wir_target").on(t.targetId),
    uniqueIndex("idx_wir_unique").on(t.sourceId, t.targetId, t.kind),
  ]
);

// --- Labels + join — empty hook ---

export const labels = pgTable("labels", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  color: text("color"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const workItemLabels = pgTable(
  "work_item_labels",
  {
    workItemId: uuid("work_item_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    labelId: uuid("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (t) => [uniqueIndex("idx_wil_unique").on(t.workItemId, t.labelId)]
);

// --- Watchers — empty hook ---

export const workItemWatchers = pgTable(
  "work_item_watchers",
  {
    workItemId: uuid("work_item_id")
      .notNull()
      .references(() => workItems.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    reason: text("reason"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("idx_wiw_unique").on(t.workItemId, t.email)]
);

// --- Notifications (the /board/inbox feed) — empty hook ---

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    recipientEmail: text("recipient_email").notNull(),
    workItemId: uuid("work_item_id").references(() => workItems.id, {
      onDelete: "cascade",
    }),
    kind: notificationKindEnum("kind").notNull(),
    body: text("body"),
    readAt: timestamp("read_at"),
    slackTs: text("slack_ts"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (t) => [index("idx_notif_recipient").on(t.recipientEmail, t.readAt)]
);

// --- Templates (playbook → subtasks) — empty hook ---

export const templates = pgTable("templates", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  scope: text("scope"),
  spec: jsonb("spec"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// --- Automation rules — empty hook (the 3 v1 rules are hardcoded first) ---

export const automationRules = pgTable("automation_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name"),
  trigger: jsonb("trigger"),
  condition: jsonb("condition"),
  action: jsonb("action"),
  enabled: boolean("enabled").default(true).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// --- Saved views — empty hook ---

export const savedViews = pgTable("saved_views", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  ownerEmail: text("owner_email"),
  shared: boolean("shared").default(false).notNull(),
  spec: jsonb("spec"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// --- Gmail triage opt-in (P4 hook) ---

export const gmailTriageOptin = pgTable("gmail_triage_optin", {
  email: text("email").primaryKey(),
  enabled: boolean("enabled").default(true).notNull(),
  slots: text("slots").array(),
  notifyChannel: text("notify_channel"),
  lastRunAt: timestamp("last_run_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
