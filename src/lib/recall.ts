import crypto from "node:crypto";

// Recall.ai client + customer attribution helpers.
//
// Bots are scheduled automatically by Recall via calendar integration.
// Reddy-GTM hooks into Recall via webhooks (signature-verified) and
// persists transcripts to Postgres on `transcript.done`. Video download
// URLs are short-lived and not stored — fetched fresh from Recall on
// demand via /api/recall/video/[botId].

const REGION = process.env.RECALL_REGION ?? "us-west-2";
const BASE = `https://${REGION}.recall.ai/api/v1`;
const API_KEY = () => process.env.RECALL_API_KEY ?? "";

function authHeader(): string {
  const key = API_KEY();
  if (!key) throw new Error("RECALL_API_KEY not set");
  return `Token ${key}`;
}

// ────────── Types ──────────

export type RecallParticipant = {
  id?: number | string;
  name?: string;
  email?: string;
  is_host?: boolean;
};

export type RecallMediaShortcut = {
  status?: { code?: string };
  data?: { download_url?: string; download_url_expires_at?: string };
};

export type RecallBot = {
  id: string;
  bot_name?: string;
  meeting_url?: { meeting_id?: string; platform?: string } | string;
  join_at?: string;
  status?: string;
  meeting_metadata?: { title?: string; participants?: RecallParticipant[] };
  recordings?: Array<{
    id?: string;
    started_at?: string;
    completed_at?: string;
    media_shortcuts?: {
      video_mixed?: RecallMediaShortcut;
      transcript?: RecallMediaShortcut;
      audio_mixed?: RecallMediaShortcut;
    };
  }>;
};

export type RecallTranscriptSegment = {
  participant?: { name?: string; email?: string };
  words?: Array<{ text?: string; start_timestamp?: { relative?: number } }>;
  speaker?: string;
  text?: string;
  start?: number;
  end?: number;
};

export type AttributionResult = {
  accountId: string | null;
  hubspotCompanyId: string | null;
  companyName: string | null;
  confidence: "high" | "medium" | "low" | "none";
  matchedDomains: string[];
};

// ────────── HTTP helpers ──────────

async function recallGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: authHeader(), Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Recall GET ${path} -> ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchBot(botId: string): Promise<RecallBot> {
  return recallGet<RecallBot>(`/bot/${botId}/`);
}

// Pull recently-completed bots. Used for the agent's "what were my recent
// meetings" queries when joined with Postgres transcripts.
export async function listDoneBots(opts: {
  joinAtAfter?: string;
  joinAtBefore?: string;
  limit?: number;
}): Promise<RecallBot[]> {
  const params = new URLSearchParams();
  for (const s of ["done", "recording_done", "analysis_done"]) {
    params.append("status", s);
  }
  if (opts.joinAtAfter) params.set("join_at_after", opts.joinAtAfter);
  if (opts.joinAtBefore) params.set("join_at_before", opts.joinAtBefore);
  params.set("use_cursor", "true");

  const res = await recallGet<{ results?: RecallBot[]; next?: string | null }>(
    `/bot/?${params.toString()}`,
  );
  const items = res.results ?? [];
  if (!opts.limit) return items;
  return items.slice(0, opts.limit);
}

// Pull the transcript artifact for a bot. The transcript download_url points
// to a JSON document of segments — schema varies by provider, so we return
// the raw JSON and let the caller normalize.
export async function fetchTranscript(botId: string): Promise<{
  segments: RecallTranscriptSegment[];
  raw: unknown;
}> {
  const bot = await fetchBot(botId);
  const url = bot.recordings?.[0]?.media_shortcuts?.transcript?.data?.download_url;
  if (!url) {
    return { segments: [], raw: null };
  }
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`transcript fetch ${botId} -> ${res.status} ${await res.text()}`);
  }
  const raw = await res.json();
  // Normalize: Recall transcript JSON is typically an array of segments OR
  // an object with `transcript: [...]`. Coerce to a flat array.
  const segments = Array.isArray(raw)
    ? (raw as RecallTranscriptSegment[])
    : Array.isArray((raw as { transcript?: unknown }).transcript)
      ? ((raw as { transcript: RecallTranscriptSegment[] }).transcript)
      : [];
  return { segments, raw };
}

// Render a transcript as plain text "Speaker: line" form for storage in
// Postgres `meetings.transcript`. Stable across the various provider
// formats Recall supports.
export function transcriptToText(segments: RecallTranscriptSegment[]): string {
  return segments
    .map((s) => {
      const speaker =
        s.participant?.name ||
        s.participant?.email ||
        s.speaker ||
        "Unknown";
      const text =
        s.text ??
        (Array.isArray(s.words)
          ? s.words.map((w) => w.text ?? "").join(" ").trim()
          : "");
      if (!text) return "";
      return `${speaker}: ${text}`;
    })
    .filter(Boolean)
    .join("\n");
}

// Fetch a fresh signed video download URL for a completed bot. Recall's
// download URLs expire (~hours), so we never persist them — agent calls
// this just-in-time when it needs to share a video.
export async function freshVideoUrl(botId: string): Promise<{
  url: string | null;
  expiresAt: string | null;
}> {
  const bot = await fetchBot(botId);
  const v = bot.recordings?.[0]?.media_shortcuts?.video_mixed?.data;
  return {
    url: v?.download_url ?? null,
    expiresAt: v?.download_url_expires_at ?? null,
  };
}

