// Meeting index + canonical account labels, rolled up for the home view.
// Same canon ladder as the meetings hub: derive a raw label per meeting,
// resolve DISTINCT labels through the KV-cached resolver (cache reads only
// on the render path; uncached labels warm in the background via after()).

import { recentMeetingIndex, deriveAccountLabel, type IndexedMeeting } from "@/lib/recall-index";
import { readCachedLabels, type LabelEvidence, type ResolvedCompany } from "@/lib/company-resolver";

// reddy.io is excluded as evidence: our own people attend every meeting, and
// Reddy exists as a HubSpot company — domain resolution used to hit OURSELVES
// before the customer's domain and label customer meetings "Reddy".
const FREE_DOMAINS = new Set(["gmail.com", "outlook.com", "hotmail.com", "yahoo.com", "icloud.com", "reddy.io"]);
export const INTERNAL_ACCOUNT_LABELS = new Set(["Internal", "Reddy"]);

export type LabeledMeeting = IndexedMeeting & {
  account: string;
  hubspotCompanyId: string | null;
  isInternal: boolean;
};

export type AccountRollup = {
  account: string;
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

  const meetings = raw.map((m) => {
    const rawLabel = rawByBot.get(m.bot_id) ?? "Internal";
    const r = resolved.get(rawLabel);
    const account = r?.canonical ?? rawLabel;
    return {
      ...m,
      account,
      hubspotCompanyId: r?.hubspotCompanyId ?? null,
      isInternal: INTERNAL_ACCOUNT_LABELS.has(account),
    };
  });

  return { meetings, uncachedEvidence };
}

/** Group labeled meetings into per-account activity rows, most recent first. */
export function accountRollup(meetings: LabeledMeeting[]): AccountRollup[] {
  const byAccount = new Map<string, AccountRollup>();
  for (const m of meetings) {
    if (m.isInternal) continue;
    const row =
      byAccount.get(m.account) ??
      ({
        account: m.account,
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
    byAccount.set(m.account, row);
  }
  return [...byAccount.values()].sort((a, b) =>
    (b.lastMeetingAt ?? "").localeCompare(a.lastMeetingAt ?? ""),
  );
}
