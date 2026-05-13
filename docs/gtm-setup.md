# GTM API setup — service account + Vercel env

One-time setup so Reddy-GTM can audit **and fix** the Tag Manager container for `reddy.io` (`GTM-5ZZPN9R2`).

Access model: a dedicated Google Cloud service account is the GTM "user" with Edit + Publish role on the container. Agent never touches live directly — it stages changes into a named workspace and creates a version; you review + publish in the GTM UI (or tell the agent to publish via an explicit signal).

## 1. Create the service account

1. Go to https://console.cloud.google.com → pick an existing project (e.g. the one already linked to GA4 / Google Ads) or create `reddy-gtm-audit`.
2. Top nav → **APIs & Services → Library** → search for **Tag Manager API** → **Enable**.
3. **IAM & Admin → Service Accounts → Create Service Account**.
   - Name: `reddy-gtm-agent`
   - Service account ID: `reddy-gtm-agent` (gets appended with `@<project>.iam.gserviceaccount.com`)
   - Role: leave empty (no GCP role needed — permissions happen in GTM itself)
   - Click **Done**.
4. On the service account row → **Actions (⋮) → Manage keys → Add Key → Create new key → JSON** → downloads a `.json` file. Keep it safe; this is the credential.

## 2. Grant the service account access to the GTM container

1. Go to https://tagmanager.google.com → select the `www.reddy.io` container (`GTM-5ZZPN9R2`).
2. **Admin** (top-right) → under the **Container** column → **User Management**.
3. **+ Add users** → paste the service account email (ends in `@<project>.iam.gserviceaccount.com`) → **Invite**.
4. Container permissions: pick **Publish** (includes Edit + Read; needed so the agent can create versions and you can publish or let the agent publish when signaled).
5. **Invite**. No email goes out — service accounts accept immediately.

## 3. Get the numeric GTM Account ID + Container ID

The GTM API uses numeric IDs, not the public `GTM-5ZZPN9R2` string.

1. Still in GTM → **Admin** → under **Account** column → **Account Settings** → note the **Account ID** (~10-digit number).
2. Under **Container** column → **Container Settings** → note the **Container ID** (numeric, ~10 digits, different from the public `GTM-5ZZPN9R2`).

## 4. Add env vars to Vercel

Three env vars on the `gtm` project, Production + Development:

```
GCP_SA_KEY_JSON=<minified single-line JSON content of the key file>
GTM_ACCOUNT_ID=<numeric account ID from step 3.1>
GTM_CONTAINER_ID=<numeric container ID from step 3.2>
```

To minify the JSON:

```bash
jq -c < ~/Downloads/reddy-gtm-agent-*.json | pbcopy   # macOS
```

Then in Vercel project settings, add as **Sensitive** (Vercel CLI: `vercel env add GCP_SA_KEY_JSON production --sensitive`).

**Critical**: the JSON key is god-mode for the GTM container. Delete the local file after pasting. Store it only as a Sensitive Vercel env.

## 5. Redeploy + verify

```bash
vercel --prod --yes
curl -sS https://gtm-jet.vercel.app/api/gtm/audit | jq '.container, .liveVersion.tagCount, .namedCTAs'
```

Expected output: container public_id = `GTM-5ZZPN9R2`, tagCount = 7 (per the docs), and the `namedCTAs` map showing which event-name tags currently exist in live.

## How the agent uses this

See `.claude/skills/gtm/SKILL.md` for the skill-level reference. In short:

- `GET /api/gtm/audit` — one-shot diagnostic with the findings we care about (named CTAs, conversion triggers, scroll config).
- `POST /api/gtm/exec` with `{op, args}` — read or write ops. Writes go to a workspace, never directly live.
- **Guardrail**: agent never calls `op: publishVersion` unless the user explicitly says "publish" or reacts 🚀 to confirm.
