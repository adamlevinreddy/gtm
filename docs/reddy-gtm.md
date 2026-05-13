# Reddy-GTM — Claude Code in Slack for Reddy's go-to-market

Reddy-GTM is a Slack-native Claude Code agent. Mention `@Reddy-GTM` in any channel it's invited to and it spins up a persistent Vercel Sandbox running Claude Code with Reddy-specific skills (pricing, decks, legal, and more over time). The agent infers intent from the message — you don't need command keywords.

## UX

- **Invocation**: `@Reddy-GTM build a pricing proposal for Vistra, 250 agents, BYOT, 2-year, Tapestry-style layout`
- **Or just talk**: `@Reddy-GTM what's a fair rate for a 500-agent BYOT deal?` or `@Reddy-GTM make me a QBR deck for Grubhub`
- **Iterate in-thread**: after the bot replies, any follow-up mention in the same thread continues the same session — no re-specifying context.
- **30-min idle lifecycle**: the sandbox stays warm as long as you're actively chatting (each mention resets a 30-min idle timer). After 30 min of silence, the sandbox stops and auto-snapshots its filesystem. Your next mention in the thread resumes from that snapshot within seconds.
- **Clarifying questions**: when intent is ambiguous ("thinking about Acme pricing"), the bot asks ONE clarifying question before committing to a path.

## Architecture

| Component | What it does |
|---|---|
| `src/app/api/slack/events/route.ts` | Slack event receiver. When `REDDY_GTM_ENGINE=agent-sdk`, routes ALL app_mentions to `/api/agent`. |
| `src/app/api/agent/route.ts` | Gets/creates a persistent Vercel Sandbox named `reddy-gtm-{thread_ts}`. Writes a turn inbox + driver script. Runs driver detached. Returns 200. |
| `src/lib/agent-driver.ts` | Generates the driver script (`agent-driver.mjs`) that runs inside the sandbox. Uses `@anthropic-ai/claude-agent-sdk`'s `query()` with Claude Code preset + Reddy-GTM append prompt + in-process MCP server for Slack tools. Session persistence via stable UUID per Slack thread. |
| Library repo: `ReddySolutions/pricing` | The workspace. Cloned into the sandbox at `/vercel/sandbox/workspace`. Contains `.claude/skills/` (pricing, decks, legal, react-pdf), `design-system/` (fonts, tokens, guide), and `Brand Pricing/` (15 existing proposals). |
| MCP tools (in-process) | `post_slack_message`, `upload_slack_pdf`, `fetch_url`. Everything else is Claude Code built-ins (Read/Write/Edit/Bash/Glob/Grep/WebFetch/TodoWrite/Task). |

## Skills

Loaded automatically via `settingSources: ["project"]` on `query()`. The agent reads each `SKILL.md` when its description matches the user's intent.

| Skill | Triggers on | What it does |
|---|---|---|
| `pricing` | pricing, proposal, rate, quote, customer name + agent count | Research OR build. Cites precedent from `PRICING_PATTERNS.md`. Produces PDF via React-PDF. Commits back to library on success. |
| `decks` | QBR, board update, slides, deck, presentation | 16:9 landscape PDF slides. Uses `design-system/` tokens (FlechaS + Inter, plum palette). Reference: `qbr-example.tsx` (Grubhub QBR, 843 lines). |
| `legal` | MSA, DPA, SOW, redline, contract, liability, publicity | Extracts tracked changes from docx. Compares to Reddy's executed precedent library. Prioritized pushback list (🔴 / 🟡 / 🟢). |
| `react-pdf` | (meta — loaded when any skill needs PDF API reference) | Local copy of the react-pdf skill. Font registration, API reference, common patterns. |

## Env vars

| Var | Set where | Purpose |
|---|---|---|
| `REDDY_GTM_ENGINE` | Vercel production (or `.env`) | `agent-sdk` → route mentions to `/api/agent`. Unset (or `legacy`) → fall back to keyword routing. |
| `AI_GATEWAY_API_KEY` | Vercel production | Anthropic auth via Vercel AI Gateway. Passed into sandbox as `ANTHROPIC_AUTH_TOKEN`. |
| `PRICING_LIBRARY_GITHUB_PAT` | Vercel production | Sandbox clones `ReddySolutions/pricing` via this PAT + pushes new proposals back. |
| `REDDY_KV_REST_API_URL` / `REDDY_KV_REST_API_TOKEN` | Vercel production | KV storage for thread state + TRACE firehose. |
| `SLACK_BOT_TOKEN` | Vercel production | Slack Web API auth. |

## Bot display name

The `@Reddy-GTM` mention name is set in the Slack app's **App Home** configuration at https://api.slack.com/apps/{app_id}. Change "Display name" and "Default username" there — this file's help text already uses `@Reddy-GTM`.

## Debugging

The `scripts/debug-pricing.mjs` harness continues to work — it posts directly to `/api/pricing` (legacy) or `/api/agent` (new). For the new engine, bypass Slack with:

```bash
# Pull dev env vars
vercel env pull .env.local --environment=development
set -a && source .env.local && set +a

# Hit the new agent route directly
curl -sS -X POST https://gtm-jet.vercel.app/api/agent \
  -H "Content-Type: application/json" \
  -d '{"userText": "Test build for Acme, 500 agents, BYOT, 2-year", "slackChannel": "C0APM9JLAFN", "slackThreadTs": "debug-test-1"}'
```

Every turn persists a full TRACE to KV under `reddy-gtm:thread:{thread_ts}:trace:{turn}`. Inspect via Upstash console → Data Browser.

## Migration plan (branch: migrate-to-agent-sdk)

1. ✅ Install `@anthropic-ai/claude-agent-sdk` (`2.113`)
2. ✅ Scaffold `/api/agent` + `src/lib/agent-driver.ts`
3. ✅ Library: `.claude/skills/` (pricing, decks, legal, react-pdf) + `design-system/`
4. ⏳ Feature-flag in `/api/slack/events` — `REDDY_GTM_ENGINE=agent-sdk` switches engines
5. 🔄 Test end-to-end against all three skills
6. 🔄 Flip default, delete legacy

## Future skills (roadmap)

- **marketing-list** — dedupe/enrich target-account CSVs via Apollo + HubSpot
- **competitive-research** — one-pager on a competitor via WebFetch + library context
- **battle-card** — per-competitor sales battle cards with objection handling
- **customer-insight** — Granola + HubSpot + Gong summary per account

Each new skill is just a `.claude/skills/{name}/SKILL.md` added to the library repo — no driver or dispatch changes needed.
