import crypto from "node:crypto";

// Mux client + signed-playback JWT minter.
//
// Two distinct credentials at play:
//   - MUX_TOKEN_ID / MUX_TOKEN_SECRET: API access token (Basic auth) used
//     to create assets and poll their state.
//   - MUX_SIGNING_KEY_ID / MUX_SIGNING_KEY_PRIVATE: separate RSA signing
//     key (kid + base64-encoded PEM) used to mint per-playback JWTs.
//     Created via POST /system/v1/signing-keys or the Mux dashboard.
//
// Storage model: every recorded meeting gets a Mux asset created from
// the Recall download URL (Mux pulls server-side). We use signed playback
// policy so leaked URLs expire after their token TTL — default 7 days
// for shared links.

const API_BASE = "https://api.mux.com";

function basicAuth(): string {
  const id = process.env.MUX_TOKEN_ID;
  const secret = process.env.MUX_TOKEN_SECRET;
  if (!id || !secret) throw new Error("MUX_TOKEN_ID / MUX_TOKEN_SECRET not set");
  return `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
}

type MuxAsset = {
  id: string;
  status: "preparing" | "ready" | "errored";
  playback_ids?: Array<{ id: string; policy: "public" | "signed" }>;
  errors?: { type?: string; messages?: string[] };
  duration?: number;
};

type MuxAssetResponse = { data: MuxAsset };

// Kick off asset ingest. Mux server-side fetches the URL — caller does
// not need to hold the bytes. The URL must be reachable from Mux's
// fetchers (i.e., not behind a per-request signed token that expires
// before Mux gets to it; in practice Recall download URLs work because
// they're valid for several hours).
export async function assetCreateFromUrl(opts: {
  url: string;
  passthrough?: string; // free-form metadata round-tripped on webhooks
}): Promise<MuxAsset> {
  const res = await fetch(`${API_BASE}/video/v1/assets`, {
    method: "POST",
    headers: {
      Authorization: basicAuth(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input: [{ url: opts.url }],
      playback_policies: ["signed"],
      // "smart" is Mux's default; "baseline" is cheaper but no AV1 / no
      // resolution ladder. Internal team meetings don't need smart.
      encoding_tier: "baseline",
      passthrough: opts.passthrough,
    }),
  });
  if (!res.ok) {
    throw new Error(`mux asset create -> ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as MuxAssetResponse;
  return body.data;
}

export async function getAsset(assetId: string): Promise<MuxAsset> {
  const res = await fetch(`${API_BASE}/video/v1/assets/${assetId}`, {
    headers: { Authorization: basicAuth() },
  });
  if (!res.ok) throw new Error(`mux get asset -> ${res.status} ${await res.text()}`);
  const body = (await res.json()) as MuxAssetResponse;
  return body.data;
}

// Poll until the asset is ready (encoded + a playback ID exists) or
// fails. Mux ingest from URL typically takes 30s-3min for a 30-min mp4.
// Returns the asset with playback_ids[0] populated.
export async function waitForAssetReady(
  assetId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<MuxAsset> {
  const timeoutMs = opts.timeoutMs ?? 8 * 60 * 1000;
  const intervalMs = opts.intervalMs ?? 5_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const asset = await getAsset(assetId);
    if (asset.status === "ready") return asset;
    if (asset.status === "errored") {
      throw new Error(
        `mux asset ${assetId} errored: ${JSON.stringify(asset.errors)}`,
      );
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`mux asset ${assetId} not ready within ${timeoutMs}ms`);
}

// Mint a signed playback JWT (RS256). Audience codes:
//   v - video / subtitles (HLS playback)
//   t - thumbnail
//   g - animated GIF
//   s - storyboard
// We sign with `aud: "v"` for the playback URL.
export function signPlaybackJwt(opts: {
  playbackId: string;
  ttlSeconds?: number;
  aud?: "v" | "t" | "g" | "s";
}): string {
  const kid = process.env.MUX_SIGNING_KEY_ID;
  const privateKeyB64 = process.env.MUX_SIGNING_KEY_PRIVATE;
  if (!kid || !privateKeyB64) {
    throw new Error("MUX_SIGNING_KEY_ID / MUX_SIGNING_KEY_PRIVATE not set");
  }
  const ttl = opts.ttlSeconds ?? 7 * 24 * 60 * 60;
  const aud = opts.aud ?? "v";
  const exp = Math.floor(Date.now() / 1000) + ttl;

  const header = { alg: "RS256", typ: "JWT", kid };
  const payload = { sub: opts.playbackId, aud, exp, kid };

  const headerB64 = base64url(Buffer.from(JSON.stringify(header)));
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  // Mux returns the private key as base64-encoded PEM. Decode once.
  const pem = Buffer.from(privateKeyB64, "base64").toString("utf8");
  const sig = crypto.sign("RSA-SHA256", Buffer.from(signingInput), {
    key: pem,
    padding: crypto.constants.RSA_PKCS1_PADDING,
  });
  return `${signingInput}.${base64url(sig)}`;
}

// Build the signed HLS playback URL. This is what we share into Slack.
// Anyone with the link can stream until the JWT expires; after that,
// Mux returns 403. Default TTL: 7 days.
export function signedPlaybackUrl(playbackId: string, ttlSeconds?: number): string {
  const token = signPlaybackJwt({ playbackId, ttlSeconds });
  return `https://stream.mux.com/${playbackId}.m3u8?token=${token}`;
}

// Player page URL — embeds the Mux web player. Better for "click and
// watch" scenarios because raw .m3u8 doesn't play in most browsers.
// Uses the same signed token as the HLS URL.
export function signedPlayerUrl(playbackId: string, ttlSeconds?: number): string {
  const token = signPlaybackJwt({ playbackId, ttlSeconds });
  return `https://player.mux.com/${playbackId}?token=${token}`;
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}
