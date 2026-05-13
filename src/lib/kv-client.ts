import { createClient } from "@vercel/kv";

const url = process.env.REDDY_KV_REST_API_URL;
const token = process.env.REDDY_KV_REST_API_TOKEN;

if (!url || !token) {
  throw new Error(
    "REDDY_KV_REST_API_URL and REDDY_KV_REST_API_TOKEN must be set (Upstash store: reddy-gtm-kv-v2)"
  );
}

export const kv = createClient({ url, token });
