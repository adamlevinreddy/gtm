// Deterministic account identity (Arc VI — HubSpot alignment).
//
// Root cause of duplicate accounts ("1-800-Flowers.com" twice): the display
// label + grouping key were the HubSpot resolver's output, which warms LAZILY
// and CAPPED — so an un-warmed meeting showed a raw title-derived label while
// its warmed sibling showed the canonical one, and the rollup/dropdown grouped
// by that display STRING. Two labels → two "accounts".
//
// Fix: derive a STABLE key from a normalized form of the label/slug — no async,
// no warm dependency — so every spelling of one company collapses immediately.
// The HubSpot resolver still enriches (canonical display + company id for the
// deep link) but no longer decides identity. An explicit alias map handles the
// cases normalization can't (abbreviations like NDR → National Debt Relief).

// Meeting-title noise + company suffixes stripped during normalization so
// "1-800-Flowers.com", "1 800 Flowers", "800 flowers weekly" all collapse.
const NOISE = new Set([
  "weekly", "biweekly", "sync", "standup", "meeting", "call", "touchbase",
  "checkin", "catchup", "kickoff", "intro", "demo", "reddy", "monthly", "the",
]);
const SUFFIX = new Set(["com", "inc", "llc", "ltd", "corp", "co", "group", "holdings", "gmbh", "sa"]);

/** Collapse a label/slug to a stable comparison token:
 *  "1-800-Flowers.com" / "1 800 Flowers" / "800 flowers weekly" → "1800flowers". */
export function normalizeName(s: string): string {
  const t = (s || "")
    .toLowerCase()
    .replace(/\.(com|io|net|org|co|ai|app)\b/g, " ") // drop TLDs
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const words = t.split(/\s+/).filter((w) => w && !NOISE.has(w) && !SUFFIX.has(w));
  return words.join("");
}

// Semantic aliases normalization can't catch. Key = normalizeName(input);
// `canon` is the shared grouping token, `display` the label everyone sees.
// Human-editable — add a line to merge a stubborn pair.
const ACCOUNT_ALIASES: Record<string, { display: string; canon: string }> = {
  "1800flowers": { display: "1-800-Flowers.com", canon: "1800flowers" },
  "800flowers": { display: "1-800-Flowers.com", canon: "1800flowers" }, // "800 Flowers" drops the leading 1
  "ndr": { display: "National Debt Relief", canon: "nationaldebtrelief" },
  "nationaldebtrelief": { display: "National Debt Relief", canon: "nationaldebtrelief" },
  "tp": { display: "Teleperformance", canon: "teleperformance" },
  "teleperformance": { display: "Teleperformance", canon: "teleperformance" },
};

export function slugifyAccount(s: string): string {
  return (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function prettyAccount(s: string): string {
  return (s || "")
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

export type AccountCanon = {
  /** Stable grouping key — same for every spelling of one company. */
  key: string;
  /** Canonical display from the alias map, if any (else null → caller decides). */
  aliasDisplay: string | null;
};

/** Deterministic identity for a meeting's account — NO HubSpot/warm dependency.
 * Prefer a real attributed slug over the free-text title label. */
export function accountCanon(rawLabel: string, slug?: string | null): AccountCanon {
  const base = slug && slug !== "_unsorted" ? slug : rawLabel;
  const norm = normalizeName(base) || normalizeName(rawLabel) || "unknown";
  const alias = ACCOUNT_ALIASES[norm];
  return { key: alias?.canon ?? norm, aliasDisplay: alias?.display ?? null };
}
