# Company Classification System — Design Spec

> Reddy GTM | March 2026
> Status: Approved for implementation (v2 — Vercel-native)

---

## Purpose

Build an always-available company classification system deployed on Vercel that the team communicates with via Slack. It automatically filters vendors/competitors and tags BPO/Media companies from any incoming prospect list, uses a Claude agent to classify unknowns, and requires human review before updating the database.

## Goals

1. Always available — webhooks from Common Room, Apollo, HubSpot hit the system 24/7
2. Slack is the primary interface — send lists, receive results, review classifications
3. Claude Agent SDK (Opus 1M) runs in Vercel Sandbox for multi-step classification
4. All requests route through Vercel AI Gateway for observability and token tracking
5. Human-confirmed decisions are committed to the GitHub repo automatically
6. Anyone on the team can contribute to the exclusion/tag lists via PR

## Non-Goals

- Persona classification (L&D / QA / Ops) or prioritization — downstream step
- Outreach or CRM updates — this only classifies
- No local scripts or CLI tools — everything lives on Vercel

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         INPUTS                               │
│                                                              │
│  Slack message     Common Room      Manual upload            │
│  (file + prompt)   webhook          (review UI)              │
│       │                │                  │                   │
└───────┼────────────────┼──────────────────┼─────────────────┘
        │                │                  │
        ▼                ▼                  ▼
┌─────────────────────────────────────────────────────────────┐
│              NEXT.JS APP (Vercel)                             │
│              reddy-gtm-tools.vercel.app                      │
│                                                              │
│  API Routes:                                                 │
│  ├── POST /api/slack/events     ← Slack Bolt receiver        │
│  ├── POST /api/webhook/[source] ← Common Room, Apollo, etc.  │
│  ├── POST /api/classify         ← Direct API trigger          │
│  ├── GET  /review/[id]          ← Review UI page              │
│  ├── POST /api/review/[id]/submit  ← Save decisions          │
│  └── POST /api/review/[id]/commit  ← Trigger Phase 2         │
│                                                              │
│  Shared Logic:                                               │
│  ├── lib/classifier.ts          ← Known matching (fuzzy)     │
│  ├── lib/github.ts              ← Octokit: read/write JSON   │
│  └── lib/slack.ts               ← Slack messaging            │
└──────────┬──────────────────────────────────────────────────┘
           │ Phase 1 spins up
           ▼
