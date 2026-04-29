// Recall Calendar V2 helpers.
//
// Migration model from V1: we own the Google OAuth flow end-to-end now
// (V1 had Recall do the token exchange). After consent we:
//   1. Exchange the Google auth code for a refresh_token
//   2. Look up the user's Google email
//   3. POST /api/v2/calendars/ with our Google client_id/secret + the
//      refresh_token to register the calendar with Recall
//   4. Stash {email -> calendar_id} in KV so future webhooks can be
//      attributed back to a teammate
//
// Bot scheduling is no longer automatic — we receive `calendar.sync_events`
// webhooks, list events updated since the cursor, and POST a bot to
// /api/v2/calendar-events/{id}/bot/ for each external meeting.

import { kv } from "@/lib/kv-client";

const REGION = process.env.RECALL_REGION ?? "us-west-2";
const RECALL_BASE = `https://${REGION}.recall.ai/api/v2`;

const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

// Bot config applied to every meeting we record — same shape we see on
// existing V1-scheduled bots (deepgram nova-3, speaker view, etc.) plus
// realtime_endpoints so we get per-utterance webhooks during the call.
function buildDefaultBotConfig() {
  const baseUrl = process.env.PUBLIC_BASE_URL ?? "https://gtm-jet.vercel.app";
  const realtimeToken = process.env.RECALL_REALTIME_WEBHOOK_TOKEN;
  // Subscribe to BOTH the finalized and partial transcript events.
  // transcript.data fires only when deepgram finalizes a chunk (often
  // not until a long silence or meeting end), so for live "what was
  // just said" queries we also need transcript.partial_data, which
  // streams in-progress words as they arrive.
  const realtimeEndpoints = realtimeToken
    ? [
        {
          type: "webhook" as const,
          url: `${baseUrl}/api/webhooks/recall/realtime?token=${encodeURIComponent(realtimeToken)}`,
          events: ["transcript.data", "transcript.partial_data"],
        },
      ]
    : [];
  return {
    bot_name: "Reddy Notetaker",
    recording_config: {
      transcript: {
        provider: {
          deepgram_streaming: {
            model: "nova-3",
            language: "en",
            punctuate: true,
            diarize: true,
            smart_format: true,
            // Required for transcript.partial_data events to fire.
            // Without it, Deepgram only emits finals — which for short
            // utterances often don't land until end of meeting, so the
            // realtime buffer stays empty during the call.
            interim_results: true,
          },
        },
      },
      video_mixed_layout: "speaker_view",
      video_mixed_mp4: {},
      participant_events: {},
      meeting_metadata: {},
      video_mixed_participant_video_when_screenshare: "overlap",
      start_recording_on: "participant_join",
      retention: { type: "forever" },
      realtime_endpoints: realtimeEndpoints,
    },
  };
}

function authHeader(): string {
  const key = process.env.RECALL_API_KEY?.trim();
  if (!key) throw new Error("RECALL_API_KEY not set");
  return `Token ${key}`;
}

// ────────── KV mappings ──────────

export const kvKeyEmailToCalendar = (email: string) => `recall:cal:user:${email.toLowerCase()}:calendar_id`;
export const kvKeyCalendarToEmail = (calendarId: string) => `recall:cal:calendar:${calendarId}:user_email`;
export const kvKeyEventBot = (calendarId: string, eventId: string) => `recall:cal:event:${calendarId}:${eventId}:bot`;

// ────────── Google OAuth ──────────

export function buildGoogleOAuthUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES.join(" "),
    state: opts.state,
    include_granted_scopes: "true",
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

