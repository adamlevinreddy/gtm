# Company Classification System — Vercel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an always-available company classification system on Vercel, communicated with via Slack, that classifies prospect lists using Claude Agent SDK and maintains a self-improving exclusion/tag database in GitHub.

**Architecture:** A single Next.js 15 app on Vercel. Slack Bolt receives commands and file uploads. Known-company matching runs in serverless functions. Unknown companies are classified by a Claude Agent SDK agent in a Vercel Sandbox via AI Gateway. Review state persists in Vercel KV. Approved decisions are committed to the GitHub repo via Octokit.

**Tech Stack:** Next.js 15 (App Router), TypeScript, `@anthropic-ai/claude-agent-sdk`, Vercel AI Gateway, Vercel Sandbox, Vercel KV, `@slack/bolt` + `@vercel/slack-bolt`, `@octokit/rest`, `fuzzball`, `xlsx` (SheetJS), Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-03-28-company-classification-system-design.md`

---

## File Structure

```
reddy-gtm-tools/                          # NEW repo — separate Vercel project
├── package.json
├── tsconfig.json
├── next.config.ts
├── tailwind.config.ts
├── postcss.config.mjs
├── .env.local.example                     # Template for env vars
├── .gitignore
│
├── src/
│   ├── app/
│   │   ├── layout.tsx                     # Root layout with Tailwind
│   │   ├── page.tsx                       # Landing / status page
│   │   ├── review/
│   │   │   └── [id]/
│   │   │       └── page.tsx               # Review UI page
│   │   └── api/
│   │       ├── classify/
│   │       │   └── route.ts               # Direct classification trigger
│   │       ├── slack/
│   │       │   └── events/
│   │       │       └── route.ts           # Slack Bolt event handler
│   │       ├── webhook/
│   │       │   └── [source]/
│   │       │       └── route.ts           # Common Room, Apollo, etc.
│   │       └── review/
│   │           └── [id]/
│   │               ├── route.ts           # GET review data from KV
│   │               ├── submit/
│   │               │   └── route.ts       # POST accept/reject decisions
│   │               └── commit/
│   │                   └── route.ts       # POST trigger GitHub commit
│   │
│   ├── lib/
│   │   ├── types.ts                       # Shared TypeScript types
│   │   ├── classifier.ts                  # Known-company fuzzy matching
│   │   ├── agent.ts                       # Sandbox + Agent SDK orchestration
│   │   ├── github.ts                      # Octokit: read/write JSON to repo
│   │   ├── slack.ts                       # Slack messaging helpers
│   │   ├── kv.ts                          # Vercel KV review state helpers
│   │   ├── prompts.ts                     # Classification prompt for Claude agent
│   │   └── parse-upload.ts               # CSV/XLSX file parsing
│   │
│   └── components/
│       ├── review-table.tsx               # Review table with accept/reject toggles
│       └── submit-button.tsx              # Submit button with loading state
│
├── __tests__/
│   ├── classifier.test.ts                 # Known matching unit tests
│   ├── github.test.ts                     # Octokit operations tests
│   ├── kv.test.ts                         # KV state management tests
│   ├── parse-upload.test.ts               # File parsing tests
│   ├── api/
│   │   ├── classify.test.ts              # Classification endpoint tests
│   │   └── review.test.ts                # Review flow integration tests
│   └── fixtures/
│       ├── exclusions.json                # Small test exclusion data
│       ├── tags.json                      # Small test tag data
│       ├── known_prospects.json           # Small test prospect data
│       └── sample-list.xlsx              # Test attendee list
│
└── scripts/
    └── migrate-exclusion-list.ts          # One-time: convert MD → JSON files
```

---

### Task 1: Next.js Project Scaffold

**Files:**
- Create: `reddy-gtm-tools/package.json`
- Create: `reddy-gtm-tools/tsconfig.json`
- Create: `reddy-gtm-tools/next.config.ts`
- Create: `reddy-gtm-tools/tailwind.config.ts`
- Create: `reddy-gtm-tools/postcss.config.mjs`
- Create: `reddy-gtm-tools/.env.local.example`
- Create: `reddy-gtm-tools/.gitignore`
- Create: `reddy-gtm-tools/src/app/layout.tsx`
- Create: `reddy-gtm-tools/src/app/page.tsx`

- [ ] **Step 1: Create the project directory and initialize**

```bash
mkdir -p /Users/adamlevin/Downloads/reddy-gtm-tools
cd /Users/adamlevin/Downloads/reddy-gtm-tools
npx create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --no-import-alias --use-pnpm
```

Accept all defaults. This scaffolds Next.js 15 with App Router, TypeScript, Tailwind, and pnpm.

- [ ] **Step 2: Install project dependencies**

```bash
cd /Users/adamlevin/Downloads/reddy-gtm-tools
pnpm add @anthropic-ai/claude-agent-sdk @anthropic-ai/sdk @octokit/rest @slack/bolt @vercel/kv @vercel/sandbox fuzzball xlsx uuid
pnpm add -D @types/uuid vitest @vitejs/plugin-react
```

- [ ] **Step 3: Create .env.local.example**

```bash
# Vercel AI Gateway
AI_GATEWAY_API_KEY=

# GitHub (PAT with repo scope for Reddy-GTM repo)
GITHUB_TOKEN=
GITHUB_OWNER=ReddySolutions
GITHUB_REPO=Reddy-GTM
GITHUB_BRANCH=main

# Slack App
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=
SLACK_CHANNEL_ID=

# Vercel KV (auto-populated when linked)
KV_REST_API_URL=
KV_REST_API_TOKEN=
```

- [ ] **Step 4: Create vitest config**

Create `reddy-gtm-tools/vitest.config.ts`:

```typescript
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
```

- [ ] **Step 5: Add test script to package.json**

Add to `scripts` in `package.json`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 6: Replace the default page with a status page**

Replace `src/app/page.tsx`:

```tsx
export default function Home() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="text-center">
        <h1 className="text-2xl font-bold text-gray-900">Reddy GTM Tools</h1>
        <p className="mt-2 text-gray-600">Company classification system — active</p>
      </div>
    </main>
  );
}
```

- [ ] **Step 7: Initialize git and commit**

```bash
cd /Users/adamlevin/Downloads/reddy-gtm-tools
git init
git add .
git commit -m "feat: scaffold Next.js 15 project with dependencies"
```

---

### Task 2: Shared Types

**Files:**
- Create: `reddy-gtm-tools/src/lib/types.ts`

- [ ] **Step 1: Define all shared types**

```typescript
// src/lib/types.ts

/** Category definition in exclusions.json or tags.json */
export interface CategoryDefinition {
  label: string;
  action: "exclude" | "tag";
}

/** A company entry in exclusions.json or tags.json */
export interface CompanyEntry {
  name: string;
  aliases: string[];
  category: string;
  added: string;
  source: string;
}

/** A company entry in known_prospects.json */
export interface ProspectEntry {
  name: string;
  aliases: string[];
  added: string;
  source: string;
  note: string;
}

/** The structure of exclusions.json or tags.json */
export interface CompanyListFile {
  categories: Record<string, CategoryDefinition>;
  companies: CompanyEntry[];
}

/** The structure of known_prospects.json */
export interface ProspectListFile {
  companies: ProspectEntry[];
}

/** Result of classifying a single company */
export interface ClassificationResult {
  name: string;
  action: "exclude" | "tag" | "prospect";
  category: string | null;
  confidence: "known" | "claude";
  rationale: string | null;
}

/** A company with its attendees, used as input to classification */
export interface CompanyWithTitles {
  name: string;
  titles: string[];
}

/** A row in the review table */
export interface ReviewItem {
  name: string;
  titles: string[];
  action: "exclude" | "tag" | "prospect";
  category: string | null;
  rationale: string | null;
}

/** Full review state stored in Vercel KV */
export interface ReviewData {
  id: string;
  source: string;
  createdAt: string;
  status: "pending" | "submitted" | "committed";
  /** Companies Claude classified (needing human review) */
  items: ReviewItem[];
  /** Companies already matched from known lists (no review needed) */
  knownResults: ClassificationResult[];
  /** Human decisions: company name → accept or reject */
  decisions: Record<string, "accept" | "reject"> | null;
  /** Summary after commit */
  commitSummary: {
    exclusionsAdded: number;
    tagsAdded: number;
    prospectsAdded: number;
  } | null;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/types.ts
git commit -m "feat: shared TypeScript types for classification system"
```

---

### Task 3: GitHub Integration (Octokit)

**Files:**
- Create: `reddy-gtm-tools/src/lib/github.ts`
- Create: `reddy-gtm-tools/__tests__/github.test.ts`

- [ ] **Step 1: Write failing tests for GitHub operations**

```typescript
// __tests__/github.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchCompanyLists,
  commitCompanyListUpdates,
} from "@/lib/github";
import type { CompanyListFile, ProspectListFile } from "@/lib/types";

