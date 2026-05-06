/**
 * migrate-exclusion-list.ts
 *
 * One-time migration script that reads conference-vendor-exclusion-list.md
 * and produces three JSON files in company-lists/:
 *   - exclusions.json   (SECTION 1 companies)
 *   - tags.json          (SECTION 2 companies)
 *   - known_prospects.json (SECTION 3 companies)
 *
 * Run with:  npx tsx scripts/migrate-exclusion-list.ts
 */

import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const ROOT = path.resolve(import.meta.dirname ?? __dirname, "..");
const MD_PATH = path.join(ROOT, "conference-vendor-exclusion-list.md");
const OUT_DIR = path.join(ROOT, "company-lists");

const TODAY = "2026-03-28";
const SOURCE = "CCW Las Vegas 2025";

/** Map SECTION 1 markdown headings to category keys */
const SECTION1_HEADING_MAP: Record<string, { key: string; label: string }> = {
  "CCaaS / Contact Center Platforms": {
    key: "ccaas",
    label: "CCaaS / Contact Center Platforms",
  },
  "AI / Conversational AI / Voice AI Vendors": {
    key: "ai_voice",
    label: "AI / Conversational AI / Voice AI Vendors",
  },
  "Quality / Analytics / WFM / CX Platforms": {
    key: "quality_analytics_wfm",
    label: "Quality / Analytics / WFM / CX Platforms",
  },
  "Workforce / Training / Knowledge Management": {
    key: "workforce_training_km",
    label: "Workforce / Training / Knowledge Management",
  },
  "Consulting / Advisory / Systems Integrators": {
    key: "consulting",
    label: "Consulting / Advisory / Systems Integrators",
  },
  "Telecom / Infrastructure Vendors": {
    key: "telecom_infrastructure",
    label: "Telecom / Infrastructure Vendors",
  },
  "Cloud / Big Tech (selling CX/CC solutions)": {
    key: "cloud_bigtech",
    label: "Cloud / Big Tech (selling CX/CC solutions)",
  },
  "CRM / SaaS / Marketing Tech (selling to CC)": {
    key: "crm_saas_martech",
    label: "CRM / SaaS / Marketing Tech (selling to CC)",
  },
  "Compliance / Identity / Security (selling to CC)": {
    key: "compliance_security",
    label: "Compliance / Identity / Security (selling to CC)",
  },
  "Reddy (ourselves)": {
    key: "self",
    label: "Reddy (ourselves)",
  },
};

/** Map SECTION 2 markdown headings to category keys */
const SECTION2_HEADING_MAP: Record<string, { key: string; label: string }> = {
  "Tag: BPO / Outsourcing": {
    key: "bpo",
    label: "BPO / Outsourcing",
  },
  "Tag: Media / Press": {
    key: "media",
    label: "Media / Press",
  },
};

// ---------------------------------------------------------------------------
// Known alias groups — canonical name is the first entry
// ---------------------------------------------------------------------------

interface AliasGroup {
  canonical: string;
  variants: string[]; // all raw names that should collapse into this group
}

