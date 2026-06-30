// ============================================================================
// BOT-ASSISTED CANONICAL COMPANY RESOLVER.
//
// deriveAccountLabel produces messy strings ("800 flowers", "NDR", "Lowe").
// This resolves a label → a canonical HubSpot company {name, id} so the hub
// groups one company under one clean name. Resolution runs over DISTINCT labels
// (dozens), never per-meeting (~700), and is KV-cached 7d. Ladder: cache →
// slug-exact → email-domain → name-exact → BOT pick (for abbreviations/variants)
// → fallback. The bot only fires for the hard tail and is capped per render.
// ============================================================================

import { kv } from "@/lib/kv-client";
import { selfBaseUrl } from "@/lib/work-items";
import {
  canonicalizeCompany,
  findCompanyByDomain,
  searchCompaniesByName,
  type CanonCompany,
} from "@/lib/hubspot";

export type ResolvedCompany = {
  canonical: string;
  hubspotCompanyId: string | null;
  domain: string | null;
  source: "slug-exact" | "domain" | "name-exact" | "bot-pick" | "fallback" | "cache";
  confidence: "high" | "medium" | "low";
};

export type LabelEvidence = {
  rawLabel: string;
  sampleTitles: string[];
  emailDomains: string[];
  slugs: string[];
};

const CANON_TTL = 7 * 24 * 3600;
const MAX_BOT_CALLS_PER_RENDER = 6; // bound cold-cache latency (page maxDuration 60)

function canonKey(ev: LabelEvidence): string {
  const lbl = ev.rawLabel.toLowerCase().replace(/\s+/g, " ").trim();
  const dom = [...new Set(ev.emailDomains)].sort().join(",");
  return `canon:v1:${lbl}|${dom}`;
}