┌─────────────────────────────────────────────────────────────┐
│              VERCEL SANDBOX                                   │
│              (ephemeral per classification run)               │
│                                                              │
│  Claude Agent SDK (Opus 1M)                                  │
│  via Vercel AI Gateway (https://ai-gateway.vercel.sh)        │
│                                                              │
│  Agent receives: company list + known matches + unknowns     │
│  Agent does: multi-step reasoning about each unknown company │
│  Agent returns: structured classifications with rationale    │
└──────────┬──────────────────────────────────────────────────┘
           │ results
           ▼
┌─────────────────────────────────────────────────────────────┐
│  VERCEL KV                          GITHUB (this repo)       │
│  ├── review:{id} → pending          ├── company-lists/       │
│  │   classifications                │   ├── exclusions.json  │
│  │   + decisions                    │   ├── tags.json        │
│  └── review:{id} → submitted        │   └── known_prospects  │
│                                     │       .json            │
│                                     └── (source of truth)    │
└─────────────────────────────────────────────────────────────┘
```

---

## Data Layer (this repo — accessed via GitHub API)

The JSON files live in the `Reddy-GTM` repo under `company-lists/`. The Vercel app reads them via the GitHub API (Octokit) and writes updates by creating commits. No local file system needed.

### File: `company-lists/exclusions.json`

Companies to exclude from prospect lists. Saved separately for ad platform blacklists.

```json
{
  "categories": {
    "ccaas": { "label": "CCaaS / Contact Center Platforms", "action": "exclude" },
    "ai_voice": { "label": "AI / Conversational AI / Voice AI", "action": "exclude" },
    "quality_analytics_wfm": { "label": "Quality / Analytics / WFM / CX Platforms", "action": "exclude" },
    "workforce_training_km": { "label": "Workforce / Training / Knowledge Management", "action": "exclude" },
    "consulting": { "label": "Consulting / Advisory / Systems Integrators", "action": "exclude" },
    "telecom_infrastructure": { "label": "Telecom / Infrastructure Vendors", "action": "exclude" },
    "cloud_bigtech": { "label": "Cloud / Big Tech (selling CX/CC solutions)", "action": "exclude" },
    "crm_saas_martech": { "label": "CRM / SaaS / Marketing Tech (selling to CC)", "action": "exclude" },
    "compliance_security": { "label": "Compliance / Identity / Security (selling to CC)", "action": "exclude" },
    "self": { "label": "Reddy (ourselves)", "action": "exclude" }
  },
  "companies": [
    { "name": "Five9", "aliases": [], "category": "ccaas", "added": "2026-03-28", "source": "CCW Las Vegas 2025" }
  ]
}
```

### File: `company-lists/tags.json`

Companies to keep but tag for different outreach.

```json
{
  "categories": {
    "bpo": { "label": "BPO / Outsourcing", "action": "tag" },
    "media": { "label": "Media / Press", "action": "tag" }
  },
  "companies": [
    { "name": "TTEC", "aliases": ["TTEC DIGITAL", "TTEC Digital", "TTecDigital", "ttec"], "category": "bpo", "added": "2026-03-28", "source": "CCW Las Vegas 2025" }
  ]
}
```

### File: `company-lists/known_prospects.json`

Companies the human has explicitly confirmed as prospects. Prevents Claude from re-flagging them on future lists.

```json
{
  "companies": [
    { "name": "AT&T", "aliases": [], "added": "2026-03-28", "source": "CCW Las Vegas 2025", "note": "Internal strategy titles — runs massive contact centers, legitimate prospect" }
  ]
}
```

### Schema rules

- `name`: Primary company name (canonical form)
- `aliases`: Array of known spelling variants. Matching checks both `name` and all `aliases`.
- `category`: Key from the `categories` object in the same file
- `added`: ISO date when the entry was created
- `source`: Which list or data source triggered the addition

---

## Logic Layer — `lib/classifier.ts`

TypeScript module running on Vercel. Fetches JSON files from GitHub, performs matching, returns results.

### Known matching

1. Fetch `exclusions.json`, `tags.json`, `known_prospects.json` from GitHub (cached in Vercel KV with short TTL for performance)
2. Normalize input: lowercase, trim whitespace
3. Check exact match against `name` and `aliases` in all three files
4. If no exact match, run fuzzy similarity (e.g., `fuzzball` or `string-similarity`) with threshold 0.90
5. Return result with `confidence: "known"`

### Claude classification (via Agent SDK in Sandbox)

For companies not found in any JSON file:

1. Spin up a Vercel Sandbox
2. Run Claude Agent SDK (`claude-opus-4-6`, 1M context) via AI Gateway
3. Agent receives the unknown companies + their attendee titles
4. Agent reasons about each company — is it a vendor, BPO, media, or prospect?
5. Agent returns structured JSON classifications with rationale
6. Sandbox shuts down
7. Results tagged with `confidence: "claude"`

### Public interface

```typescript
interface ClassificationResult {
  name: string;
  action: "exclude" | "tag" | "prospect";
  category: string | null;
  confidence: "known" | "claude";
  rationale: string | null;
}

// Single company (real-time, no agent — just known matching)
function classifyKnown(companyName: string): ClassificationResult | null;

// Batch with agent (conference lists, bulk imports)
async function classifyBatch(
  companies: { name: string; titles: string[] }[]
): Promise<ClassificationResult[]>;

// Update JSON files from review decisions
async function commitReviewDecisions(
  reviewId: string,
  decisions: Record<string, "accept" | "reject">,
  source: string
): Promise<{ exclusionsAdded: number; tagsAdded: number; prospectsAdded: number }>;
```

---

## Agent Execution — Vercel Sandbox + AI Gateway

### Why Sandbox + Agent SDK (not just an API call)

The classification task benefits from multi-step agent reasoning:
- The agent can look up company information, reason about title patterns across multiple attendees
- For ambiguous cases, the agent can weigh multiple signals before deciding
- As the system evolves, the agent can use web search, check LinkedIn, or call other tools
- The Agent SDK provides the full agentic loop — not just a single LLM response

### How it runs

```typescript
import { Sandbox } from '@vercel/sandbox';
import { query } from '@anthropic-ai/claude-agent-sdk';

// Spin up sandbox per classification run
const sandbox = await Sandbox.create({
  resources: { vcpus: 4 },
  timeout: '10m',
  runtime: 'node22',
});

try {
  // Agent runs inside sandbox via AI Gateway
  for await (const message of query({
    prompt: classificationPrompt,
    options: {
      model: 'anthropic/claude-opus-4.6',
      allowedTools: ['Read', 'Bash', 'WebSearch'],
      env: {
        ANTHROPIC_BASE_URL: 'https://ai-gateway.vercel.sh',
        ANTHROPIC_AUTH_TOKEN: process.env.AI_GATEWAY_API_KEY,
        ANTHROPIC_API_KEY: '',
      },
      betas: ['context-1m-2025-08-07'],
    },
  })) {
    if ('result' in message) {
      // Parse structured classifications from agent response
    }
  }
} finally {
  await sandbox.stop();
}
```

All requests route through Vercel AI Gateway — token usage, latency, and traces visible in Vercel Observability.

---

## Slack Integration — Slack Bolt on Next.js

Slack is the primary interface. Built with `@slack/bolt` using Vercel's Slack Bolt template pattern.

### Inbound (team → system)

| Slack action | What happens |
|---|---|
| Upload file + "classify this" | Agent processes the list, sends back summary + review link |
| "Check [company name]" | Quick known-match lookup, returns result inline |
| "Status of review [id]" | Returns review status from KV |

### Outbound (system → team)

| Event | Slack message |
|---|---|
| Classification complete | Summary stats + "Review Now" button linking to review UI |
| Review submitted | Confirmation: "X exclusions, Y tags, Z prospects committed" |
| Webhook triggered | "Common Room flagged [company] — classified as [result]" |

### Implementation

```typescript
// app/api/slack/events/route.ts
import { VercelReceiver } from '@vercel/slack-bolt';
import { App } from '@slack/bolt';

const receiver = new VercelReceiver({ signingSecret: process.env.SLACK_SIGNING_SECRET! });
const app = new App({ token: process.env.SLACK_BOT_TOKEN!, receiver });

app.message('classify', async ({ message, say }) => {
  // Handle file upload + classification request
});

app.message('check', async ({ message, say }) => {
  // Quick single-company lookup
});

export const POST = receiver.requestHandler;
```

---

## Webhook Integration

### Common Room

```
POST /api/webhook/common-room
```

Receives high-intent visitor signals. Extracts company name, runs `classifyKnown()` for instant known-match check. If unknown, queues for batch classification. Returns result to Common Room or posts to Slack.

### Apollo / HubSpot / Others

```
POST /api/webhook/[source]
```

Same pattern — extract company data, classify, route result. Each source gets its own webhook endpoint for clean separation.

---

## Review UI

### Page: `/review/[id]`

Fetches review data from Vercel KV. Renders a table:

| Company | Titles Seen | Claude Says | Category | Rationale | Decision |
|---|---|---|---|---|---|
| NewAI Corp | CEO, Solutions Engineer | exclude | ai_voice | AI voice vendor | Accept ○ Reject ○ |

- Each row defaults to "Accept" (accept Claude's suggestion)
- User toggles to "Reject" for any they disagree with
- Submit button at bottom

### Submit flow

1. `POST /api/review/[id]/submit` — saves decisions to Vercel KV
2. `POST /api/review/[id]/commit` — reads decisions, updates JSON files in GitHub via Octokit, sends Slack confirmation

---

## Processing Flow

```
Input (Slack file, webhook, or manual)
        │
        ▼
┌─────────────────────┐
│  1. KNOWN MATCHING   │  Fetch JSON from GitHub (cached in KV)
│     (instant)        │  Match against exclusions/tags/prospects
└──────┬──────────────┘
       │
       ├── Known exclusions → marked, separated in output
       ├── Known tags (BPO/Media) → marked in output
       ├── Known prospects → pass through clean
       └── Unknown companies ──▼
                               │
                ┌──────────────────────┐
                │  2. AGENT CLASSIFY    │  Vercel Sandbox
                │     Claude Agent SDK  │  via AI Gateway
                │     Opus 1M           │  multi-step reasoning
                └──────┬───────────────┘
                       │
                       ▼
                ┌──────────────────────┐
                │  3. STORE + NOTIFY    │  Results → Vercel KV
                │     Slack message     │  Review link → Slack
                │     with review link  │
                └──────┬───────────────┘
                       │
                       ▼
                ┌──────────────────────┐
                │  4. HUMAN REVIEW      │  Review UI on Vercel
                │     Accept / Reject   │
                │     per company       │
                └──────┬───────────────┘
                       │
          ┌────────────┼────────────┐
          ▼            ▼            ▼
      Accepted     Accepted      Rejected /
      Exclude      Tag           Prospect
          │            │            │
          ▼            ▼            ▼
   exclusions.json  tags.json   known_prospects.json
          │            │            │
          └────────────┼────────────┘
                       │
              GitHub commit (Octokit)
                       │
                       ▼
              Slack confirmation
```

---

## Tech Stack

| Component | Technology | Purpose |
|---|---|---|
| **App framework** | Next.js 15 (App Router, TypeScript) | API routes, review UI, webhooks |
| **Hosting** | Vercel | Deployment, serverless functions |
| **Agent runtime** | Vercel Sandbox | Isolated container for Agent SDK |
| **AI model** | Claude Opus 4.6 (1M context) | Company classification agent |
| **AI routing** | Vercel AI Gateway | Observability, token tracking |
| **Agent SDK** | `@anthropic-ai/claude-agent-sdk` | Multi-step agentic classification |
| **State** | Vercel KV (Redis) | Review state between phases |
| **Data persistence** | GitHub repo (this repo) | Source of truth for JSON files |
| **Git operations** | `@octokit/rest` | Read/write JSON files, create commits |
| **Slack** | `@slack/bolt` + `@vercel/slack-bolt` | Two-way Slack communication |
| **Fuzzy matching** | `fuzzball` | Known company matching |
| **File parsing** | `xlsx` (SheetJS) | Parse CSV/XLSX uploads |
| **Styling** | Tailwind CSS | Review UI |

---

## Environment Variables

| Variable | Source | Purpose |
|---|---|---|
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway | Routes Claude requests through gateway |
| `GITHUB_TOKEN` | GitHub PAT or App | Read/write to Reddy-GTM repo |
| `GITHUB_REPO` | Config | `ReddySolutions/Reddy-GTM` (or equivalent) |
| `SLACK_BOT_TOKEN` | Slack App | Send messages, read channels |
| `SLACK_SIGNING_SECRET` | Slack App | Verify webhook signatures |
| `SLACK_CHANNEL_ID` | Config | Channel for notifications |
| `KV_REST_API_URL` | Vercel KV | Redis connection |
| `KV_REST_API_TOKEN` | Vercel KV | Redis auth |

---

## Integration Points

| Source | Endpoint | How it uses the system |
|---|---|---|
| **Conference lists** | Slack file upload or `/api/classify` | Full flow — process list, review, commit |
| **Common Room** | `POST /api/webhook/common-room` | Real-time single-company check on visitor signal |
| **Apollo** | `POST /api/webhook/apollo` | Pre-filter before enrichment spend |
| **HubSpot** | `POST /api/webhook/hubspot` | Check new contacts/companies entering CRM |
| **Team member** | Slack "check [company]" | Quick known-match lookup |

---

## Open Decisions

None — all design questions resolved during brainstorming.
