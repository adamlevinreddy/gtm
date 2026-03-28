/** Category definition in exclusions.json or tags.json */
export interface CategoryDefinition {
  label: string;
  action: "exclude" | "tag";
}

/** A company entry in exclusions.json or tags.json */
export interface CompanyEntry {
  name: string;
  aliases: string[];
  category: string;
  added: string;
  source: string;
}

/** A company entry in known_prospects.json */
export interface ProspectEntry {
  name: string;
  aliases: string[];
  added: string;
  source: string;
  note: string;
}

/** The structure of exclusions.json or tags.json */
export interface CompanyListFile {
  categories: Record<string, CategoryDefinition>;
  companies: CompanyEntry[];
}

/** The structure of known_prospects.json */
export interface ProspectListFile {
  companies: ProspectEntry[];
}

/** Result of classifying a single company */
export interface ClassificationResult {
  name: string;
  action: "exclude" | "tag" | "prospect";
  category: string | null;
  confidence: "known" | "claude";
  rationale: string | null;
}

/** A company with its attendees, used as input to classification */
export interface CompanyWithTitles {
  name: string;
  titles: string[];
}

/** A row in the review table */
export interface ReviewItem {
  name: string;
  titles: string[];
  action: "exclude" | "tag" | "prospect";
  category: string | null;
  rationale: string | null;
}

/** A HubSpot contact match found during classification */
export interface HubSpotContactMatch {
  name: string;
  email: string | null;
  title: string | null;
}

/** A company with HubSpot CRM matches */
export interface HubSpotCompanyMatch {
  company: string;
  contacts: HubSpotContactMatch[];
}

/** Full review state stored in Vercel KV */
export interface ReviewData {
  id: string;
  source: string;
  createdAt: string;
  status: "pending" | "submitted" | "committed";
  /** Companies Claude classified (needing human review) */
  items: ReviewItem[];
  /** Companies already matched from known lists (no review needed) */
  knownResults: ClassificationResult[];
  /** Human decisions: company name → accept or reject */
  decisions: Record<string, "accept" | "reject"> | null;
  /** Summary after commit */
  commitSummary: {
    exclusionsAdded: number;
    tagsAdded: number;
    prospectsAdded: number;
  } | null;
  /** HubSpot CRM matches found during classification */
  hubspotMatches?: HubSpotCompanyMatch[];
}
