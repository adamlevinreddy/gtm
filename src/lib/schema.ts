import {
  pgTable,
  text,
  serial,
  date,
  pgEnum,
  integer,
} from "drizzle-orm/pg-core";

export const actionEnum = pgEnum("action", ["exclude", "tag", "prospect"]);

/**
 * Single table for all known companies — exclusions, tags, and prospects.
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
  /** Notes — used for prospects and rejected classifications */
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
 * Category definitions — stores the label and default action for each category slug.
 */
export const categories = pgTable("categories", {
  slug: text("slug").primaryKey(),
  label: text("label").notNull(),
  action: actionEnum("action").notNull(),
});