// Mock Octokit
vi.mock("@octokit/rest", () => {
  const mockGetContent = vi.fn();
  const mockCreateOrUpdateFileContents = vi.fn();
  return {
    Octokit: vi.fn(() => ({
      repos: {
        getContent: mockGetContent,
        createOrUpdateFileContents: mockCreateOrUpdateFileContents,
      },
    })),
    __mockGetContent: mockGetContent,
    __mockCreateOrUpdateFileContents: mockCreateOrUpdateFileContents,
  };
});

describe("fetchCompanyLists", () => {
  it("fetches and parses all three JSON files from GitHub", async () => {
    const { __mockGetContent } = await import("@octokit/rest") as any;

    const exclusions: CompanyListFile = {
      categories: { ccaas: { label: "CCaaS", action: "exclude" } },
      companies: [
        { name: "Five9", aliases: [], category: "ccaas", added: "2026-03-28", source: "test" },
      ],
    };
    const tags: CompanyListFile = {
      categories: { bpo: { label: "BPO", action: "tag" } },
      companies: [],
    };
    const prospects: ProspectListFile = {
      companies: [
        { name: "AT&T", aliases: [], added: "2026-03-28", source: "test", note: "" },
      ],
    };

    __mockGetContent.mockImplementation(({ path }: { path: string }) => {
      let content: string;
      if (path.includes("exclusions")) content = JSON.stringify(exclusions);
      else if (path.includes("tags")) content = JSON.stringify(tags);
      else content = JSON.stringify(prospects);
      return {
        data: { content: Buffer.from(content).toString("base64"), sha: "abc123" },
      };
    });

    const result = await fetchCompanyLists();

    expect(result.exclusions.companies).toHaveLength(1);
    expect(result.exclusions.companies[0].name).toBe("Five9");
    expect(result.tags.categories.bpo).toBeDefined();
    expect(result.prospects.companies[0].name).toBe("AT&T");
    expect(result.shas.exclusions).toBe("abc123");
  });
});

