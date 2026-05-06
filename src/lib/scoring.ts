import type { ExtractedContact } from "./extract";

export interface ScoredContact extends ExtractedContact {
  score: number;
  scoringBreakdown: {
    agentSize: number;
    seniority: number;
    personaFit: number;
    priorityRelevance: number;
    brandBonus: number;
  };
  /** "filtered" = below 100 agents, "existing_activity" = deep HubSpot activity, "ranked" = in the scored list */
  bucket: "filtered" | "existing_activity" | "ranked";
  filterReason?: string;
}

// ============================================================================
// Configurable weights (tweak these to adjust ranking)
// ============================================================================
export const SCORING_WEIGHTS = {
  /** Max 30 pts — larger contact centers = bigger deal */
  agentSize: 30,
  /** Max 25 pts — higher seniority = more decision power */
  seniority: 25,
  /** Max 25 pts — persona alignment with Reddy buyers */
  personaFit: 25,
  /** Max 15 pts — project priorities that match what Reddy does */
  priorityRelevance: 15,
  /** Bonus 5 pts — Brands get a bump over BPOs (direct buyers) */
  brandBonus: 5,
};

// ============================================================================
// Reddy-relevant priority keywords (things we actually do)
// ============================================================================
const REDDY_RELEVANT_PRIORITIES = [
  "training", "onboarding", "qa", "quality", "coaching", "agent performance",
  "agent development", "knowledge management", "knowledge base", "compliance",
  "speech analytics", "call scoring", "evaluation", "nesting", "simulation",
  "role play", "proficiency", "speed to proficiency", "new hire",
  "agent assist", "real-time", "real time", "supervisor", "team lead",
  "performance management", "calibration", "scorecard",
];

// Things that sound techy/AI but are NOT what Reddy does
const NOT_REDDY_PRIORITIES = [
  "ivr", "interactive voice", "chatbot", "self-service", "self service",
  "robotic process", "rpa", "voicebot", "virtual agent",
  "workforce management", "wfm", "scheduling", "forecasting",
  "ccaas", "contact center as a service", "telephony", "pbx", "sip",
  "crm migration", "erp", "digital transformation",
];

function scoreAgentSize(contact: ExtractedContact): number {
  const count = contact.agentCount;
  const guess = contact.agentLevelGuess;
  const max = SCORING_WEIGHTS.agentSize;

  if (count !== null) {
    if (count >= 5000) return max;
    if (count >= 2000) return max * 0.9;
    if (count >= 1000) return max * 0.8;
    if (count >= 500) return max * 0.65;
    if (count >= 250) return max * 0.5;
    if (count >= 100) return max * 0.3;
    return 0; // below 100
  }

  if (guess === "High") return max * 0.7;
  if (guess === "Medium") return max * 0.45;
  if (guess === "Low") return max * 0.25;

  return max * 0.3; // unknown gets benefit of the doubt
}

function scoreSeniority(contact: ExtractedContact): number {
  const max = SCORING_WEIGHTS.seniority;
  const title = (contact.title || "").toLowerCase();

  // C-suite
  if (/\b(ceo|coo|cfo|cto|cxo|chief)\b/.test(title)) return max;
  // SVP / EVP
  if (/\b(svp|evp|senior vice president|executive vice president)\b/.test(title)) return max * 0.95;
  // VP
  if (/\bvp\b|vice president/.test(title)) return max * 0.85;
  // Director / Head of
  if (/\b(director|head of)\b/.test(title)) return max * 0.7;
  // Senior Manager
  if (/\bsenior\s+manager\b/.test(title)) return max * 0.55;
  // Manager
  if (/\bmanager\b/.test(title)) return max * 0.4;
  // Analyst / Specialist / Coordinator
  if (/\b(analyst|specialist|coordinator|lead)\b/.test(title)) return max * 0.25;

  return max * 0.15; // unknown title
}