export async function exchangeGoogleCode(opts: {
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}): Promise<{ refreshToken: string; accessToken: string }> {
  const body = new URLSearchParams({
    code: opts.code,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    redirect_uri: opts.redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`google token exchange -> ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { refresh_token?: string; access_token?: string };
  if (!json.refresh_token) {
    // First-time OAuth without prompt=consent OR an account that already
    // granted scopes won't return refresh_token. We force prompt=consent
    // in the URL so this should be rare; if it happens, surface clearly.
    throw new Error("google token exchange returned no refresh_token (re-consent required)");
  }
  return { refreshToken: json.refresh_token, accessToken: json.access_token ?? "" };
}

export async function getGoogleUserEmail(accessToken: string): Promise<string | null> {
  const res = await fetch(GOOGLE_USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { email?: string };
  return json.email ?? null;
}

// ────────── Recall V2 API ──────────

export async function createRecallCalendar(opts: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<{ id: string }> {
  const res = await fetch(`${RECALL_BASE}/calendars/`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      oauth_client_id: opts.clientId,
      oauth_client_secret: opts.clientSecret,
      oauth_refresh_token: opts.refreshToken,
      platform: "google_calendar",
    }),
  });
  if (!res.ok) {
    throw new Error(`recall create calendar -> ${res.status} ${await res.text()}`);
  }
  const json = (await res.json()) as { id: string };
  return { id: json.id };
}

export async function disconnectRecallCalendar(calendarId: string): Promise<void> {
  const res = await fetch(`${RECALL_BASE}/calendars/${calendarId}/`, {
    method: "DELETE",
    headers: { Authorization: authHeader() },
  });
  // Tolerate 404 — calendar may already be deleted.
  if (!res.ok && res.status !== 404) {
    throw new Error(`recall delete calendar ${calendarId} -> ${res.status} ${await res.text()}`);
  }
}

export type CalendarEventAttendee = {
  email?: string;
  organizer?: boolean;
  responseStatus?: string;
};

export type CalendarEvent = {
  id: string;
  start_time?: string;
  end_time?: string;
  meeting_url?: string | null;
  is_deleted?: boolean;
  ical_uid?: string;
  raw?: {
    summary?: string;
    attendees?: CalendarEventAttendee[];
    organizer?: { email?: string };
    status?: string;
    recurringEventId?: string;
  };
};

// List calendar events updated since the cursor. Paginates via the
// returned `next` URL (full URL — we follow as-is per Recall's docs).
export async function listCalendarEventsSince(opts: {
  calendarId: string;
  updatedAtGte: string;
}): Promise<CalendarEvent[]> {
  const params = new URLSearchParams({
    calendar_id: opts.calendarId,
    updated_at__gte: opts.updatedAtGte,
  });
  let url: string | null = `${RECALL_BASE}/calendar-events/?${params.toString()}`;
  const events: CalendarEvent[] = [];
  while (url) {
    const res = await fetch(url, { headers: { Authorization: authHeader() } });
    if (!res.ok) {
      throw new Error(`recall list calendar events -> ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { results?: CalendarEvent[]; next?: string | null };
    if (Array.isArray(body.results)) events.push(...body.results);
    url = body.next ?? null;
  }
  return events;
}

// Decide whether we should record this calendar event. Same rules we
// applied as V1 prefs: external meeting (someone outside Reddy domains),
// not deleted, has a meeting_url, not declined by the connected user.
const REDDY_DOMAINS = new Set(["reddy.io", "reddy.ai"]);

export function shouldRecordEvent(event: CalendarEvent, connectedEmail: string): boolean {
  if (event.is_deleted) return false;
  if (!event.meeting_url) return false;
  const status = event.raw?.status;
  if (status === "cancelled") return false;
  const attendees = event.raw?.attendees ?? [];
  // The connected user is on the invite — check they didn't decline.
  const me = attendees.find((a) => (a.email ?? "").toLowerCase() === connectedEmail.toLowerCase());
  if (me?.responseStatus === "declined") return false;
  // External-meeting check: at least one attendee outside Reddy.
  const hasExternal = attendees.some((a) => {
    const domain = (a.email ?? "").split("@")[1]?.toLowerCase() ?? "";
    return domain && !REDDY_DOMAINS.has(domain);
  });
  return hasExternal;
}

// Schedule (or reschedule via dedup key) a bot for a calendar event.
// Returns the bot ID surfaced in the response, if any.
export async function scheduleBotForEvent(opts: {
  eventId: string;
  deduplicationKey: string;
}): Promise<{ botId: string | null }> {
  const res = await fetch(`${RECALL_BASE}/calendar-events/${opts.eventId}/bot/`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      deduplication_key: opts.deduplicationKey,
      bot_config: buildDefaultBotConfig(),
    }),
  });
  if (!res.ok) {
    throw new Error(`recall schedule bot for event ${opts.eventId} -> ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { bots?: Array<{ bot_id?: string; id?: string }> };
  const botId = body.bots?.[body.bots.length - 1]?.bot_id ?? body.bots?.[body.bots.length - 1]?.id ?? null;
  return { botId };
}

export async function deleteBotForEvent(eventId: string): Promise<void> {
  const res = await fetch(`${RECALL_BASE}/calendar-events/${eventId}/bot/`, {
    method: "DELETE",
    headers: { Authorization: authHeader() },
  });
  if (!res.ok && res.status !== 404) {
    throw new Error(`recall delete bot for event ${eventId} -> ${res.status} ${await res.text()}`);
  }
}

// ────────── KV helpers (typed wrappers) ──────────

export async function kvLinkCalendarToEmail(calendarId: string, email: string): Promise<void> {
  await Promise.all([
    kv.set(kvKeyEmailToCalendar(email), calendarId).catch(() => {}),
    kv.set(kvKeyCalendarToEmail(calendarId), email.toLowerCase()).catch(() => {}),
  ]);
}

export async function kvLookupEmailForCalendar(calendarId: string): Promise<string | null> {
  return (await kv.get<string>(kvKeyCalendarToEmail(calendarId)).catch(() => null)) ?? null;
}

export async function kvLookupCalendarForEmail(email: string): Promise<string | null> {
  return (await kv.get<string>(kvKeyEmailToCalendar(email)).catch(() => null)) ?? null;
}
