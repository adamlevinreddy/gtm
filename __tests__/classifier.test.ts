import { describe, it, expect } from "vitest";
import { CompanyClassifier } from "@/lib/classifier";
import type { CompanyListFile, ProspectListFile } from "@/lib/types";
import exclusions from "./fixtures/exclusions.json";
import tags from "./fixtures/tags.json";
import prospects from "./fixtures/known_prospects.json";

describe("CompanyClassifier", () => {
  const classifier = new CompanyClassifier(
    exclusions as CompanyListFile,
    tags as CompanyListFile,
    prospects as ProspectListFile
  );

  it("exact match on an exclusion (Five9 → exclude, ccaas)", () => {
    const result = classifier.classifyKnown("Five9");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("exclude");
    expect(result!.category).toBe("ccaas");
    expect(result!.confidence).toBe("known");
    expect(result!.name).toBe("Five9");
  });

  it("exact match on a tag (TTEC → tag, bpo)", () => {
    const result = classifier.classifyKnown("TTEC");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("tag");
    expect(result!.category).toBe("bpo");
    expect(result!.confidence).toBe("known");
    expect(result!.name).toBe("TTEC");
  });

  it("alias match (TTEC DIGITAL → tag, bpo)", () => {
    const result = classifier.classifyKnown("TTEC DIGITAL");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("tag");
    expect(result!.category).toBe("bpo");
    expect(result!.name).toBe("TTEC");
  });

  it("case-insensitive match (five9 → exclude)", () => {
    const result = classifier.classifyKnown("five9");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("exclude");
    expect(result!.name).toBe("Five9");
  });

  it('whitespace trimming ("  Five9  " → exclude)', () => {
    const result = classifier.classifyKnown("  Five9  ");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("exclude");
    expect(result!.name).toBe("Five9");
  });

  it("known prospect match (AT&T → prospect, known)", () => {
    const result = classifier.classifyKnown("AT&T");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("prospect");
    expect(result!.category).toBeNull();
    expect(result!.confidence).toBe("known");
    expect(result!.rationale).toBe("Previously confirmed as prospect");
  });

  it("known alias with typo match (Obsereve.AI → exclude, ai_voice)", () => {
    const result = classifier.classifyKnown("Obsereve.AI");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("exclude");
    expect(result!.category).toBe("ai_voice");
    expect(result!.name).toBe("Observe.AI");
  });

  it("fuzzy near-miss match (NICE Incontacts → exclude, ccaas)", () => {
    // "NICE Incontacts" is not an exact alias but scores ~97% fuzzy against "NICE inContact"
    const result = classifier.classifyKnown("NICE Incontacts");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("exclude");
    expect(result!.category).toBe("ccaas");
    expect(result!.confidence).toBe("known");
    expect(result!.rationale).toMatch(/Fuzzy match/);
  });

  it("unknown company returns null", () => {
    const result = classifier.classifyKnown("Acme Widget Corp");
    expect(result).toBeNull();
  });

  it("prospects take precedence over fuzzy vendor matches", () => {
    // Create a scenario where a prospect and a vendor have similar names
    const customExclusions: CompanyListFile = {
      categories: {
        vendor: { label: "Vendors", action: "exclude" },
      },
      companies: [
        {
          name: "AlphaTech Solutions",
          aliases: [],
          category: "vendor",
          added: "2026-03-28",
          source: "test",
        },
      ],
    };
    const customTags: CompanyListFile = {
      categories: {},
      companies: [],
    };
    const customProspects: ProspectListFile = {
      companies: [
        {
          name: "AlphaTech Solutions Inc",
          aliases: [],
          added: "2026-03-28",
          source: "test",
          note: "High-value prospect",
        },
      ],
    };

    const customClassifier = new CompanyClassifier(
      customExclusions,
      customTags,
      customProspects
    );

    // "AlphaTech Solutions" exactly matches the exclusion, but
    // "AlphaTech Solutons" (typo) should fuzzy match - prospects are checked first
    const result = customClassifier.classifyKnown("AlphaTech Solutons Inc");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("prospect");
    expect(result!.confidence).toBe("known");
    expect(result!.rationale).toMatch(/Fuzzy match/);
  });
});
