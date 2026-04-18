# Composio setup — per-user external tool access

One-time setup to give every teammate per-user access to Gmail / Calendar / Drive / Sheets / Docs / HubSpot / LinkedIn / Apollo / DocuSign through Reddy-GTM. Each user OAuths once with `@Reddy-GTM set me up` and the agent then acts on their behalf.

## 1. Composio account

1. Sign up at https://app.composio.dev (Google SSO is fine).
2. Dashboard → **Settings → API Keys** → create a project API key. Save this — it goes in Vercel env as `COMPOSIO_API_KEY`.

## 2. Auth configs (one per toolkit)

For each toolkit you want to enable, dashboard → **Auth Configs → Create**. Pick the toolkit, use Composio's default OAuth client (fine for internal tooling — don't bother with "bring your own" branding). Save each returned `auth_config_id`; they go in Vercel env.

| Toolkit | Env var | Notes |
|---|---|---|
| Gmail | `COMPOSIO_AUTH_CONFIG_GMAIL` | |
| Google Calendar | `COMPOSIO_AUTH_CONFIG_GCAL` | |
| Google Drive | `COMPOSIO_AUTH_CONFIG_GDRIVE` | |
| Google Sheets | `COMPOSIO_AUTH_CONFIG_GSHEETS` | |
| Google Docs | `COMPOSIO_AUTH_CONFIG_GDOCS` | |
| HubSpot | `COMPOSIO_AUTH_CONFIG_HUBSPOT` | |
| LinkedIn | `COMPOSIO_AUTH_CONFIG_LINKEDIN` | Composio toolkit slug may be `linkedin` or `linkedin_sales_navigator` depending on product — pick the one matching the scopes you need |
| Apollo | `COMPOSIO_AUTH_CONFIG_APOLLO` | Only if your team has company-seat Apollo access |
| DocuSign | `COMPOSIO_AUTH_CONFIG_DOCUSIGN` | Only if your team uses DocuSign |

Missing env var → that toolkit is silently hidden from the `set me up` menu. You can enable Gmail today and add HubSpot next month without code changes.

## 3. MCP config (bundles the toolkits into one URL)

Dashboard → **MCP → Create**. Select all toolkits you want exposed to the agent (check every toolkit you created an auth config for in step 2). Name it `reddy-gtm-mcp`. Save the returned `mcp_config_id` → goes in Vercel env as `COMPOSIO_MCP_CONFIG_ID`.

This MCP config is shared across all users. Composio generates per-user URLs from it at runtime using the user's email as `user_id`.

## 4. Vercel env vars

In the `gtm` project:

```
COMPOSIO_API_KEY=<from step 1>
COMPOSIO_MCP_CONFIG_ID=<from step 3>
COMPOSIO_AUTH_CONFIG_GMAIL=<from step 2>
COMPOSIO_AUTH_CONFIG_GCAL=<from step 2>
COMPOSIO_AUTH_CONFIG_GDRIVE=<from step 2>
COMPOSIO_AUTH_CONFIG_GSHEETS=<from step 2>
COMPOSIO_AUTH_CONFIG_GDOCS=<from step 2>
COMPOSIO_AUTH_CONFIG_HUBSPOT=<from step 2>
COMPOSIO_AUTH_CONFIG_LINKEDIN=<from step 2>
COMPOSIO_AUTH_CONFIG_APOLLO=<from step 2>   # omit if you didn't create
COMPOSIO_AUTH_CONFIG_DOCUSIGN=<from step 2> # omit if you didn't create
```

Pull to local for dev: `vercel env pull .env.local --environment=development`.

## 5. Slack app: slash command (optional)

`@Reddy-GTM set me up` works in any channel / thread without extra Slack config (it rides the existing `app_mention` subscription). If you also want `/reddy-connect` as a slash command:

1. https://api.slack.com/apps → Reddy-GTM → **Slash Commands → Create New**
2. Command: `/reddy-connect`
3. Request URL: `https://gtm-jet.vercel.app/api/slack/commands/connect`
4. Short description: `Connect your Google/HubSpot/LinkedIn accounts to Reddy-GTM`
5. Usage hint: `(no args needed)`
6. Reinstall the app to pick up the new command.

## 6. Verify

1. In Slack, in any channel Reddy-GTM is in: `@Reddy-GTM set me up`
2. You should get a threaded reply with OAuth links grouped by category (Google Workspace / Work tools / Company accounts). Services you didn't configure in step 2 won't appear.
3. Click each link, go through the Google/HubSpot/etc. consent screen, land on Composio's success page.
4. Back in Slack: `@Reddy-GTM what's on my calendar tomorrow?` → should pull real events.

## How it works end-to-end

- **`@Reddy-GTM set me up`** → events handler resolves your Slack email → for every configured toolkit, calls `composio.connectedAccounts.initiate(your-email, auth_config_id)` → DMs you the OAuth URLs grouped by category.
- **You click a URL** → Composio's hosted consent flow → Google/HubSpot/etc. grants scopes → Composio stores refresh token under your email as `user_id`.
- **`@Reddy-GTM draft an email to Corey`** → `/api/agent` resolves Slack user → email → calls `composio.mcp.generate(email, mcp_config_id)` → passes the per-user URL + headers to the sandbox agent-driver → driver registers `composio` MCP alongside `reddy-gtm` MCP → Claude Agent SDK calls Gmail tools scoped to your token.
- **Reconnect**: Composio auto-refreshes OAuth tokens. If a connection fails (user revoked, 6-month inactivity, Google security event), the agent catches the tool error and prompts you to re-run `set me up`.

## Cost

For ~20 users at 1K–10K tool calls/month: **Free tier (20K/mo)** or **$29/mo (200K/mo)**. No per-user pricing.

## Troubleshooting

- **"No services are configured yet"**: no `COMPOSIO_AUTH_CONFIG_*` env vars are set in the runtime. Check `vercel env ls`.
- **Link errors out on Google's side**: the auth config's OAuth scopes may be too narrow for what the agent is trying to do. In Composio dashboard, edit the auth config → scopes → add what's needed (e.g., `gmail.modify` for drafting, not just `gmail.readonly`).
- **Agent says "you haven't connected X"**: `getConnectionStatus` returned `ACTIVE` for some toolkits but not X. Re-run `set me up`; the message only shows missing services.