describe("commitCompanyListUpdates", () => {
  it("creates a commit for each modified file", async () => {
    const { __mockCreateOrUpdateFileContents, __mockGetContent } =
      await import("@octokit/rest") as any;

    __mockGetContent.mockResolvedValue({
      data: { content: Buffer.from("{}").toString("base64"), sha: "old-sha" },
    });
    __mockCreateOrUpdateFileContents.mockResolvedValue({ data: { commit: { sha: "new-sha" } } });

    const exclusions: CompanyListFile = {
      categories: {},
      companies: [
        { name: "TestCo", aliases: [], category: "ccaas", added: "2026-03-28", source: "test" },
      ],
    };

    await commitCompanyListUpdates({
      exclusions,
      exclusionsSha: "old-sha",
      message: "test: add TestCo",
    });

    expect(__mockCreateOrUpdateFileContents).toHaveBeenCalledWith(
      expect.objectContaining({
        path: "company-lists/exclusions.json",
        sha: "old-sha",
        message: "test: add TestCo",
      })
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/adamlevin/Downloads/reddy-gtm-tools && pnpm test -- __tests__/github.test.ts`
Expected: FAIL — module `@/lib/github` not found

- [ ] **Step 3: Implement GitHub operations**

```typescript
// src/lib/github.ts
import { Octokit } from "@octokit/rest";
import type { CompanyListFile, ProspectListFile } from "./types";

function getOctokit() {
  return new Octokit({ auth: process.env.GITHUB_TOKEN });
}

function repoParams() {
  return {
    owner: process.env.GITHUB_OWNER!,
    repo: process.env.GITHUB_REPO!,
  };
}

async function fetchFile(octokit: Octokit, path: string) {
  const { data } = await octokit.repos.getContent({
    ...repoParams(),
    path,
    ref: process.env.GITHUB_BRANCH || "main",
  });
  if ("content" in data && data.content) {
    const content = Buffer.from(data.content, "base64").toString("utf-8");
    return { parsed: JSON.parse(content), sha: data.sha };
  }
  throw new Error(`File ${path} is not a file or has no content`);
}

export interface CompanyListsData {
  exclusions: CompanyListFile;
  tags: CompanyListFile;
  prospects: ProspectListFile;
  shas: { exclusions: string; tags: string; prospects: string };
}

export async function fetchCompanyLists(): Promise<CompanyListsData> {
  const octokit = getOctokit();
  const [exclusionsResult, tagsResult, prospectsResult] = await Promise.all([
    fetchFile(octokit, "company-lists/exclusions.json"),
    fetchFile(octokit, "company-lists/tags.json"),
    fetchFile(octokit, "company-lists/known_prospects.json"),
  ]);
  return {
    exclusions: exclusionsResult.parsed as CompanyListFile,
    tags: tagsResult.parsed as CompanyListFile,
    prospects: prospectsResult.parsed as ProspectListFile,
    shas: {
      exclusions: exclusionsResult.sha,
      tags: tagsResult.sha,
      prospects: prospectsResult.sha,
    },
  };
}

export async function commitCompanyListUpdates(updates: {
  exclusions?: CompanyListFile;
  exclusionsSha?: string;
  tags?: CompanyListFile;
  tagsSha?: string;
  prospects?: ProspectListFile;
  prospectsSha?: string;
  message: string;
}) {
  const octokit = getOctokit();
  const commits: Promise<unknown>[] = [];

  if (updates.exclusions && updates.exclusionsSha) {
    commits.push(
      octokit.repos.createOrUpdateFileContents({
        ...repoParams(),
        path: "company-lists/exclusions.json",
        message: updates.message,
        content: Buffer.from(
          JSON.stringify(updates.exclusions, null, 2) + "\n"
        ).toString("base64"),
        sha: updates.exclusionsSha,
        branch: process.env.GITHUB_BRANCH || "main",
      })
    );
  }

  if (updates.tags && updates.tagsSha) {
    commits.push(
      octokit.repos.createOrUpdateFileContents({
        ...repoParams(),
        path: "company-lists/tags.json",
        message: updates.message,
        content: Buffer.from(
          JSON.stringify(updates.tags, null, 2) + "\n"
        ).toString("base64"),
        sha: updates.tagsSha,
        branch: process.env.GITHUB_BRANCH || "main",
      })
    );
  }

  if (updates.prospects && updates.prospectsSha) {
    commits.push(
      octokit.repos.createOrUpdateFileContents({
        ...repoParams(),
        path: "company-lists/known_prospects.json",
        message: updates.message,
        content: Buffer.from(
          JSON.stringify(updates.prospects, null, 2) + "\n"
        ).toString("base64"),
        sha: updates.prospectsSha,
        branch: process.env.GITHUB_BRANCH || "main",
      })
    );
  }

  await Promise.all(commits);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/adamlevin/Downloads/reddy-gtm-tools && pnpm test -- __tests__/github.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/github.ts __tests__/github.test.ts
git commit -m "feat: GitHub integration — fetch and commit company list JSON files"
```

---

### Task 4: Known Company Matching (Classifier)

**Files:**
- Create: `reddy-gtm-tools/src/lib/classifier.ts`
- Create: `reddy-gtm-tools/__tests__/classifier.test.ts`
- Create: `reddy-gtm-tools/__tests__/fixtures/exclusions.json`
- Create: `reddy-gtm-tools/__tests__/fixtures/tags.json`
- Create: `reddy-gtm-tools/__tests__/fixtures/known_prospects.json`

- [ ] **Step 1: Create test fixture files**

`__tests__/fixtures/exclusions.json`:
```json
{
  "categories": {
    "ccaas": { "label": "CCaaS / Contact Center Platforms", "action": "exclude" },
    "ai_voice": { "label": "AI / Conversational AI / Voice AI", "action": "exclude" }
  },
  "companies": [
    { "name": "Five9", "aliases": [], "category": "ccaas", "added": "2026-03-28", "source": "test" },
    { "name": "NICE", "aliases": ["NICE inContact", "NICE CXone"], "category": "ccaas", "added": "2026-03-28", "source": "test" },
    { "name": "Observe.AI", "aliases": ["Obsereve.AI"], "category": "ai_voice", "added": "2026-03-28", "source": "test" }
  ]
}
```

`__tests__/fixtures/tags.json`:
```json
{
  "categories": {
    "bpo": { "label": "BPO / Outsourcing", "action": "tag" },
    "media": { "label": "Media / Press", "action": "tag" }
  },
  "companies": [
    { "name": "TTEC", "aliases": ["TTEC DIGITAL", "TTEC Digital", "ttec"], "category": "bpo", "added": "2026-03-28", "source": "test" },
    { "name": "CX Today", "aliases": [], "category": "media", "added": "2026-03-28", "source": "test" }
  ]
}
```

`__tests__/fixtures/known_prospects.json`:
```json
{
  "companies": [
    { "name": "AT&T", "aliases": [], "added": "2026-03-28", "source": "test", "note": "runs massive contact centers" }
  ]
}
```

- [ ] **Step 2: Write failing tests for known matching**

```typescript
// __tests__/classifier.test.ts
import { describe, it, expect } from "vitest";
import { CompanyClassifier } from "@/lib/classifier";
import type { CompanyListFile, ProspectListFile } from "@/lib/types";
import exclusionsFixture from "./fixtures/exclusions.json";
import tagsFixture from "./fixtures/tags.json";
import prospectsFixture from "./fixtures/known_prospects.json";

function createClassifier() {
  return new CompanyClassifier(
    exclusionsFixture as CompanyListFile,
    tagsFixture as CompanyListFile,
    prospectsFixture as ProspectListFile
  );
}

describe("CompanyClassifier — known matching", () => {
  it("matches an exact exclusion", () => {
    const c = createClassifier();
    const result = c.classifyKnown("Five9");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("exclude");
    expect(result!.category).toBe("ccaas");
    expect(result!.confidence).toBe("known");
  });

  it("matches an exact tag", () => {
    const c = createClassifier();
    const result = c.classifyKnown("TTEC");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("tag");
    expect(result!.category).toBe("bpo");
  });

  it("matches via alias", () => {
    const c = createClassifier();
    const result = c.classifyKnown("TTEC DIGITAL");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("tag");
    expect(result!.category).toBe("bpo");
  });

  it("matches case-insensitively", () => {
    const c = createClassifier();
    const result = c.classifyKnown("five9");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("exclude");
  });

  it("trims whitespace", () => {
    const c = createClassifier();
    const result = c.classifyKnown("  Five9  ");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("exclude");
  });

  it("matches a known prospect", () => {
    const c = createClassifier();
    const result = c.classifyKnown("AT&T");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("prospect");
    expect(result!.confidence).toBe("known");
    expect(result!.category).toBeNull();
  });

  it("matches a known alias with typo", () => {
    const c = createClassifier();
    const result = c.classifyKnown("Obsereve.AI");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("exclude");
    expect(result!.category).toBe("ai_voice");
  });

  it("fuzzy matches near-miss", () => {
    const c = createClassifier();
    const result = c.classifyKnown("NICE InContact");
    expect(result).not.toBeNull();
    expect(result!.action).toBe("exclude");
  });

  it("returns null for unknown company", () => {
    const c = createClassifier();
    const result = c.classifyKnown("Totally Unknown Corp");
    expect(result).toBeNull();
  });

  it("prospects take precedence over fuzzy vendor matches", () => {
    const c = createClassifier();
    const result = c.classifyKnown("AT&T");
    expect(result!.action).toBe("prospect");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /Users/adamlevin/Downloads/reddy-gtm-tools && pnpm test -- __tests__/classifier.test.ts`
Expected: FAIL — module `@/lib/classifier` not found

- [ ] **Step 4: Implement the CompanyClassifier**

```typescript
// src/lib/classifier.ts
import fuzzball from "fuzzball";
import type {
  ClassificationResult,
  CompanyListFile,
  ProspectListFile,
} from "./types";

interface LookupEntry {
  name: string;
  action: "exclude" | "tag" | "prospect";
  category: string | null;
}

export class CompanyClassifier {
  private lookup: Map<string, LookupEntry> = new Map();
  private prospectLookup: Map<string, LookupEntry> = new Map();
  private allKeys: string[] = [];

  static readonly FUZZY_THRESHOLD = 90;

  constructor(
    exclusions: CompanyListFile,
    tags: CompanyListFile,
    prospects: ProspectListFile
  ) {
    this.buildLookup(exclusions, tags, prospects);
  }

  private buildLookup(
    exclusions: CompanyListFile,
    tags: CompanyListFile,
    prospects: ProspectListFile
  ) {
    for (const company of prospects.companies) {
      const entry: LookupEntry = {
        name: company.name,
        action: "prospect",
        category: null,
      };
      this.prospectLookup.set(this.normalize(company.name), entry);
      for (const alias of company.aliases) {
        this.prospectLookup.set(this.normalize(alias), entry);
      }
    }

    for (const company of exclusions.companies) {
      const entry: LookupEntry = {
        name: company.name,
        action: "exclude",
        category: company.category,
      };
      this.lookup.set(this.normalize(company.name), entry);
      for (const alias of company.aliases) {
        this.lookup.set(this.normalize(alias), entry);
      }
    }

    for (const company of tags.companies) {
      const entry: LookupEntry = {
        name: company.name,
        action: "tag",
        category: company.category,
      };
      this.lookup.set(this.normalize(company.name), entry);
      for (const alias of company.aliases) {
        this.lookup.set(this.normalize(alias), entry);
      }
    }

    this.allKeys = [
      ...Array.from(this.prospectLookup.keys()),
      ...Array.from(this.lookup.keys()),
    ];
  }

  private normalize(name: string): string {
    return name.trim().toLowerCase();
  }

  classifyKnown(companyName: string): ClassificationResult | null {
    const normalized = this.normalize(companyName);

    // Check prospects first (they take precedence)
    const prospect = this.prospectLookup.get(normalized);
    if (prospect) {
      return {
        name: prospect.name,
        action: "prospect",
        category: null,
        confidence: "known",
        rationale: "Previously confirmed as prospect",
      };
    }

    // Check exclusions and tags
    const known = this.lookup.get(normalized);
    if (known) {
      return {
        name: known.name,
        action: known.action,
        category: known.category,
        confidence: "known",
        rationale: null,
      };
    }

    // Fuzzy match
    for (const key of this.allKeys) {
      const score = fuzzball.ratio(normalized, key);
      if (score >= CompanyClassifier.FUZZY_THRESHOLD) {
        const prospectMatch = this.prospectLookup.get(key);
        if (prospectMatch) {
          return {
            name: prospectMatch.name,
            action: "prospect",
            category: null,
            confidence: "known",
            rationale: `Fuzzy match (${score}%) to known prospect`,
          };
        }
        const knownMatch = this.lookup.get(key);
        if (knownMatch) {
          return {
            name: knownMatch.name,
            action: knownMatch.action,
            category: knownMatch.category,
            confidence: "known",
            rationale: `Fuzzy match (${score}%) to known company`,
          };
        }
      }
    }

    return null;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/adamlevin/Downloads/reddy-gtm-tools && pnpm test -- __tests__/classifier.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/classifier.ts __tests__/classifier.test.ts __tests__/fixtures/
git commit -m "feat: known company matching with fuzzy search"
```

---

### Task 5: Vercel KV State Management

**Files:**
- Create: `reddy-gtm-tools/src/lib/kv.ts`
- Create: `reddy-gtm-tools/__tests__/kv.test.ts`

- [ ] **Step 1: Write failing tests for KV operations**

```typescript
// __tests__/kv.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createReview, getReview, submitDecisions, markCommitted } from "@/lib/kv";
import type { ReviewData, ReviewItem } from "@/lib/types";

vi.mock("@vercel/kv", () => {
  const store = new Map<string, string>();
  return {
    kv: {
      set: vi.fn(async (key: string, value: unknown, opts?: unknown) => {
        store.set(key, JSON.stringify(value));
      }),
      get: vi.fn(async (key: string) => {
        const val = store.get(key);
        return val ? JSON.parse(val) : null;
      }),
    },
    __store: store,
  };
});

beforeEach(async () => {
  const { __store } = await import("@vercel/kv") as any;
  __store.clear();
});

describe("KV review state", () => {
  const sampleItems: ReviewItem[] = [
    { name: "TestCo", titles: ["CEO"], action: "exclude", category: "ccaas", rationale: "CCaaS vendor" },
  ];

  it("creates a review and retrieves it", async () => {
    const id = await createReview({ source: "test", items: sampleItems, knownResults: [] });
    expect(id).toBeDefined();

    const review = await getReview(id);
    expect(review).not.toBeNull();
    expect(review!.status).toBe("pending");
    expect(review!.items).toHaveLength(1);
    expect(review!.items[0].name).toBe("TestCo");
  });

  it("submits decisions and updates status", async () => {
    const id = await createReview({ source: "test", items: sampleItems, knownResults: [] });
    await submitDecisions(id, { TestCo: "accept" });

    const review = await getReview(id);
    expect(review!.status).toBe("submitted");
    expect(review!.decisions).toEqual({ TestCo: "accept" });
  });

  it("marks as committed with summary", async () => {
    const id = await createReview({ source: "test", items: sampleItems, knownResults: [] });
    await submitDecisions(id, { TestCo: "accept" });
    await markCommitted(id, { exclusionsAdded: 1, tagsAdded: 0, prospectsAdded: 0 });

    const review = await getReview(id);
    expect(review!.status).toBe("committed");
    expect(review!.commitSummary!.exclusionsAdded).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/adamlevin/Downloads/reddy-gtm-tools && pnpm test -- __tests__/kv.test.ts`
Expected: FAIL — module `@/lib/kv` not found

- [ ] **Step 3: Implement KV state management**

```typescript
// src/lib/kv.ts
import { kv } from "@vercel/kv";
import { v4 as uuidv4 } from "uuid";
import type { ReviewData, ReviewItem, ClassificationResult } from "./types";

const REVIEW_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export async function createReview(params: {
  source: string;
  items: ReviewItem[];
  knownResults: ClassificationResult[];
}): Promise<string> {
  const id = uuidv4();
  const review: ReviewData = {
    id,
    source: params.source,
    createdAt: new Date().toISOString(),
    status: "pending",
    items: params.items,
    knownResults: params.knownResults,
    decisions: null,
    commitSummary: null,
  };
  await kv.set(`review:${id}`, review, { ex: REVIEW_TTL_SECONDS });
  return id;
}

export async function getReview(id: string): Promise<ReviewData | null> {
  return kv.get<ReviewData>(`review:${id}`);
}

export async function submitDecisions(
  id: string,
  decisions: Record<string, "accept" | "reject">
): Promise<void> {
  const review = await getReview(id);
  if (!review) throw new Error(`Review ${id} not found`);
  review.status = "submitted";
  review.decisions = decisions;
  await kv.set(`review:${id}`, review, { ex: REVIEW_TTL_SECONDS });
}

export async function markCommitted(
  id: string,
  summary: { exclusionsAdded: number; tagsAdded: number; prospectsAdded: number }
): Promise<void> {
  const review = await getReview(id);
  if (!review) throw new Error(`Review ${id} not found`);
  review.status = "committed";
  review.commitSummary = summary;
  await kv.set(`review:${id}`, review, { ex: REVIEW_TTL_SECONDS });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/adamlevin/Downloads/reddy-gtm-tools && pnpm test -- __tests__/kv.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/kv.ts __tests__/kv.test.ts
git commit -m "feat: Vercel KV state management for review lifecycle"
```

---

### Task 6: Classification Prompt & Agent Orchestration

**Files:**
- Create: `reddy-gtm-tools/src/lib/prompts.ts`
- Create: `reddy-gtm-tools/src/lib/agent.ts`

- [ ] **Step 1: Create the classification prompt**

```typescript
// src/lib/prompts.ts

export const CLASSIFICATION_SYSTEM_PROMPT = `You are a company classifier for Reddy, a company that sells AI-powered training, QA, and coaching solutions to contact centers.

Your job: given a company name and the job titles of people attending a conference from that company, classify the company into one of these categories.

## EXCLUDE categories (vendors/competitors selling TO contact centers):
- ccaas: CCaaS / Contact Center Platforms (e.g., Five9, Genesys, NICE, Talkdesk)
- ai_voice: AI / Conversational AI / Voice AI vendors (e.g., Observe.AI, PolyAI, Sanas)
- quality_analytics_wfm: Quality / Analytics / WFM / CX Platforms (e.g., Calabrio, Verint, CallMiner)
- workforce_training_km: Workforce / Training / Knowledge Management vendors (e.g., SymTrain, Zenarate)
- consulting: Consulting / Advisory / Systems Integrators (e.g., Accenture, KPMG)
- telecom_infrastructure: Telecom / Infrastructure Vendors selling to CC
- cloud_bigtech: Cloud / Big Tech selling CX/CC solutions (e.g., AWS, Google Cloud, Microsoft, IBM)
- crm_saas_martech: CRM / SaaS / Marketing Tech selling to CC (e.g., Salesforce, Zendesk)
- compliance_security: Compliance / Identity / Security vendors selling to CC
- self: Reddy itself

## TAG categories (keep as prospects but outreach differently):
- bpo: BPO / Outsourcing companies that run contact centers for others (e.g., TTEC, Concentrix, Alorica)
- media: Media / Press / Events companies (e.g., CX Today, CX Dive)

## PROSPECT (default):
Companies that OPERATE their own contact centers and are potential buyers. This includes companies in any industry (retail, healthcare, finance, travel, insurance, telecom, etc.) that have internal customer service, support, or contact center operations.

## How to decide:
1. If the company is a known technology vendor, platform, or service provider that SELLS to contact centers → exclude with appropriate category
2. If attendee titles are all sales/marketing/partnerships/BDR/AE → likely a vendor there to sell
3. If the company is a BPO/outsourcer → tag as bpo
4. If the company is media/press → tag as media
5. If the company operates its own contact center (titles like Director of CX, VP Contact Center, Call Center Manager, etc.) → prospect
6. When in doubt, classify as prospect — false negatives (missing a vendor) are better than false positives (excluding a real prospect)

Respond with ONLY a valid JSON array. Each element must have exactly these fields:
- "name": the company name exactly as provided
- "action": "exclude", "tag", or "prospect"
- "category": the category key (e.g., "ccaas", "bpo") or null for prospects
- "rationale": one sentence explaining why`;

export function buildClassificationPrompt(
  companies: { name: string; titles: string[] }[]
): string {
  const companiesJson = JSON.stringify(
    companies.map((c) => ({
      company: c.name,
      titles: c.titles.slice(0, 20), // cap titles per company for token efficiency
    })),
    null,
    2
  );

  return `Classify each of these companies:\n\n${companiesJson}`;
}
```

- [ ] **Step 2: Implement the agent orchestration module**

```typescript
// src/lib/agent.ts
import { query, ClaudeAgentOptions, ResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CompanyWithTitles, ClassificationResult } from "./types";
import { CLASSIFICATION_SYSTEM_PROMPT, buildClassificationPrompt } from "./prompts";

/**
 * Classify unknown companies using Claude Agent SDK in a Vercel Sandbox.
 *
 * The agent runs with Opus 1M context via Vercel AI Gateway.
 * It receives the list of unknown companies + titles and returns
 * structured classifications with rationale.
 */
export async function classifyWithAgent(
  companies: CompanyWithTitles[]
): Promise<ClassificationResult[]> {
  if (companies.length === 0) return [];

  const userPrompt = buildClassificationPrompt(companies);

  let agentResult = "";

  for await (const message of query({
    prompt: userPrompt,
    options: {
      model: "anthropic/claude-opus-4.6",
      systemPrompt: CLASSIFICATION_SYSTEM_PROMPT,
      allowedTools: ["WebSearch"],
      maxTurns: 10,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
        ANTHROPIC_AUTH_TOKEN: process.env.AI_GATEWAY_API_KEY || "",
        ANTHROPIC_API_KEY: "",
      },
      betas: ["context-1m-2025-08-07"],
    } as ClaudeAgentOptions,
  })) {
    if (message && "result" in message) {
      agentResult = (message as ResultMessage).result;
    }
  }

  // Extract JSON array from agent response (may contain markdown fencing)
  const jsonMatch = agentResult.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(`Agent did not return valid JSON. Response: ${agentResult.slice(0, 500)}`);
  }

  const parsed: Array<{
    name: string;
    action: string;
    category: string | null;
    rationale: string;
  }> = JSON.parse(jsonMatch[0]);

  return parsed.map((item) => ({
    name: item.name,
    action: item.action as "exclude" | "tag" | "prospect",
    category: item.category,
    confidence: "claude" as const,
    rationale: item.rationale,
  }));
}
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/prompts.ts src/lib/agent.ts
git commit -m "feat: classification prompt and Agent SDK orchestration"
```

---

### Task 7: File Parsing (CSV/XLSX)

**Files:**
- Create: `reddy-gtm-tools/src/lib/parse-upload.ts`
- Create: `reddy-gtm-tools/__tests__/parse-upload.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// __tests__/parse-upload.test.ts
import { describe, it, expect } from "vitest";
import { parseUploadedFile, detectColumns } from "@/lib/parse-upload";

describe("detectColumns", () => {
  it("detects Company and Job Title columns", () => {
    const headers = ["Company", "Job Title", "Other"];
    const { companyCol, titleCol } = detectColumns(headers);
    expect(companyCol).toBe(0);
    expect(titleCol).toBe(1);
  });

  it("detects columns case-insensitively", () => {
    const headers = ["COMPANY NAME", "JOB TITLE"];
    const { companyCol, titleCol } = detectColumns(headers);
    expect(companyCol).toBe(0);
    expect(titleCol).toBe(1);
  });

  it("falls back to first two columns if no match", () => {
    const headers = ["Col A", "Col B"];
    const { companyCol, titleCol } = detectColumns(headers);
    expect(companyCol).toBe(0);
    expect(titleCol).toBe(1);
  });
});

describe("parseUploadedFile", () => {
  it("parses a CSV buffer", async () => {
    const csv = "Company,Job Title\nFive9,Account Executive\nFive9,VP Sales\n";
    const buffer = Buffer.from(csv);
    const result = await parseUploadedFile(buffer, "test.csv");
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Five9");
    expect(result[0].titles).toContain("Account Executive");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/adamlevin/Downloads/reddy-gtm-tools && pnpm test -- __tests__/parse-upload.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement file parsing**

```typescript
// src/lib/parse-upload.ts
import * as XLSX from "xlsx";
import type { CompanyWithTitles } from "./types";

export function detectColumns(headers: string[]): {
  companyCol: number;
  titleCol: number;
} {
  const lower = headers.map((h) => h.toLowerCase().trim());

  let companyCol = lower.findIndex((h) => h.includes("company"));
  let titleCol = lower.findIndex(
    (h) => h.includes("title") || h.includes("job")
  );

  if (companyCol === -1) companyCol = 0;
  if (titleCol === -1) titleCol = companyCol === 0 ? 1 : 0;
  if (titleCol === companyCol) titleCol = Math.min(companyCol + 1, headers.length - 1);

  return { companyCol, titleCol };
}

export async function parseUploadedFile(
  buffer: Buffer,
  filename: string
): Promise<CompanyWithTitles[]> {
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];
  const rows: string[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: "",
  });

  if (rows.length < 2) return [];

  const headers = rows[0].map(String);
  const { companyCol, titleCol } = detectColumns(headers);

  const grouped = new Map<string, string[]>();

  for (let i = 1; i < rows.length; i++) {
    const company = String(rows[i][companyCol] || "").trim();
    const title = String(rows[i][titleCol] || "").trim();
    if (!company) continue;

    if (!grouped.has(company)) {
      grouped.set(company, []);
    }
    if (title) {
      grouped.get(company)!.push(title);
    }
  }

  return Array.from(grouped.entries()).map(([name, titles]) => ({
    name,
    titles,
  }));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/adamlevin/Downloads/reddy-gtm-tools && pnpm test -- __tests__/parse-upload.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/parse-upload.ts __tests__/parse-upload.test.ts
git commit -m "feat: CSV/XLSX file parsing with column detection"
```

---

### Task 8: Slack Integration

**Files:**
- Create: `reddy-gtm-tools/src/lib/slack.ts`
- Create: `reddy-gtm-tools/src/app/api/slack/events/route.ts`

- [ ] **Step 1: Create Slack messaging helpers**

```typescript
// src/lib/slack.ts
import { WebClient } from "@slack/web-api";

function getSlackClient() {
  return new WebClient(process.env.SLACK_BOT_TOKEN);
}

export async function sendReviewNotification(params: {
  reviewId: string;
  source: string;
  totalCompanies: number;
  knownMatches: number;
  needsReview: number;
  excludedCompanies: number;
  taggedCompanies: number;
  prospectCompanies: number;
}) {
  const client = getSlackClient();
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000";

  await client.chat.postMessage({
    channel: process.env.SLACK_CHANNEL_ID!,
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `Classification complete: ${params.source}`,
        },
      },
      {
        type: "section",
        fields: [
          { type: "mrkdwn", text: `*Total companies:*\n${params.totalCompanies}` },
          { type: "mrkdwn", text: `*Known matches:*\n${params.knownMatches}` },
          { type: "mrkdwn", text: `*Excluded (vendors):*\n${params.excludedCompanies}` },
          { type: "mrkdwn", text: `*Tagged (BPO/Media):*\n${params.taggedCompanies}` },
          { type: "mrkdwn", text: `*Prospects:*\n${params.prospectCompanies}` },
          { type: "mrkdwn", text: `*Needs review:*\n${params.needsReview}` },
        ],
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "Review Now" },
            url: `${baseUrl}/review/${params.reviewId}`,
            style: "primary",
          },
        ],
      },
    ],
  });
}

export async function sendCommitConfirmation(params: {
  source: string;
  exclusionsAdded: number;
  tagsAdded: number;
  prospectsAdded: number;
}) {
  const client = getSlackClient();

  await client.chat.postMessage({
    channel: process.env.SLACK_CHANNEL_ID!,
    blocks: [
      {
        type: "header",
        text: { type: "plain_text", text: `Review committed: ${params.source}` },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: [
            `*${params.exclusionsAdded}* new exclusions added`,
            `*${params.tagsAdded}* new tags added`,
            `*${params.prospectsAdded}* confirmed as prospects`,
            "\nCompany lists updated in GitHub. These will be caught automatically on future lists.",
          ].join("\n"),
        },
      },
    ],
  });
}

export async function sendQuickClassification(params: {
  companyName: string;
  action: string;
  category: string | null;
  confidence: string;
  threadTs?: string;
}) {
  const client = getSlackClient();

  const emoji =
    params.action === "exclude" ? ":no_entry:" :
    params.action === "tag" ? ":label:" :
    ":white_check_mark:";

  await client.chat.postMessage({
    channel: process.env.SLACK_CHANNEL_ID!,
    thread_ts: params.threadTs,
    text: `${emoji} *${params.companyName}*: ${params.action}${params.category ? ` (${params.category})` : ""} — confidence: ${params.confidence}`,
  });
}
```

- [ ] **Step 2: Create the Slack Bolt event handler**

```typescript
// src/app/api/slack/events/route.ts
import { NextRequest, NextResponse } from "next/server";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body = await req.json();

  // Slack URL verification challenge
  if (body.type === "url_verification") {
    return NextResponse.json({ challenge: body.challenge });
  }

  // Handle events asynchronously
  if (body.event) {
    const event = body.event;

    // Only respond to messages, not bot messages
    if (event.type === "message" && !event.bot_id) {
      const text = (event.text || "").toLowerCase().trim();

      if (text.startsWith("check ")) {
        const companyName = event.text.slice(6).trim();
        // Defer to background processing
        // The classify API route handles the actual work
        await fetch(
          `${process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000"}/api/classify`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              mode: "quick",
              company: companyName,
              slackThreadTs: event.ts,
            }),
          }
        );
      }

      // File uploads are handled via Slack file_shared events
      // and the classify endpoint
    }
  }

  // Always ack within 3 seconds
  return NextResponse.json({ ok: true });
}
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/slack.ts src/app/api/slack/events/route.ts
git commit -m "feat: Slack integration — notifications, quick check, event handler"
```

---

### Task 9: Classification API Route (Core Pipeline)

**Files:**
- Create: `reddy-gtm-tools/src/app/api/classify/route.ts`

- [ ] **Step 1: Implement the classification endpoint**

This is the core pipeline that ties everything together.

```typescript
// src/app/api/classify/route.ts
import { NextRequest, NextResponse } from "next/server";
import { CompanyClassifier } from "@/lib/classifier";
import { classifyWithAgent } from "@/lib/agent";
import { fetchCompanyLists } from "@/lib/github";
import { createReview } from "@/lib/kv";
import { parseUploadedFile } from "@/lib/parse-upload";
import {
  sendReviewNotification,
  sendQuickClassification,
} from "@/lib/slack";
import type {
  ClassificationResult,
  CompanyWithTitles,
  ReviewItem,
} from "@/lib/types";

export const maxDuration = 300; // 5 minutes for batch classification

export async function POST(req: NextRequest) {
  const contentType = req.headers.get("content-type") || "";

  // Quick single-company check (from Slack "check" command or webhook)
  if (contentType.includes("application/json")) {
    const body = await req.json();

    if (body.mode === "quick") {
      return handleQuickCheck(body.company, body.slackThreadTs);
    }

    if (body.mode === "batch" && body.companies) {
      return handleBatchFromJson(body.companies, body.source || "API");
    }
  }

  // File upload (from Slack or direct)
  if (contentType.includes("multipart/form-data")) {
    const formData = await req.formData();
    const file = formData.get("file") as File;
    const source = (formData.get("source") as string) || file?.name || "upload";

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const companies = await parseUploadedFile(buffer, file.name);
    return handleBatchFromJson(companies, source);
  }

  return NextResponse.json({ error: "Invalid request" }, { status: 400 });
}

async function handleQuickCheck(companyName: string, slackThreadTs?: string) {
  const lists = await fetchCompanyLists();
  const classifier = new CompanyClassifier(
    lists.exclusions,
    lists.tags,
    lists.prospects
  );

  const result = classifier.classifyKnown(companyName);

  if (result) {
    if (slackThreadTs) {
      await sendQuickClassification({
        companyName,
        action: result.action,
        category: result.category,
        confidence: result.confidence,
        threadTs: slackThreadTs,
      });
    }
    return NextResponse.json(result);
  }

  // Unknown — run through agent for single company
  const agentResults = await classifyWithAgent([
    { name: companyName, titles: [] },
  ]);

  const agentResult = agentResults[0] || {
    name: companyName,
    action: "prospect" as const,
    category: null,
    confidence: "claude" as const,
    rationale: "No classification available",
  };

  if (slackThreadTs) {
    await sendQuickClassification({
      companyName,
      action: agentResult.action,
      category: agentResult.category,
      confidence: agentResult.confidence,
      threadTs: slackThreadTs,
    });
  }

  return NextResponse.json(agentResult);
}

async function handleBatchFromJson(
  companies: CompanyWithTitles[],
  source: string
) {
  // 1. Fetch current company lists from GitHub
  const lists = await fetchCompanyLists();
  const classifier = new CompanyClassifier(
    lists.exclusions,
    lists.tags,
    lists.prospects
  );

  // 2. Split into known and unknown
  const knownResults: ClassificationResult[] = [];
  const unknowns: CompanyWithTitles[] = [];

  for (const company of companies) {
    const known = classifier.classifyKnown(company.name);
    if (known) {
      knownResults.push(known);
    } else {
      unknowns.push(company);
    }
  }

  // 3. Classify unknowns with Claude agent
  let agentResults: ClassificationResult[] = [];
  if (unknowns.length > 0) {
    agentResults = await classifyWithAgent(unknowns);
  }

  // 4. Build review items from agent results
  const reviewItems: ReviewItem[] = agentResults.map((r) => {
    const companyData = unknowns.find((u) => u.name === r.name);
    return {
      name: r.name,
      titles: companyData?.titles || [],
      action: r.action,
      category: r.category,
      rationale: r.rationale,
    };
  });

  // 5. Store in KV and notify via Slack
  const reviewId = await createReview({
    source,
    items: reviewItems,
    knownResults,
  });

  const excludedCount = knownResults.filter((r) => r.action === "exclude").length;
  const taggedCount = knownResults.filter((r) => r.action === "tag").length;
  const prospectCount = knownResults.filter((r) => r.action === "prospect").length;

  await sendReviewNotification({
    reviewId,
    source,
    totalCompanies: companies.length,
    knownMatches: knownResults.length,
    needsReview: reviewItems.length,
    excludedCompanies: excludedCount,
    taggedCompanies: taggedCount,
    prospectCompanies: prospectCount,
  });

  return NextResponse.json({
    reviewId,
    totalCompanies: companies.length,
    knownMatches: knownResults.length,
    needsReview: reviewItems.length,
    reviewUrl: `/review/${reviewId}`,
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/classify/route.ts
git commit -m "feat: classification API route — core pipeline with known matching + agent"
```

---

### Task 10: Review UI Page

**Files:**
- Create: `reddy-gtm-tools/src/app/review/[id]/page.tsx`
- Create: `reddy-gtm-tools/src/components/review-table.tsx`
- Create: `reddy-gtm-tools/src/components/submit-button.tsx`
- Create: `reddy-gtm-tools/src/app/api/review/[id]/route.ts`
- Create: `reddy-gtm-tools/src/app/api/review/[id]/submit/route.ts`

- [ ] **Step 1: Create the GET review data API route**

```typescript
// src/app/api/review/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getReview } from "@/lib/kv";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const review = await getReview(id);

  if (!review) {
    return NextResponse.json({ error: "Review not found" }, { status: 404 });
  }

  return NextResponse.json(review);
}
```

- [ ] **Step 2: Create the submit decisions API route**

```typescript
// src/app/api/review/[id]/submit/route.ts
import { NextRequest, NextResponse } from "next/server";
import { submitDecisions, getReview } from "@/lib/kv";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const body = await req.json();
  const decisions: Record<string, "accept" | "reject"> = body.decisions;

  if (!decisions || typeof decisions !== "object") {
    return NextResponse.json(
      { error: "decisions is required" },
      { status: 400 }
    );
  }

  const review = await getReview(id);
  if (!review) {
    return NextResponse.json({ error: "Review not found" }, { status: 404 });
  }
  if (review.status !== "pending") {
    return NextResponse.json(
      { error: `Review already ${review.status}` },
      { status: 409 }
    );
  }

  await submitDecisions(id, decisions);

  return NextResponse.json({ ok: true, status: "submitted" });
}
```

- [ ] **Step 3: Create the review table component**

```tsx
// src/components/review-table.tsx
"use client";

import { useState } from "react";
import type { ReviewItem } from "@/lib/types";

interface ReviewTableProps {
  items: ReviewItem[];
  onDecisionsChange: (decisions: Record<string, "accept" | "reject">) => void;
}

export function ReviewTable({ items, onDecisionsChange }: ReviewTableProps) {
  const [decisions, setDecisions] = useState<
    Record<string, "accept" | "reject">
  >(() => {
    const initial: Record<string, "accept" | "reject"> = {};
    for (const item of items) {
      initial[item.name] = "accept";
    }
    return initial;
  });

  function toggle(name: string) {
    const updated = {
      ...decisions,
      [name]: decisions[name] === "accept" ? "reject" as const : "accept" as const,
    };
    setDecisions(updated);
    onDecisionsChange(updated);
  }

  const actionColors: Record<string, string> = {
    exclude: "bg-red-100 text-red-800",
    tag: "bg-yellow-100 text-yellow-800",
    prospect: "bg-green-100 text-green-800",
  };

  return (
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200">
        <thead className="bg-gray-50">
          <tr>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Company</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Titles Seen</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Claude Says</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Category</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Rationale</th>
            <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Decision</th>
          </tr>
        </thead>
        <tbody className="bg-white divide-y divide-gray-200">
          {items.map((item) => (
            <tr key={item.name} className={decisions[item.name] === "reject" ? "bg-gray-50 opacity-60" : ""}>
              <td className="px-4 py-3 text-sm font-medium text-gray-900">{item.name}</td>
              <td className="px-4 py-3 text-sm text-gray-500 max-w-xs truncate">
                {item.titles.slice(0, 5).join(", ")}
                {item.titles.length > 5 && ` +${item.titles.length - 5} more`}
              </td>
              <td className="px-4 py-3">
                <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${actionColors[item.action] || ""}`}>
                  {item.action}
                </span>
              </td>
              <td className="px-4 py-3 text-sm text-gray-500">{item.category || "—"}</td>
              <td className="px-4 py-3 text-sm text-gray-500 max-w-md">{item.rationale}</td>
              <td className="px-4 py-3">
                <button
                  onClick={() => toggle(item.name)}
                  className={`px-3 py-1 text-sm font-medium rounded-md ${
                    decisions[item.name] === "accept"
                      ? "bg-green-600 text-white"
                      : "bg-gray-300 text-gray-700"
                  }`}
                >
                  {decisions[item.name] === "accept" ? "Accept" : "Reject"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

- [ ] **Step 4: Create the submit button component**

```tsx
// src/components/submit-button.tsx
"use client";

import { useState } from "react";

interface SubmitButtonProps {
  reviewId: string;
  decisions: Record<string, "accept" | "reject">;
  onSubmitted: () => void;
}

export function SubmitButton({ reviewId, decisions, onSubmitted }: SubmitButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setLoading(true);
    setError(null);

    try {
      const submitRes = await fetch(`/api/review/${reviewId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisions }),
      });

      if (!submitRes.ok) {
        const data = await submitRes.json();
        throw new Error(data.error || "Submit failed");
      }

      // Trigger commit
      const commitRes = await fetch(`/api/review/${reviewId}/commit`, {
        method: "POST",
      });

      if (!commitRes.ok) {
        const data = await commitRes.json();
        throw new Error(data.error || "Commit failed");
      }

      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  const acceptCount = Object.values(decisions).filter((d) => d === "accept").length;
  const rejectCount = Object.values(decisions).filter((d) => d === "reject").length;

  return (
    <div className="flex items-center gap-4">
      <button
        onClick={handleSubmit}
        disabled={loading}
        className="px-6 py-3 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? "Submitting..." : "Submit Review"}
      </button>
      <span className="text-sm text-gray-500">
        {acceptCount} accepted, {rejectCount} rejected
      </span>
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
```

- [ ] **Step 5: Create the review page**

```tsx
// src/app/review/[id]/page.tsx
"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { ReviewTable } from "@/components/review-table";
import { SubmitButton } from "@/components/submit-button";
import type { ReviewData } from "@/lib/types";

export default function ReviewPage() {
  const params = useParams();
  const id = params.id as string;

  const [review, setReview] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, "accept" | "reject">>({});
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    fetch(`/api/review/${id}`)
      .then((res) => {
        if (!res.ok) throw new Error("Review not found");
        return res.json();
      })
      .then((data: ReviewData) => {
        setReview(data);
        const initial: Record<string, "accept" | "reject"> = {};
        for (const item of data.items) {
          initial[item.name] = "accept";
        }
        setDecisions(initial);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-gray-500">Loading review...</p>
      </main>
    );
  }

  if (error || !review) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-red-600">{error || "Review not found"}</p>
      </main>
    );
  }

  if (review.status === "committed") {
    return (
      <main className="min-h-screen p-8 max-w-7xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Review Complete</h1>
        <p className="text-gray-600">
          This review has been committed.
          {review.commitSummary && (
            <span>
              {" "}{review.commitSummary.exclusionsAdded} exclusions,{" "}
              {review.commitSummary.tagsAdded} tags,{" "}
              {review.commitSummary.prospectsAdded} prospects added.
            </span>
          )}
        </p>
      </main>
    );
  }

  if (submitted || review.status === "submitted") {
    return (
      <main className="min-h-screen p-8 max-w-7xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Review Submitted</h1>
        <p className="text-gray-600">Your decisions have been submitted and are being committed to the repo.</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Review: {review.source}</h1>
        <p className="text-gray-500 mt-1">
          {review.knownResults.length} companies matched automatically.{" "}
          {review.items.length} need your review.
        </p>
      </div>

      <ReviewTable items={review.items} onDecisionsChange={setDecisions} />

      <div className="mt-6 sticky bottom-0 bg-white py-4 border-t">
        <SubmitButton
          reviewId={id}
          decisions={decisions}
          onSubmitted={() => setSubmitted(true)}
        />
      </div>
    </main>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add src/app/review/ src/components/ src/app/api/review/
git commit -m "feat: review UI — table with accept/reject toggles, submit flow"
```

---

### Task 11: Commit Route (Phase 2)

**Files:**
- Create: `reddy-gtm-tools/src/app/api/review/[id]/commit/route.ts`

- [ ] **Step 1: Implement the commit endpoint**

```typescript
// src/app/api/review/[id]/commit/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getReview, markCommitted } from "@/lib/kv";
import { fetchCompanyLists, commitCompanyListUpdates } from "@/lib/github";
import { sendCommitConfirmation } from "@/lib/slack";

export const maxDuration = 60;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const review = await getReview(id);

  if (!review) {
    return NextResponse.json({ error: "Review not found" }, { status: 404 });
  }
  if (review.status !== "submitted") {
    return NextResponse.json(
      { error: `Review must be submitted first. Current status: ${review.status}` },
      { status: 409 }
    );
  }
  if (!review.decisions) {
    return NextResponse.json({ error: "No decisions found" }, { status: 400 });
  }

  // Fetch current company lists
  const lists = await fetchCompanyLists();
  const today = new Date().toISOString().split("T")[0];

  let exclusionsAdded = 0;
  let tagsAdded = 0;
  let prospectsAdded = 0;

  for (const item of review.items) {
    const decision = review.decisions[item.name];
    if (!decision) continue;

    if (decision === "accept") {
      if (item.action === "exclude" && item.category) {
        lists.exclusions.companies.push({
          name: item.name,
          aliases: [],
          category: item.category,
          added: today,
          source: review.source,
        });
        exclusionsAdded++;
      } else if (item.action === "tag" && item.category) {
        lists.tags.companies.push({
          name: item.name,
          aliases: [],
          category: item.category,
          added: today,
          source: review.source,
        });
        tagsAdded++;
      } else if (item.action === "prospect") {
        lists.prospects.companies.push({
          name: item.name,
          aliases: [],
          added: today,
          source: review.source,
          note: item.rationale || "",
        });
        prospectsAdded++;
      }
    } else if (decision === "reject") {
      // Rejected = add to known prospects so Claude doesn't re-flag
      lists.prospects.companies.push({
        name: item.name,
        aliases: [],
        added: today,
        source: review.source,
        note: `Rejected Claude classification: ${item.action}/${item.category}`,
      });
      prospectsAdded++;
    }
  }

  // Commit to GitHub
  const message = `Update company lists from ${review.source} — ${exclusionsAdded} exclusions, ${tagsAdded} tags, ${prospectsAdded} prospects`;

  await commitCompanyListUpdates({
    exclusions: lists.exclusions,
    exclusionsSha: lists.shas.exclusions,
    tags: lists.tags,
    tagsSha: lists.shas.tags,
    prospects: lists.prospects,
    prospectsSha: lists.shas.prospects,
    message,
  });

  // Update KV state
  const summary = { exclusionsAdded, tagsAdded, prospectsAdded };
  await markCommitted(id, summary);

  // Notify Slack
  await sendCommitConfirmation({
    source: review.source,
    ...summary,
  });

  return NextResponse.json({ ok: true, ...summary });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/review/[id]/commit/route.ts
git commit -m "feat: Phase 2 commit route — updates GitHub JSON files from review decisions"
```

---

### Task 12: Webhook Endpoints

**Files:**
- Create: `reddy-gtm-tools/src/app/api/webhook/[source]/route.ts`

- [ ] **Step 1: Implement the webhook handler**

```typescript
// src/app/api/webhook/[source]/route.ts
import { NextRequest, NextResponse } from "next/server";
import { CompanyClassifier } from "@/lib/classifier";
import { fetchCompanyLists } from "@/lib/github";
import { classifyWithAgent } from "@/lib/agent";
import { sendQuickClassification } from "@/lib/slack";

export const maxDuration = 60;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ source: string }> }
) {
  const { source } = await params;
  const body = await req.json();

  // Extract company name from webhook payload
  // Different sources send different shapes
  let companyName: string | undefined;
  let titles: string[] = [];

  switch (source) {
    case "common-room":
      // Common Room webhook shape
      companyName = body.company?.name || body.organization?.name;
      titles = body.person?.title ? [body.person.title] : [];
      break;
    case "apollo":
      companyName = body.organization?.name || body.company_name;
      titles = body.title ? [body.title] : [];
      break;
    case "hubspot":
      companyName = body.properties?.company || body.company;
      titles = body.properties?.jobtitle ? [body.properties.jobtitle] : [];
      break;
    default:
      // Generic: try common field names
      companyName = body.company || body.company_name || body.organization?.name;
      titles = body.title ? [body.title] : body.titles || [];
  }

  if (!companyName) {
    return NextResponse.json(
      { error: "Could not extract company name from webhook payload" },
      { status: 400 }
    );
  }

  // Quick known-match check first
  const lists = await fetchCompanyLists();
  const classifier = new CompanyClassifier(
    lists.exclusions,
    lists.tags,
    lists.prospects
  );

  const known = classifier.classifyKnown(companyName);
  if (known) {
    await sendQuickClassification({
      companyName,
      action: known.action,
      category: known.category,
      confidence: known.confidence,
    });

    return NextResponse.json({
      ...known,
      source,
      webhook: true,
    });
  }

  // Unknown — classify with agent
  const results = await classifyWithAgent([{ name: companyName, titles }]);
  const result = results[0] || {
    name: companyName,
    action: "prospect" as const,
    category: null,
    confidence: "claude" as const,
    rationale: "Unclassified",
  };

  await sendQuickClassification({
    companyName,
    action: result.action,
    category: result.category,
    confidence: result.confidence,
  });

  return NextResponse.json({
    ...result,
    source,
    webhook: true,
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/app/api/webhook/
git commit -m "feat: webhook endpoints for Common Room, Apollo, HubSpot"
```

---

### Task 13: Migrate Existing Exclusion List to JSON

**Files:**
- Create: `reddy-gtm-tools/scripts/migrate-exclusion-list.ts`
- Read: `/Users/adamlevin/Downloads/Reddy-GTM/conference-vendor-exclusion-list.md`

This is a one-time script that reads the existing markdown exclusion list from the Reddy-GTM repo and creates the three JSON files.

- [ ] **Step 1: Write the migration script**

```typescript
// scripts/migrate-exclusion-list.ts
/**
 * One-time migration: convert conference-vendor-exclusion-list.md → JSON files.
 *
 * Usage: npx tsx scripts/migrate-exclusion-list.ts /path/to/conference-vendor-exclusion-list.md
 *
 * Outputs three files to ./company-lists-output/:
 *   exclusions.json, tags.json, known_prospects.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { resolve } from "path";

const SECTION_1_CATEGORIES: Record<string, string> = {
  "CCaaS / Contact Center Platforms": "ccaas",
  "AI / Conversational AI / Voice AI Vendors": "ai_voice",
  "Quality / Analytics / WFM / CX Platforms": "quality_analytics_wfm",
  "Workforce / Training / Knowledge Management": "workforce_training_km",
  "Consulting / Advisory / Systems Integrators": "consulting",
  "Telecom / Infrastructure Vendors": "telecom_infrastructure",
  "Cloud / Big Tech (selling CX/CC solutions)": "cloud_bigtech",
  "CRM / SaaS / Marketing Tech (selling to CC)": "crm_saas_martech",
  "Compliance / Identity / Security (selling to CC)": "compliance_security",
  "Reddy (ourselves)": "self",
};

const SECTION_2_CATEGORIES: Record<string, string> = {
  "Tag: BPO / Outsourcing": "bpo",
  "Tag: Media / Press": "media",
};

interface Company {
  name: string;
  aliases: string[];
  category: string;
  added: string;
  source: string;
}

interface Prospect {
  name: string;
  aliases: string[];
  added: string;
  source: string;
  note: string;
}

const mdPath = process.argv[2];
if (!mdPath) {
  console.error("Usage: npx tsx scripts/migrate-exclusion-list.ts <path-to-md>");
  process.exit(1);
}

const text = readFileSync(resolve(mdPath), "utf-8");

const exclusionCategories: Record<string, { label: string; action: string }> = {};
for (const [label, key] of Object.entries(SECTION_1_CATEGORIES)) {
  exclusionCategories[key] = { label, action: "exclude" };
}

const tagCategories: Record<string, { label: string; action: string }> = {};
for (const [label, key] of Object.entries(SECTION_2_CATEGORIES)) {
  tagCategories[key] = { label: label.replace("Tag: ", ""), action: "tag" };
}

const exclusionCompanies: Company[] = [];
const tagCompanies: Company[] = [];
const prospects: Prospect[] = [];

let currentSection: "exclude" | "tag" | "prospect" | null = null;
let currentCategory: string | null = null;

for (const line of text.split("\n")) {
  const trimmed = line.trim();

  if (trimmed.startsWith("# SECTION 1")) {
    currentSection = "exclude";
    currentCategory = null;
  } else if (trimmed.startsWith("# SECTION 2")) {
    currentSection = "tag";
    currentCategory = null;
  } else if (trimmed.startsWith("# SECTION 3")) {
    currentSection = "prospect";
    currentCategory = null;
  } else if (trimmed.startsWith("## ") && currentSection) {
    const heading = trimmed.slice(3).trim();
    if (currentSection === "exclude") {
      currentCategory = SECTION_1_CATEGORIES[heading] || null;
    } else if (currentSection === "tag") {
      currentCategory = SECTION_2_CATEGORIES[heading] || null;
    }
  } else if (trimmed.startsWith("- ") && currentSection) {
    let name = trimmed.slice(2).trim();
    // Remove parenthetical notes like " (media)"
    if (name.includes(" (") && name.endsWith(")")) {
      name = name.slice(0, name.lastIndexOf(" ("));
    }
    if (!name) continue;

    if (currentSection === "prospect") {
      prospects.push({
        name,
        aliases: [],
        added: "2026-03-28",
        source: "CCW Las Vegas 2025",
        note: "",
      });
    } else if (currentCategory) {
      const entry: Company = {
        name,
        aliases: [],
        category: currentCategory,
        added: "2026-03-28",
        source: "CCW Las Vegas 2025",
      };
      if (currentSection === "exclude") {
        exclusionCompanies.push(entry);
      } else {
        tagCompanies.push(entry);
      }
    }
  }
}

const outDir = resolve("./company-lists-output");
mkdirSync(outDir, { recursive: true });

writeFileSync(
  resolve(outDir, "exclusions.json"),
  JSON.stringify({ categories: exclusionCategories, companies: exclusionCompanies }, null, 2) + "\n"
);
writeFileSync(
  resolve(outDir, "tags.json"),
  JSON.stringify({ categories: tagCategories, companies: tagCompanies }, null, 2) + "\n"
);
writeFileSync(
  resolve(outDir, "known_prospects.json"),
  JSON.stringify({ companies: prospects }, null, 2) + "\n"
);

console.log(`Exclusions: ${exclusionCompanies.length} companies in ${Object.keys(exclusionCategories).length} categories`);
console.log(`Tags: ${tagCompanies.length} companies in ${Object.keys(tagCategories).length} categories`);
console.log(`Prospects: ${prospects.length} companies`);
console.log(`\nOutput written to ${outDir}/`);
```

- [ ] **Step 2: Run the migration**

```bash
cd /Users/adamlevin/Downloads/reddy-gtm-tools
npx tsx scripts/migrate-exclusion-list.ts /Users/adamlevin/Downloads/Reddy-GTM/conference-vendor-exclusion-list.md
```

Expected: Three JSON files in `./company-lists-output/` with counts printed.

- [ ] **Step 3: Copy the JSON files to the Reddy-GTM repo**

```bash
mkdir -p /Users/adamlevin/Downloads/Reddy-GTM/company-lists
cp company-lists-output/*.json /Users/adamlevin/Downloads/Reddy-GTM/company-lists/
```

- [ ] **Step 4: Commit the JSON files to Reddy-GTM**

```bash
cd /Users/adamlevin/Downloads/Reddy-GTM
git add company-lists/
git commit -m "feat: company classification JSON files — migrated from exclusion list"
```

- [ ] **Step 5: Commit the migration script to reddy-gtm-tools**

```bash
cd /Users/adamlevin/Downloads/reddy-gtm-tools
git add scripts/migrate-exclusion-list.ts
git commit -m "chore: one-time migration script for exclusion list MD → JSON"
```

---

### Task 14: Deploy & End-to-End Test

**Files:**
- No new files — deployment and integration testing

- [ ] **Step 1: Create the Vercel project**

```bash
cd /Users/adamlevin/Downloads/reddy-gtm-tools
npx vercel link
```

Follow prompts to create a new Vercel project named `reddy-gtm-tools`.

- [ ] **Step 2: Set environment variables on Vercel**

```bash
vercel env add AI_GATEWAY_API_KEY
vercel env add GITHUB_TOKEN
vercel env add GITHUB_OWNER
vercel env add GITHUB_REPO
vercel env add GITHUB_BRANCH
vercel env add SLACK_BOT_TOKEN
vercel env add SLACK_SIGNING_SECRET
vercel env add SLACK_CHANNEL_ID
```

- [ ] **Step 3: Provision Vercel KV**

In the Vercel dashboard, go to the project → Storage → Create → KV. This auto-populates `KV_REST_API_URL` and `KV_REST_API_TOKEN`.

- [ ] **Step 4: Deploy**

```bash
vercel deploy
```

- [ ] **Step 5: Test the quick check endpoint**

```bash
curl -X POST https://reddy-gtm-tools.vercel.app/api/classify \
  -H "Content-Type: application/json" \
  -d '{"mode": "quick", "company": "Five9"}'
```

Expected: `{"name":"Five9","action":"exclude","category":"ccaas","confidence":"known",...}`

- [ ] **Step 6: Test batch classification with a small file**

Create a test CSV with 5-10 companies (mix of known and unknown), upload via the `/api/classify` endpoint, verify the review link works, submit decisions, verify the commit appears in GitHub.

- [ ] **Step 7: Run against the full CCW list**

Upload the CCW Las Vegas 2025 attendee list via Slack or the classify endpoint. Verify the full pipeline: known matching → agent classification → Slack notification → review UI → submit → GitHub commit.

- [ ] **Step 8: Commit final deploy config**

```bash
cd /Users/adamlevin/Downloads/reddy-gtm-tools
git add .
git commit -m "chore: Vercel deployment configuration"
```

---

## Summary

| Task | What it builds | Key files |
|---|---|---|
| 1 | Next.js scaffold + deps | `package.json`, `src/app/` |
| 2 | Shared types | `src/lib/types.ts` |
| 3 | GitHub read/write | `src/lib/github.ts` |
| 4 | Known company matching | `src/lib/classifier.ts` |
| 5 | Vercel KV state | `src/lib/kv.ts` |
| 6 | Claude agent + prompt | `src/lib/agent.ts`, `src/lib/prompts.ts` |
| 7 | File parsing | `src/lib/parse-upload.ts` |
| 8 | Slack integration | `src/lib/slack.ts`, `api/slack/events/` |
| 9 | Core pipeline API | `api/classify/route.ts` |
| 10 | Review UI | `review/[id]/page.tsx`, components |
| 11 | Phase 2 commit | `api/review/[id]/commit/route.ts` |
| 12 | Webhooks | `api/webhook/[source]/route.ts` |
| 13 | Data migration | `scripts/migrate-exclusion-list.ts` |
| 14 | Deploy & test | Vercel config, E2E verification |
