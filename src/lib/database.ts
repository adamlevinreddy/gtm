import { db } from "./db";
import { companies, companyAliases, categories } from "./schema";
import { eq } from "drizzle-orm";
import type { CompanyListFile, ProspectListFile } from "./types";

export interface CompanyListsData {
  exclusions: CompanyListFile;
  tags: CompanyListFile;
  prospects: ProspectListFile;
}

/**
 * Fetch all company lists from Postgres, formatted to match the old JSON structure
 * so the classifier and review flows work unchanged.
 */
export async function fetchCompanyLists(): Promise<CompanyListsData> {
  const allCompanies = await db
    .select()
    .from(companies)
    .leftJoin(companyAliases, eq(companies.id, companyAliases.companyId));

  const allCategories = await db.select().from(categories);

  // Build category maps
  const exclusionCategories: Record<string, { label: string; action: "exclude" }> = {};
  const tagCategories: Record<string, { label: string; action: "tag" }> = {};
  for (const cat of allCategories) {
    if (cat.action === "exclude") {
      exclusionCategories[cat.slug] = { label: cat.label, action: "exclude" };
    } else if (cat.action === "tag") {
      tagCategories[cat.slug] = { label: cat.label, action: "tag" };
    }
  }

  // Group aliases by company id
  const aliasMap = new Map<number, string[]>();
  for (const row of allCompanies) {
    if (row.company_aliases?.alias) {
      const existing = aliasMap.get(row.companies.id) || [];
      existing.push(row.company_aliases.alias);
      aliasMap.set(row.companies.id, existing);
    }
  }

  // Deduplicate companies (left join produces multiple rows per alias)
  const seen = new Set<number>();
  const exclusionCompanies: CompanyListFile["companies"] = [];
  const tagCompanies: CompanyListFile["companies"] = [];
  const prospectCompanies: ProspectListFile["companies"] = [];

  for (const row of allCompanies) {
    const c = row.companies;
    if (seen.has(c.id)) continue;
    seen.add(c.id);

    const aliases = aliasMap.get(c.id) || [];

    if (c.action === "exclude") {
      exclusionCompanies.push({
        name: c.name,
        aliases,
        category: c.category || "",
        added: c.added,
        source: c.source,
      });
    } else if (c.action === "tag") {
      tagCompanies.push({
        name: c.name,
        aliases,
        category: c.category || "",
        added: c.added,
        source: c.source,
      });
    } else if (c.action === "prospect") {
      prospectCompanies.push({
        name: c.name,
        aliases,
        added: c.added,
        source: c.source,
        note: c.note || "",
      });
    }
  }

  return {
    exclusions: { categories: exclusionCategories, companies: exclusionCompanies },
    tags: { categories: tagCategories, companies: tagCompanies },
    prospects: { companies: prospectCompanies },
  };
}

/**
 * Insert accepted/rejected companies into Postgres.
 * Replaces the old GitHub commit flow — atomic, no SHA conflicts.
 */
export async function commitCompanyListUpdates(items: {
  name: string;
  action: "exclude" | "tag" | "prospect";
  category: string | null;
  categoryLabel: string | null;
  source: string;
  note: string | null;
}[]): Promise<void> {
  const today = new Date().toISOString().split("T")[0];

  for (const item of items) {
    await db.insert(companies).values({
      name: item.name,
      action: item.action,
      category: item.category,
      categoryLabel: item.categoryLabel,
      added: today,
      source: item.source,
      note: item.note,
    });
  }
}
