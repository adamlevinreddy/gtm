// Meeting index + canonical account labels, rolled up for the home view.
// Same canon ladder as the meetings hub: derive a raw label per meeting,
// resolve DISTINCT labels through the KV-cached resolver (cache reads only
// on the render path; uncached labels warm in the background via after()).

import { recentMeetingIndex, deriveAccountLabel, type IndexedMeeting } from "@/lib/recall-index";
import { readCachedLabels, readAccountInfo, type LabelEvidence, type ResolvedCompany } from "@/lib/company-resolver";
import { accountCanon, slugifyAccount, prettyAccount } from "@/lib/account-identity";

// reddy.io is excluded as evidence: our own people attend every meeting, and
// Reddy exists as a HubSpot company — domain resolution used to hit OURSELVES
// before the customer's domain and label customer meetings "Reddy".
const FREE_DOMAINS = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "reddy.io"]);
export const INTERNAL_ACCOUNT_LABELS = new Set(["Internal", "Reddy"]);

export type LabeledMeeting = IndexedMeeting & {
  account: string;
  /** Stable grouping key — every spelling of one company shares it. */
  accountKey: string;
  /** URL slug for /a/{slug} — derived from the canonical display. */
  accountSlug: string;
  hubspotCompanyId: string | null;
  isInternal: boolean;
};

export type AccountRollup = {
  account: string;
  accountKey: string;
  accountSlug: string;
  hubspotCompanyId: string | null;
  meetings: number;
  lastMeetingAt: string | null;
  lastMeetingTitle: string | null;
  lastMeetingBotId: string | null;
};

