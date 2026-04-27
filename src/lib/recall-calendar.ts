// Per-user Recall.ai Calendar V1 onboarding helpers.
//
// The flow is:
//   1. Mint a per-user JWT via POST /calendar/authenticate/ (workspace
//      API key auth). The JWT identifies the calendar user by external_id
//      (we use Slack email).
//   2. Build a Google OAuth URL using OUR Google OAuth client (configured
//      once in Google Cloud Console + saved into Recall). The `state`
//      param carries the JWT, our redirect_uri, and success/error URLs
//      back to our app.
//   3. Google → user consent → redirects to OUR /api/oauth/recall-calendar/
//      callback with code + state.
//   4. Our callback 302s the entire request (all query params) to Recall's
//      /calendar/google_oauth_callback/. Recall exchanges the code,
//      stores Google tokens against the calendar user keyed by the JWT,
//      then redirects the user to the success_url we passed in state.
//   5. Our success endpoint applies our standard recording preferences
//      (record_external / record_internal / record_confirmed = true,
//      bot_name = "Reddy Notetaker") via PUT /calendar/user/ using the
//      JWT we received in the success_url query.
//
// The workspace-level Bot Config (deepgram_streaming etc.) is already
// applied to every calendar-spawned bot — no per-user knob needed.

const REGION = process.env.RECALL_REGION ?? "us-west-2";
const RECALL_BASE = `https://${REGION}.recall.ai/api/v1`;

const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events.readonly",
  "https://www.googleapis.com/auth/userinfo.email",
];

// Our default Recall recording preferences — what we configured for Adam
// after iterating through the testing flow. Same defaults applied to
// every teammate going forward.
export const DEFAULT_PREFERENCES = {
  record_non_host: false,
  record_recurring: false,
  record_external: true,
  record_internal: true,
  record_confirmed: true,
  record_only_host: false,
  bot_name: "Reddy Notetaker",
} as const;

export type RecallCalendarStateBlob = {
  recall_calendar_auth_token: string;
  google_oauth_redirect_url: string;
  success_url: string;
  error_url: string;
};

// Mint a per-user calendar auth JWT. external_id should be the user's
// canonical identifier in our system — we use the Slack email.
export async function mintCalendarAuthToken(externalId: string): Promise<string> {
  const apiKey = process.env.RECALL_API_KEY;
  if (!apiKey) throw new Error("RECALL_API_KEY not set");
  const res = await fetch(`${RECALL_BASE}/calendar/authenticate/`, {
    method: "POST",
    headers: {
      Authorization: `Token ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ user_id: externalId }),
  });
  if (!res.ok) {
    throw new Error(`Recall calendar/authenticate -> ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { token: string };
  return body.token;
}

// Build the Google OAuth URL the user gets redirected to. The state
// blob is what makes Recall's /google_oauth_callback know which calendar
// user to attach the granted Google tokens to and where to send the
// user when finished.
export function buildGoogleOAuthUrl(args: {
  clientId: string;
  redirectUri: string;
  jwt: string;
  successUrl: string;
  errorUrl: string;
}): string {
  const state: RecallCalendarStateBlob = {
    recall_calendar_auth_token: args.jwt,
    google_oauth_redirect_url: args.redirectUri,
    success_url: args.successUrl,
    error_url: args.errorUrl,
  };
  const params = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES.join(" "),
    state: JSON.stringify(state),
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

// Apply the team-default recording preferences to a freshly-connected
// calendar user. Idempotent — safe to re-call.
export async function applyDefaultPreferences(jwt: string, externalId: string): Promise<void> {
  const res = await fetch(`${RECALL_BASE}/calendar/user/`, {
    method: "PUT",
    headers: {
      "x-recallcalendarauthtoken": jwt,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      external_id: externalId,
      preferences: DEFAULT_PREFERENCES,
    }),
  });
  if (!res.ok) {
    throw new Error(`Recall PUT calendar/user -> ${res.status} ${await res.text()}`);
  }
}

export const RECALL_GOOGLE_OAUTH_CALLBACK = `${RECALL_BASE}/calendar/google_oauth_callback/`;