function scorePersonaFit(contact: ExtractedContact): number {
  const max = SCORING_WEIGHTS.personaFit;
  const persona = contact.persona;

  // Primary Reddy buyer personas
  if (persona === "cx_leadership") return max;
  if (persona === "ld") return max * 0.95;
  if (persona === "qa") return max * 0.9;
  // Secondary personas
  if (persona === "wfm") return max * 0.5;
  if (persona === "km") return max * 0.6;
  if (persona === "it") return max * 0.4;
  if (persona === "sales_marketing") return max * 0.3;
  // Not buyers
  if (persona === "excluded") return 0;
  return max * 0.2; // unknown
}

function scorePriorityRelevance(contact: ExtractedContact): number {
  const max = SCORING_WEIGHTS.priorityRelevance;
  const priorities = (contact.projectPriorities || "").toLowerCase();
  if (!priorities) return max * 0.3; // no priorities = unknown, slight benefit of doubt

  // Check for NOT-Reddy priorities first (penalize)
  const hasNotReddy = NOT_REDDY_PRIORITIES.some((kw) => priorities.includes(kw));

  // Check for Reddy-relevant priorities
  const reddyMatches = REDDY_RELEVANT_PRIORITIES.filter((kw) => priorities.includes(kw));

  if (reddyMatches.length >= 3) return max;
  if (reddyMatches.length === 2) return max * 0.8;
  if (reddyMatches.length === 1) return hasNotReddy ? max * 0.4 : max * 0.6;
  if (hasNotReddy) return max * 0.1;

  return max * 0.2; // generic priorities
}

function scoreBrandBonus(contact: ExtractedContact): number {
  if (contact.brandBpoType === "Brand") return SCORING_WEIGHTS.brandBonus;
  if (contact.brandBpoType === "BPO") return SCORING_WEIGHTS.brandBonus * 0.6;
  return 0;
}

/**
 * Score and bucket contacts.
 *
 * @param contacts - Extracted contacts from Claude
 * @param hubspotActiveCompanies - Company names with deep existing HubSpot activity
 * @param hubspotActiveEmails - Emails of contacts with deep existing activity
 */
export function scoreContacts(
  contacts: ExtractedContact[],
  hubspotActiveCompanies: Set<string>,
  hubspotActiveEmails: Set<string>
): ScoredContact[] {
  return contacts.map((contact) => {
    const agentSize = scoreAgentSize(contact);
    const seniority = scoreSeniority(contact);
    const personaFit = scorePersonaFit(contact);
    const priorityRelevance = scorePriorityRelevance(contact);
    const brandBonus = scoreBrandBonus(contact);

    const score = Math.round(agentSize + seniority + personaFit + priorityRelevance + brandBonus);

    // Determine bucket
    let bucket: ScoredContact["bucket"] = "ranked";
    let filterReason: string | undefined;

    // Filter: below 100 agents (when we know)
    if (contact.agentCount !== null && contact.agentCount < 100) {
      bucket = "filtered";
      filterReason = `Below 100 agents (${contact.agentCount})`;
    }
    // Filter: competitors and press
    else if (contact.brandBpoType === "Competitor") {
      bucket = "filtered";
      filterReason = "Competitor";
    }
    else if (contact.brandBpoType === "Press") {
      bucket = "filtered";
      filterReason = "Press/Media";
    }
    // Filter: excluded personas (vendor-side roles)
    else if (contact.persona === "excluded") {
      bucket = "filtered";
      filterReason = "Excluded persona (vendor/non-buyer role)";
    }
    // Existing activity: deep HubSpot engagement
    else if (
      (contact.email && hubspotActiveEmails.has(contact.email.toLowerCase())) ||
      (contact.company && hubspotActiveCompanies.has(contact.company.toLowerCase()))
    ) {
      bucket = "existing_activity";
    }

    return {
      ...contact,
      score,
      scoringBreakdown: { agentSize, seniority, personaFit, priorityRelevance, brandBonus },
      bucket,
      filterReason,
    };
  });
}
