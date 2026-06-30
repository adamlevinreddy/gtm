import * as fuzzball from "fuzzball";
import type {
  ClassificationResult,
  CompanyListFile,
  ProspectListFile,
} from "./types";

interface LookupEntry {
  name: string;
  action: "exclude" | "tag" | "prospect";
  category: string | null;
}

export class CompanyClassifier {
  private lookup: Map<string, LookupEntry> = new Map();
  private prospectLookup: Map<string, LookupEntry> = new Map();
  private allKeys: string[] = [];

  static readonly FUZZY_THRESHOLD = 90;

  constructor(
    exclusions: CompanyListFile,
    tags: CompanyListFile,
    prospects: ProspectListFile
  ) {
    this.buildLookup(exclusions, tags, prospects);
  }

  private buildLookup(
    exclusions: CompanyListFile,
    tags: CompanyListFile,
    prospects: ProspectListFile
  ) {
    // Prospects first (they take precedence in matching)
    for (const company of prospects.companies) {
      const entry: LookupEntry = {
        name: company.name,
        action: "prospect",
        category: null,
      };
      this.prospectLookup.set(this.normalize(company.name), entry);
      for (const alias of company.aliases) {
        this.prospectLookup.set(this.normalize(alias), entry);
      }
    }

    for (const company of exclusions.companies) {
      const entry: LookupEntry = {
        name: company.name,
        action: "exclude",
        category: company.category,
      };
      this.lookup.set(this.normalize(company.name), entry);
      for (const alias of company.aliases) {
        this.lookup.set(this.normalize(alias), entry);
      }
    }

    for (const company of tags.companies) {
      const entry: LookupEntry = {
        name: company.name,
        action: "tag",
        category: company.category,
      };
      this.lookup.set(this.normalize(company.name), entry);
      for (const alias of company.aliases) {
        this.lookup.set(this.normalize(alias), entry);
      }
    }

    this.allKeys = [
      ...Array.from(this.prospectLookup.keys()),
      ...Array.from(this.lookup.keys()),
    ];
  }

  private normalize(name: string): string {
    return name.trim().toLowerCase();
  }

  classifyKnown(companyName: string): ClassificationResult | null {
    const normalized = this.normalize(companyName);

    // Check prospects first (they take precedence)
    const prospect = this.prospectLookup.get(normalized);
    if (prospect) {
      return {
        name: prospect.name,
        action: "prospect",
        category: null,
        confidence: "known",
        rationale: "Previously confirmed as prospect",
      };
    }

    // Check exclusions and tags
    const known = this.lookup.get(normalized);
    if (known) {
      return {
        name: known.name,
        action: known.action,
        category: known.category,
        confidence: "known",
        rationale: null,
      };
    }

    // Fuzzy match
    for (const key of this.allKeys) {
      const score = fuzzball.ratio(normalized, key);
      if (score >= CompanyClassifier.FUZZY_THRESHOLD) {
        const prospectMatch = this.prospectLookup.get(key);
        if (prospectMatch) {
          return {
            name: prospectMatch.name,
            action: "prospect",
            category: null,
            confidence: "known",
            rationale: `Fuzzy match (${score}%) to known prospect`,
          };
        }
        const knownMatch = this.lookup.get(key);
        if (knownMatch) {
          return {
            name: knownMatch.name,
            action: knownMatch.action,
            category: knownMatch.category,
            confidence: "known",
            rationale: `Fuzzy match (${score}%) to known company`,
          };
        }
      }
    }

    return null;
  }
}