export async function labeledMeetings(
  pat: string,
  days: number,
  limit: number,
): Promise<{ meetings: LabeledMeeting[]; uncachedEvidence: LabelEvidence[] }> {
  const raw = await recentMeetingIndex(pat, days, limit).catch(() => [] as IndexedMeeting[]);

  const evidence = new Map<string, LabelEvidence>();
  const rawByBot = new Map<string, string>();
  for (const m of raw) {
    const label = deriveAccountLabel(m.title, m.customer_slug);
    rawByBot.set(m.bot_id, label);
    const e = evidence.get(label) ?? { rawLabel: label, sampleTitles: [], emailDomains: [], slugs: [] };
    if (m.title && e.sampleTitles.length < 3 && !e.sampleTitles.includes(m.title)) e.sampleTitles.push(m.title);
    for (const a of m.attendees) {
      const d = a.email?.split("@")[1]?.toLowerCase();
      if (d && !FREE_DOMAINS.has(d) && !e.emailDomains.includes(d)) e.emailDomains.push(d);
    }
    if (!e.slugs.includes(m.customer_slug)) e.slugs.push(m.customer_slug);
    evidence.set(label, e);
  }

  const allEvidence = [...evidence.values()];
  const resolved = await readCachedLabels(allEvidence).catch(() => new Map<string, ResolvedCompany>());
  const uncachedEvidence = allEvidence.filter((e) => !resolved.has(e.rawLabel));

  // Pass 1: per-meeting deterministic key + candidate display fields. The KEY
  // is warm-independent (normalized label/slug or an alias), so every spelling
  // of one company collapses to the same account whether or not it's warmed.
  type Row = {
    m: IndexedMeeting;
    key: string;
    allReddy: boolean;
    aliasDisplay: string | null;
    resolverCanonical: string | null;
    rawPretty: string;
    hubspotCompanyId: string | null;
  };
  const rows: Row[] = raw.map((m) => {
    const rawLabel = rawByBot.get(m.bot_id) ?? "Internal";
    const r = resolved.get(rawLabel);
    // Attendee-based internal detection: if every emailed attendee is @reddy.io,
    // this is a team meeting (CCW follow-up, pricing model, etc.) — group it
    // under "Internal" (excluded from the account dropdown), not a fake account.
    const emailed = (m.attendees ?? []).filter((a) => a.email);
    const allReddy = emailed.length > 0 && emailed.every((a) => a.email!.toLowerCase().endsWith("@reddy.io"));
    const canon = accountCanon(rawLabel, m.customer_slug);
    return {
      m,
      key: allReddy || INTERNAL_ACCOUNT_LABELS.has(rawLabel) ? "internal" : canon.key,
      allReddy,
      aliasDisplay: canon.aliasDisplay,
      resolverCanonical: r && r.canonical && r.canonical !== rawLabel ? r.canonical : null,
      rawPretty: prettyAccount(rawLabel),
      hubspotCompanyId: allReddy ? null : (r?.hubspotCompanyId ?? null),
    };
  });

  // Enrichment keyed by the STABLE accountKey — once any spelling is resolved
  // to HubSpot, every spelling here inherits the canonical name + company id
  // (no per-spelling re-warm). Highest-priority source of truth.
  const acctInfo = await readAccountInfo(rows.map((r) => r.key)).catch(() => new Map());

  // Pass 2: choose ONE display + one hubspotCompanyId per key, so the whole
  // group renders identically (this is what actually collapses the dropdown).
  // Preference: accountKey enrichment > alias > resolver canonical > raw pretty.
  const displayByKey = new Map<string, string>();
  const hsIdByKey = new Map<string, string>();
  const rawVotes = new Map<string, Map<string, number>>();
  for (const [key, info] of acctInfo) {
    displayByKey.set(key, info.canonical);
    if (info.hubspotCompanyId) hsIdByKey.set(key, info.hubspotCompanyId);
  }
  for (const row of rows) {
    if (row.key === "internal") continue;
    // Human alias overrides the CRM name; otherwise fill from resolver canonical.
    if (row.aliasDisplay) displayByKey.set(row.key, row.aliasDisplay);
    else if (row.resolverCanonical && !displayByKey.has(row.key)) displayByKey.set(row.key, row.resolverCanonical);
    if (row.hubspotCompanyId && !hsIdByKey.has(row.key)) hsIdByKey.set(row.key, row.hubspotCompanyId);
    const votes = rawVotes.get(row.key) ?? new Map<string, number>();
    votes.set(row.rawPretty, (votes.get(row.rawPretty) ?? 0) + 1);
    rawVotes.set(row.key, votes);
  }
  const displayFor = (key: string): string => {
    const chosen = displayByKey.get(key);
    if (chosen) return chosen;
    // No alias/canonical yet → the most common raw spelling in the group.
    const votes = rawVotes.get(key);
    if (!votes) return "Unknown";
    return [...votes.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0][0];
  };

  const meetings: LabeledMeeting[] = rows.map((row) => {
    const isInternal = row.allReddy || row.key === "internal";
    const account = isInternal ? "Internal" : displayFor(row.key);
    return {
      ...row.m,
      account,
      accountKey: isInternal ? "internal" : row.key,
      accountSlug: isInternal ? "internal" : slugifyAccount(account),
      hubspotCompanyId: isInternal ? null : (hsIdByKey.get(row.key) ?? null),
      isInternal,
    };
  });

  return { meetings, uncachedEvidence };
}

/** Group labeled meetings into per-account activity rows, most recent first.
 * Grouped by the STABLE accountKey (not the display string), so every spelling
 * of one company rolls up to a single account. */
export function accountRollup(meetings: LabeledMeeting[]): AccountRollup[] {
  const byKey = new Map<string, AccountRollup>();
  for (const m of meetings) {
    if (m.isInternal) continue;
    const row =
      byKey.get(m.accountKey) ??
      ({
        account: m.account,
        accountKey: m.accountKey,
        accountSlug: m.accountSlug,
        hubspotCompanyId: m.hubspotCompanyId,
        meetings: 0,
        lastMeetingAt: null,
        lastMeetingTitle: null,
        lastMeetingBotId: null,
      } as AccountRollup);
    row.meetings += 1;
    if (!row.lastMeetingAt || (m.started_at && m.started_at > row.lastMeetingAt)) {
      row.lastMeetingAt = m.started_at;
      row.lastMeetingTitle = m.title;
      row.lastMeetingBotId = m.bot_id;
    }
    if (!row.hubspotCompanyId && m.hubspotCompanyId) row.hubspotCompanyId = m.hubspotCompanyId;
    byKey.set(m.accountKey, row);
  }
  return [...byKey.values()].sort((a, b) =>
    (b.lastMeetingAt ?? "").localeCompare(a.lastMeetingAt ?? ""),
  );
}