const KNOWN_ALIAS_GROUPS: AliasGroup[] = [
  // --- SECTION 1 ---
  // CCaaS
  {
    canonical: "Alvaria",
    variants: ["Alvaria", "Alvaria, Inc."],
  },
  {
    canonical: "Cisco",
    variants: ["Cisco (contact center division)", "Cisco Systems", "Webex by Cisco"],
  },
  {
    canonical: "Gladly",
    variants: ["Gladly", "Gladly Software"],
  },
  {
    canonical: "Salesforce",
    variants: ["Salesforce"],
  },
  // AI / Voice
  {
    canonical: "Alhena AI",
    variants: ["Alhena", "Alhena AI"],
  },
  {
    canonical: "Bland.ai",
    variants: ["Bland", "Bland.ai"],
  },
  {
    canonical: "Goodcall",
    variants: ["Goodcall", "Goodcall AI"],
  },
  {
    canonical: "Krisp",
    variants: ["Krisp", "Krisp.AI"],
  },
  {
    canonical: "Observe.AI",
    variants: ["Observe.AI", "Obsereve.AI"],
  },
  {
    canonical: "Regal.ai",
    variants: ["Regal", "Regal.ai"],
  },
  {
    canonical: "ReflexAI",
    variants: ["ReflexAI", "ReflexAI.com"],
  },
  {
    canonical: "Sanas",
    variants: ["Sanas", "Sanas.AI Inc.", "Sanas.ai"],
  },
  {
    canonical: "Zingly.ai",
    variants: ["Zingly", "Zingly.ai"],
  },
  // Quality / Analytics
  {
    canonical: "CommunityWFM",
    variants: ["CommunityWFM", "Community WFM"],
  },
  {
    canonical: "Verint",
    variants: ["Verint", "Verint Systems Inc"],
  },
  // Workforce / Training
  {
    canonical: "SymTrain",
    variants: ["SymTrain", "Symtrain"],
  },
  // Telecom
  {
    canonical: "BT",
    variants: ["BT", "EE, BT & Plusnet"],
  },
  {
    canonical: "Meridian IT Inc.",
    variants: ["Meridian IT Inc", "Meridian IT Inc."],
  },
  {
    canonical: "Verizon Business",
    variants: ["Verizon Business", "Verizon Business Group"],
  },
  // Cloud / Big Tech
  {
    canonical: "AWS",
    variants: ["Amazon Web Services", "AWS"],
  },
  {
    canonical: "Google Cloud",
    variants: ["Google", "Google Cloud"],
  },
  // CRM / SaaS
  {
    canonical: "CollaborationRoom.ai",
    variants: ["CollaborationRoom.ai", "CollaborationRoom.aiq", "collaborationroom.ai"],
  },
  {
    canonical: "Contact Center Compliance",
    variants: ["CONTACT CENTER COMPLIANCE", "Contact Center Compliance"],
  },
  {
    canonical: "Datamatics",
    variants: ["Datamatics", "Datamatics Global Services"],
  },
  {
    canonical: "Emailgistics",
    variants: ["Emailgistics", "Emailgistics Corp."],
  },
  {
    canonical: "Pegasystems",
    variants: ["Pega", "Pegasystems"],
  },
  {
    canonical: "Readymode",
    variants: ["READYMODE", "Readymode"],
  },

  // --- SECTION 2: BPO ---
  {
    canonical: "Arise",
    variants: ["Arise", "Arise Virtual Solutions"],
  },
  {
    canonical: "Bayside Support Services",
    variants: ["Bayside Support Services", "Bayside Support Services, LLC"],
  },
  {
    canonical: "Foundever",
    variants: ["Foundever"],
  },
  {
    canonical: "ibex",
    variants: ["Ibex", "ibex", "IBEX GLOBAL SOLUTIONS"],
  },
  {
    canonical: "Inktel",
    variants: ["Inktel", "Inktel Contact Center Solutions"],
  },
  {
    canonical: "Liveops",
    variants: ["Liveops", "LiveOps", "Liveops, Inc."],
  },
  {
    canonical: "Movate",
    variants: ["Movate Inc", "Movate Inc."],
  },
  {
    canonical: "One Point One Solutions",
    variants: ["One Point One Solutions", "ONE POINT ONE SOLUTIONS"],
  },
  {
    canonical: "Sourcefit",
    variants: ["Sourcefit", "Sourcefit, SourceCX"],
  },
  {
    canonical: "SupportNinja",
    variants: ["SupportNinja", "SuppportNinja"],
  },
  {
    canonical: "Sutherland",
    variants: ["Sutherland", "Sutherland Global", "Sutherland Labs (Sutherland Global)"],
  },
  {
    canonical: "Tech Mahindra",
    variants: ["Tech Mahindra", "Tech Mahindra Americas Inc."],
  },
  {
    canonical: "TTEC",
    variants: ["TTEC", "TTEC DIGITAL", "TTEC Digital", "TTecDigital", "ttec"],
  },
  {
    canonical: "Working Solutions",
    variants: ["Working Solutions", "Working Soltuions"],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a lookup: raw company name -> AliasGroup */
function buildAliasLookup(): Map<string, AliasGroup> {
  const map = new Map<string, AliasGroup>();
  for (const group of KNOWN_ALIAS_GROUPS) {
    for (const v of group.variants) {
      map.set(v, group);
    }
  }
  return map;
}

interface RawCompany {
  name: string;
  categoryKey: string;
}

interface CompanyEntry {
  name: string;
  aliases: string[];
  category: string;
  added: string;
  source: string;
}

interface ProspectEntry {
  name: string;
  aliases: string[];
  added: string;
  source: string;
  note: string;
}

// ---------------------------------------------------------------------------
// Parse markdown
// ---------------------------------------------------------------------------

function parseMarkdown(md: string) {
  const lines = md.split("\n");

  let currentSection: 1 | 2 | 3 | null = null;
  let currentCategoryKey: string | null = null;

  const section1Raw: RawCompany[] = [];
  const section2Raw: RawCompany[] = [];
  const section3Raw: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Detect section boundaries
    if (trimmed.startsWith("# SECTION 1:")) {
      currentSection = 1;
      currentCategoryKey = null;
      continue;
    }
    if (trimmed.startsWith("# SECTION 2:")) {
      currentSection = 2;
      currentCategoryKey = null;
      continue;
    }
    if (trimmed.startsWith("# SECTION 3:")) {
      currentSection = 3;
      currentCategoryKey = null;
      continue;
    }
    // Stop at Notes section
    if (trimmed.startsWith("## Notes")) {
      currentSection = null;
      continue;
    }

    // Detect H2 category headings
    if (trimmed.startsWith("## ")) {
      const heading = trimmed.replace(/^## /, "");

      if (currentSection === 1) {
        const match = SECTION1_HEADING_MAP[heading];
        if (match) {
          currentCategoryKey = match.key;
        } else {
          console.warn(`SECTION 1: unrecognized heading "${heading}"`);
          currentCategoryKey = null;
        }
      } else if (currentSection === 2) {
        const match = SECTION2_HEADING_MAP[heading];
        if (match) {
          currentCategoryKey = match.key;
        } else {
          console.warn(`SECTION 2: unrecognized heading "${heading}"`);
          currentCategoryKey = null;
        }
      }
      continue;
    }

    // Skip blockquotes, empty lines, horizontal rules
    if (
      trimmed === "" ||
      trimmed.startsWith(">") ||
      trimmed === "---" ||
      trimmed.startsWith("#")
    ) {
      continue;
    }

    // Parse bullet items
    const bulletMatch = trimmed.match(/^- (.+)$/);
    if (!bulletMatch) continue;

    const companyName = bulletMatch[1].trim();

    if (currentSection === 1 && currentCategoryKey) {
      section1Raw.push({ name: companyName, categoryKey: currentCategoryKey });
    } else if (currentSection === 2 && currentCategoryKey) {
      section2Raw.push({ name: companyName, categoryKey: currentCategoryKey });
    } else if (currentSection === 3) {
      section3Raw.push(companyName);
    }
  }

  return { section1Raw, section2Raw, section3Raw };
}

// ---------------------------------------------------------------------------
// Deduplicate + assign aliases
// ---------------------------------------------------------------------------

function deduplicateCompanies(
  rawList: RawCompany[],
  aliasLookup: Map<string, AliasGroup>
): CompanyEntry[] {
  // Track which canonical names we've already emitted (to avoid duplicates)
  const seen = new Map<string, CompanyEntry>();

  for (const raw of rawList) {
    const group = aliasLookup.get(raw.name);

    if (group) {
      // This name belongs to an alias group
      const canonKey = group.canonical.toLowerCase();
      if (seen.has(canonKey)) {
        // Already emitted — nothing to do (aliases already captured)
        continue;
      }
      // Build aliases = all variants except the canonical name
      const aliases = group.variants.filter((v) => v !== group.canonical);
      seen.set(canonKey, {
        name: group.canonical,
        aliases,
        category: raw.categoryKey,
        added: TODAY,
        source: SOURCE,
      });
    } else {
      // Standalone company
      const key = raw.name.toLowerCase();
      if (seen.has(key)) continue; // exact duplicate (e.g. "Salesforce" twice)
      seen.set(key, {
        name: raw.name,
        aliases: [],
        category: raw.categoryKey,
        added: TODAY,
        source: SOURCE,
      });
    }
  }

  // Sort alphabetically by name (case-insensitive)
  return Array.from(seen.values()).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const md = fs.readFileSync(MD_PATH, "utf-8");
  const { section1Raw, section2Raw, section3Raw } = parseMarkdown(md);
  const aliasLookup = buildAliasLookup();

  // --- exclusions.json ---
  const exclusionCompanies = deduplicateCompanies(section1Raw, aliasLookup);
  const exclusionCategories: Record<string, { label: string; action: string }> = {};
  for (const [, { key, label }] of Object.entries(SECTION1_HEADING_MAP)) {
    exclusionCategories[key] = { label, action: "exclude" };
  }
  const exclusionsJson = {
    categories: exclusionCategories,
    companies: exclusionCompanies,
  };

  // --- tags.json ---
  const tagCompanies = deduplicateCompanies(section2Raw, aliasLookup);
  const tagCategories: Record<string, { label: string; action: string }> = {};
  for (const [, { key, label }] of Object.entries(SECTION2_HEADING_MAP)) {
    tagCategories[key] = { label, action: "tag" };
  }
  const tagsJson = {
    categories: tagCategories,
    companies: tagCompanies,
  };

  // --- known_prospects.json ---
  const prospects: ProspectEntry[] = section3Raw.map((name) => ({
    name,
    aliases: [],
    added: TODAY,
    source: SOURCE,
    note: "",
  }));
  const prospectsJson = { companies: prospects };

  // --- Write files ---
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const writeJson = (filename: string, data: unknown) => {
    const filepath = path.join(OUT_DIR, filename);
    fs.writeFileSync(filepath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    console.log(`Wrote ${filepath}`);
  };

  writeJson("exclusions.json", exclusionsJson);
  writeJson("tags.json", tagsJson);
  writeJson("known_prospects.json", prospectsJson);

  // --- Summary ---
  console.log("\n--- Summary ---");
  console.log(`Exclusions: ${exclusionCompanies.length} companies (raw lines: ${section1Raw.length})`);
  console.log(`Tags:       ${tagCompanies.length} companies (raw lines: ${section2Raw.length})`);
  console.log(`Prospects:  ${prospects.length} companies`);

  // Category breakdown for exclusions
  const excCatCounts: Record<string, number> = {};
  for (const c of exclusionCompanies) {
    excCatCounts[c.category] = (excCatCounts[c.category] || 0) + 1;
  }
  console.log("\nExclusion categories:");
  for (const [cat, count] of Object.entries(excCatCounts)) {
    console.log(`  ${cat}: ${count}`);
  }

  const tagCatCounts: Record<string, number> = {};
  for (const c of tagCompanies) {
    tagCatCounts[c.category] = (tagCatCounts[c.category] || 0) + 1;
  }
  console.log("\nTag categories:");
  for (const [cat, count] of Object.entries(tagCatCounts)) {
    console.log(`  ${cat}: ${count}`);
  }
}

main();