// ────────── Webhook signature verification ──────────

// Recall signs webhooks with HMAC-SHA256 using a shared secret configured
// per webhook endpoint. The signature is sent in `Svix-Signature` (Recall
// uses Svix for delivery) — multiple signatures may be present in a
// space-separated list, formatted as `v1,<base64>`. We compute the
// expected signature from `<svix_id>.<svix_timestamp>.<rawBody>` and
// timing-safe compare. Reject if no provided signature matches.
export function verifyWebhookSignature(
  rawBody: string,
  headers: Record<string, string | null>,
  secret: string,
): boolean {
  const id = headers["svix-id"] ?? headers["webhook-id"];
  const ts = headers["svix-timestamp"] ?? headers["webhook-timestamp"];
  const sigHeader =
    headers["svix-signature"] ?? headers["webhook-signature"] ?? "";
  if (!id || !ts || !sigHeader || !secret) return false;

  // Strip the "whsec_" prefix from the secret if present.
  const secretBytes = secret.startsWith("whsec_")
    ? Buffer.from(secret.slice("whsec_".length), "base64")
    : Buffer.from(secret, "utf8");

  const toSign = `${id}.${ts}.${rawBody}`;
  const expected = crypto
    .createHmac("sha256", secretBytes)
    .update(toSign)
    .digest("base64");

  // Header may contain multiple signatures separated by spaces; each is "v1,<sig>"
  const candidates = sigHeader
    .split(" ")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => (s.startsWith("v1,") ? s.slice(3) : s));

  return candidates.some((cand) => {
    const a = Buffer.from(cand);
    const b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  });
}

// ────────── Customer attribution ──────────

// Internal email domains we should ignore when picking the customer.
const INTERNAL_DOMAINS = new Set([
  "reddy.io",
  "reddy.ai",
  "gmail.com",
  "googlemail.com",
]);

function externalDomains(participants: RecallParticipant[]): string[] {
  const seen = new Set<string>();
  for (const p of participants ?? []) {
    const email = (p.email ?? "").toLowerCase().trim();
    if (!email || !email.includes("@")) continue;
    const domain = email.split("@")[1];
    if (!domain) continue;
    if (INTERNAL_DOMAINS.has(domain)) continue;
    seen.add(domain);
  }
  return [...seen];
}

// Resolve attendee email domains to a single HubSpot company. Strategy:
// gather external domains (skip Reddy + free providers), search HubSpot
// for each, and pick the company with the most attendee matches.
//
// Confidence:
//   - high: exactly one external domain → exactly one HubSpot match
//   - medium: one HubSpot company dominates among multiple matches
//   - low: matches found but tied / weak
//   - none: no domain matches at all
//
// Returns nullable accountId + the HubSpot company ID (caller decides
// whether to upsert into accounts table).
export async function attributeCustomer(
  participants: RecallParticipant[],
): Promise<AttributionResult> {
  const domains = externalDomains(participants);
  if (domains.length === 0) {
    return { accountId: null, hubspotCompanyId: null, companyName: null, confidence: "none", matchedDomains: [] };
  }
  const apiKey = process.env.HUBSPOT_API_KEY;
  if (!apiKey) {
    return { accountId: null, hubspotCompanyId: null, companyName: null, confidence: "none", matchedDomains: domains };
  }

  // Score companies by number of matched domains.
  const counts: Record<string, { count: number; name: string }> = {};
  const matched: string[] = [];

  for (const d of domains) {
    try {
      const res = await fetch("https://api.hubapi.com/crm/v3/objects/companies/search", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          filterGroups: [
            { filters: [{ propertyName: "domain", operator: "EQ", value: d }] },
          ],
          properties: ["name", "domain"],
          limit: 1,
        }),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as {
        results?: Array<{ id: string; properties: { name?: string; domain?: string } }>;
      };
      const hit = body.results?.[0];
      if (!hit) continue;
      matched.push(d);
      const id = hit.id;
      counts[id] = counts[id] ?? { count: 0, name: hit.properties.name ?? d };
      counts[id].count += 1;
    } catch {
      // Tolerate transient errors — attribution is best-effort.
    }
  }

  const ranked = Object.entries(counts).sort((a, b) => b[1].count - a[1].count);
  if (ranked.length === 0) {
    return { accountId: null, hubspotCompanyId: null, companyName: null, confidence: "none", matchedDomains: domains };
  }
  const [topId, top] = ranked[0];
  const dominant = ranked.length === 1 || top.count > (ranked[1]?.[1].count ?? 0);

  let confidence: AttributionResult["confidence"];
  if (domains.length === 1 && ranked.length === 1) confidence = "high";
  else if (dominant) confidence = "medium";
  else confidence = "low";

  return {
    accountId: null, // Caller may upsert into accounts and fill this in.
    hubspotCompanyId: topId,
    companyName: top.name,
    confidence,
    matchedDomains: matched,
  };
}