function pretty(s: string): string {
  return s.split(/[-_]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

// --- deterministic steps (cheap, no bot) -----------------------------------
async function resolveDeterministic(ev: LabelEvidence): Promise<ResolvedCompany | null> {
  // slug-exact: an already-attributed slug → canonicalize its pretty form.
  const realSlug = ev.slugs.find((s) => s && s !== "_unsorted");
  if (realSlug) {
    const c = await canonicalizeCompany(pretty(realSlug)).catch(() => null);
    if (c) return { canonical: c.name, hubspotCompanyId: c.id, domain: c.domain, source: "slug-exact", confidence: "high" };
  }
  // domain: strongest when attendees have real emails.
  for (const d of ev.emailDomains) {
    const c = await findCompanyByDomain(d).catch(() => null);
    if (c) return { canonical: c.name, hubspotCompanyId: c.id, domain: c.domain, source: "domain", confidence: "high" };
  }
  // name-exact: the heuristic label is already the CRM name.
  const exact = await canonicalizeCompany(ev.rawLabel).catch(() => null);
  if (exact) return { canonical: exact.name, hubspotCompanyId: exact.id, domain: exact.domain, source: "name-exact", confidence: "high" };
  return null;
}

async function shortlistCandidates(ev: LabelEvidence): Promise<CanonCompany[]> {
  const tokens = [ev.rawLabel, ...ev.rawLabel.split(/\s+/).filter((w) => w.length > 2)].slice(0, 3);
  const byId = new Map<string, CanonCompany>();
  for (const t of tokens) {
    for (const c of await searchCompaniesByName(t, 8).catch(() => [])) byId.set(c.id, c);
    if (byId.size >= 10) break;
  }
  return [...byId.values()].slice(0, 10);
}

async function runOneshot(question: string, userEmail: string): Promise<string | null> {
  const secret = process.env.MCP_INTERNAL_SECRET;
  if (!secret) return null;
  try {
    const res = await fetch(`${selfBaseUrl()}/api/agent/oneshot`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-reddy-internal": secret },
      // Short poll: canon picks are quick classifications and run in the
      // background warm (capped); don't hold the budget for a slow/cold sandbox.
      body: JSON.stringify({ question, userEmail, pollTimeoutMs: 45_000 }),
    });
    const json = (await res.json().catch(() => null)) as { ok?: boolean; answer?: string } | null;
    return json?.ok && json.answer ? json.answer : null;
  } catch {
    return null;
  }
}

async function botPickCanonical(
  ev: LabelEvidence,
  shortlist: CanonCompany[],
  userEmail: string
): Promise<ResolvedCompany | null> {
  if (shortlist.length === 0) return null;
  const q = [
    `Pick the canonical HubSpot company for a messy meeting label. Output ONLY JSON.`,
    `Messy label: ${JSON.stringify(ev.rawLabel)}`,
    `Sample meeting titles: ${JSON.stringify(ev.sampleTitles.slice(0, 3))}`,
    `Attendee email domains (may be empty for Teams): ${JSON.stringify(ev.emailDomains)}`,
    `Candidate companies (choose by id, or null if none is the same real-world company):`,
    ...shortlist.map((c) => `  - id=${c.id} name=${JSON.stringify(c.name)} domain=${c.domain ?? ""}`),
    `Expand abbreviations (e.g. "NDR" → "National Debt Relief") and undo punctuation mangling (e.g. "800 Flowers" → "1-800-Flowers") when matching. Only return an id from the list.`,
    `Respond EXACTLY: {"hubspotCompanyId": string|null, "confidence":"high"|"medium"|"low"}`,
  ].join("\n");
  const ans = await runOneshot(q, userEmail);
  if (!ans) return null;
  let parsed: { hubspotCompanyId?: string | null; confidence?: string } | null = null;
  try {
    const s = ans.indexOf("{");
    const e = ans.lastIndexOf("}");
    if (s >= 0 && e > s) parsed = JSON.parse(ans.slice(s, e + 1));
  } catch {
    return null;
  }
  const id = parsed?.hubspotCompanyId ?? null;
  const picked = id ? shortlist.find((c) => c.id === id) : null; // verify id ∈ shortlist (no hallucination)
  if (!picked) return null;
  const conf = parsed?.confidence === "high" || parsed?.confidence === "medium" ? parsed.confidence : "medium";
  return { canonical: picked.name, hubspotCompanyId: picked.id, domain: picked.domain, source: "bot-pick", confidence: conf };
}

// RENDER path: KV cache reads ONLY (parallel, fast). Uncached labels are absent
// from the map → the caller falls back to the raw label. Never blocks on HubSpot
// or the bot, so the hub page stays well under its time budget.
export async function readCachedLabels(evidence: LabelEvidence[]): Promise<Map<string, ResolvedCompany>> {
  const out = new Map<string, ResolvedCompany>();
  await Promise.all(
    evidence.map(async (ev) => {
      const cached = await kv.get<ResolvedCompany>(canonKey(ev)).catch(() => null);
      if (cached) out.set(ev.rawLabel, { ...cached, source: "cache" });
    })
  );
  return out;
}

// WARM path (run in the background via after()): resolve uncached labels with
// the full ladder and write the cache so the NEXT render is canonical. Bounded
// deterministic work + a capped, short-poll bot step. Never throws.
export async function warmLabels(evidence: LabelEvidence[], opts: { userEmail: string }): Promise<void> {
  const needBot: LabelEvidence[] = [];

  // Deterministic + cache (parallel, bounded).
  const CONCURRENCY = 8;
  for (let i = 0; i < evidence.length; i += CONCURRENCY) {
    const chunk = evidence.slice(i, i + CONCURRENCY);
    await Promise.all(
      chunk.map(async (ev) => {
        if (await kv.get<ResolvedCompany>(canonKey(ev)).catch(() => null)) return; // already warmed
        const det = await resolveDeterministic(ev).catch(() => null);
        if (det) await kv.set(canonKey(ev), det, { ex: CANON_TTL }).catch(() => {});
        else needBot.push(ev);
      })
    );
  }

  // Bot for the hard tail — cap ATTEMPTS (not successes) to bound latency.
  let botCalls = 0;
  for (const ev of needBot) {
    let resolved: ResolvedCompany | null = null;
    if (botCalls < MAX_BOT_CALLS_PER_RENDER) {
      botCalls += 1;
      const shortlist = await shortlistCandidates(ev).catch(() => []);
      resolved = await botPickCanonical(ev, shortlist, opts.userEmail).catch(() => null);
    }
    const final: ResolvedCompany =
      resolved ?? { canonical: ev.rawLabel, hubspotCompanyId: null, domain: null, source: "fallback", confidence: "low" };
    // Bot-picks cached 7d; fallbacks short so a new CRM company is picked up soon.
    await kv.set(canonKey(ev), final, { ex: final.source === "fallback" ? 24 * 3600 : CANON_TTL }).catch(() => {});
  }
}
