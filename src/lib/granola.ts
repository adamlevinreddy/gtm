import crypto from "node:crypto";
import { kv } from "./kv-client";

// Per-user Granola MCP integration via OAuth 2.1 + PKCE + Dynamic Client
// Registration. Granola doesn't expose a service-account / API key for MCP,
// and Composio doesn't have a Granola toolkit — so we own the OAuth dance
// directly and store tokens in KV keyed by Slack email.
//
// Discovery confirmed via:
//   curl https://mcp.granola.ai/.well-known/oauth-authorization-server
//
// Scopes: "offline_access" is the critical one — it's how we get a
// refresh_token so users stay connected indefinitely.

const AUTH_BASE = "https://mcp-auth.granola.ai";
const AUTHORIZATION_ENDPOINT = `${AUTH_BASE}/oauth2/authorize`;
const TOKEN_ENDPOINT = `${AUTH_BASE}/oauth2/token`;
const REGISTRATION_ENDPOINT = `${AUTH_BASE}/oauth2/register`;
const MCP_URL = "https://mcp.granola.ai/mcp";
const SCOPES = "openid profile email offline_access";
const REDIRECT_PATH = "/api/oauth/granola/callback";

const CLIENT_KEY = "granola:oauth:client";
const stateKey = (state: string) => `granola:oauth:state:${state}`;
const tokenKey = (email: string) => `granola:user:${email}:tokens`;

type GranolaClient = {
  client_id: string;
  redirect_uri: string;
  registered_at: string;
};

export type GranolaTokens = {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number; // epoch seconds
  scope: string;
};

function redirectUri(origin: string): string {
  return `${origin}${REDIRECT_PATH}`;
}

// Register Reddy-GTM as an OAuth client with Granola's DCR endpoint.
// Public client (token_endpoint_auth_method=none) — we authenticate via
// PKCE code_verifier instead of a client_secret. Cached in KV forever;
// re-registers only if the deployment origin changes.
async function getOrRegisterClient(origin: string): Promise<GranolaClient> {
  const cached = await kv.get<GranolaClient>(CLIENT_KEY).catch(() => null);
  const want = redirectUri(origin);
  if (cached && cached.redirect_uri === want) return cached;

  const res = await fetch(REGISTRATION_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Reddy-GTM",
      redirect_uris: [want],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPES,
    }),
  });
  if (!res.ok) {
    throw new Error(`Granola DCR failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { client_id: string };
  const client: GranolaClient = {
    client_id: body.client_id,
    redirect_uri: want,
    registered_at: new Date().toISOString(),
  };
  await kv.set(CLIENT_KEY, client);
  return client;
}

function pkcePair() {
  const verifier = crypto.randomBytes(64).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// Build a Granola authorize URL for a specific Slack user. State token binds
// this flow to the email; the code_verifier survives the browser round-trip
// via KV so the callback can complete PKCE.
export async function beginAuthorize(email: string, origin: string): Promise<{ authUrl: string }> {
  const client = await getOrRegisterClient(origin);
  const state = crypto.randomBytes(32).toString("base64url");
  const { verifier, challenge } = pkcePair();

  await kv.set(stateKey(state), { email, codeVerifier: verifier }, { ex: 600 });

  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: client.redirect_uri,
    scope: SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return { authUrl: `${AUTHORIZATION_ENDPOINT}?${params.toString()}` };
}

// Finish the OAuth flow: exchange authorization code + PKCE verifier for
// access + refresh tokens, persist them against the original Slack email.
export async function completeAuthorize(
  state: string,
  code: string,
  origin: string,
): Promise<{ email: string; tokens: GranolaTokens }> {
  const stash = await kv.get<{ email: string; codeVerifier: string }>(stateKey(state));
  if (!stash) {
    throw new Error("Expired or unknown state — please start the connect flow again from Slack.");
  }
  await kv.del(stateKey(state));

  const client = await getOrRegisterClient(origin);
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: client.redirect_uri,
      client_id: client.client_id,
      code_verifier: stash.codeVerifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`Granola token exchange failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  const tokens: GranolaTokens = {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: Math.floor(Date.now() / 1000) + (body.expires_in ?? 3600),
    scope: body.scope ?? SCOPES,
  };
  await kv.set(tokenKey(stash.email), tokens);
  return { email: stash.email, tokens };
}

// Fetch the user's current Granola tokens, refreshing silently if the
// access token is within 60s of expiry. Returns null if the user has
// never connected OR if refresh fails (revoked / expired refresh token —
// they need to reconnect via set-me-up).
export async function getTokensForUser(
  email: string,
  origin: string,
): Promise<GranolaTokens | null> {
  const tokens = await kv.get<GranolaTokens>(tokenKey(email)).catch(() => null);
  if (!tokens) return null;

  const now = Math.floor(Date.now() / 1000);
  if (tokens.expiresAt - 60 > now) return tokens;
  if (!tokens.refreshToken) {
    // Access expired and no refresh_token — force a reconnect.
    await kv.del(tokenKey(email));
    return null;
  }

  const client = await getOrRegisterClient(origin);
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: client.client_id,
    }),
  });
  if (!res.ok) {
    console.warn(
      `[granola] refresh failed for ${email}: ${res.status} ${await res.text()}`,
    );
    await kv.del(tokenKey(email));
    return null;
  }
  const body = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };
  const refreshed: GranolaTokens = {
    accessToken: body.access_token,
    // Some IdPs rotate refresh tokens, some don't — keep the new one if
    // present, else reuse the existing one.
    refreshToken: body.refresh_token ?? tokens.refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + (body.expires_in ?? 3600),
    scope: body.scope ?? tokens.scope,
  };
  await kv.set(tokenKey(email), refreshed);
  return refreshed;
}

export async function isConnected(email: string): Promise<boolean> {
  const tokens = await kv.get<GranolaTokens>(tokenKey(email)).catch(() => null);
  return !!tokens;
}

export async function disconnect(email: string): Promise<void> {
  await kv.del(tokenKey(email));
}

// Shape the agent-driver expects for per-user MCP registration.
export function granolaMcpConfig(accessToken: string) {
  return {
    url: MCP_URL,
    headers: { Authorization: `Bearer ${accessToken}` },
  };
}

export const GRANOLA_REDIRECT_PATH = REDIRECT_PATH;
