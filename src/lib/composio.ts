import { Composio } from "@composio/core";

// Thin wrapper around the Composio SDK calls Reddy-GTM needs.
// One shared client per process; Composio docs say it's safe to reuse.
let _client: Composio | null = null;
export function composio() {
  if (_client) return _client;
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) throw new Error("COMPOSIO_API_KEY not set");
  _client = new Composio({ apiKey });
  return _client;
}

// Slack-user-email is our canonical user_id across toolkits.
export type ComposioUserId = string;

// All toolkits Reddy-GTM can surface. Each has a Composio slug (the
// toolkit identifier Composio uses) + a human-friendly label + a
// category (which drives ordering in the "set me up" DM).
//
// Auth config IDs are env-driven — if COMPOSIO_AUTH_CONFIG_{SLUG} is
// unset, the toolkit is hidden from the menu. This lets users add new
// services without code changes (e.g., you enable HubSpot today, add
// DocuSign next month).
export type ToolkitSlug =
  | "gmail"
  | "googlecalendar"
  | "googledrive"
  | "googlesheets"
  | "googledocs"
  | "hubspot"
  | "linkedin"
  | "apollo"
  | "docusign";

type ToolkitMeta = {
  slug: ToolkitSlug;
  label: string;
  category: "google" | "work" | "company";
  envVar: string;
};

export const TOOLKITS: ReadonlyArray<ToolkitMeta> = [
  { slug: "gmail",          label: "Gmail",            category: "google",  envVar: "COMPOSIO_AUTH_CONFIG_GMAIL" },
  { slug: "googlecalendar", label: "Google Calendar",  category: "google",  envVar: "COMPOSIO_AUTH_CONFIG_GCAL" },
  { slug: "googledrive",    label: "Google Drive",     category: "google",  envVar: "COMPOSIO_AUTH_CONFIG_GDRIVE" },
  { slug: "googlesheets",   label: "Google Sheets",    category: "google",  envVar: "COMPOSIO_AUTH_CONFIG_GSHEETS" },
  { slug: "googledocs",     label: "Google Docs",      category: "google",  envVar: "COMPOSIO_AUTH_CONFIG_GDOCS" },
  { slug: "hubspot",        label: "HubSpot",          category: "work",    envVar: "COMPOSIO_AUTH_CONFIG_HUBSPOT" },
  { slug: "linkedin",       label: "LinkedIn",         category: "work",    envVar: "COMPOSIO_AUTH_CONFIG_LINKEDIN" },
  { slug: "apollo",         label: "Apollo",           category: "company", envVar: "COMPOSIO_AUTH_CONFIG_APOLLO" },
  { slug: "docusign",       label: "DocuSign",         category: "company", envVar: "COMPOSIO_AUTH_CONFIG_DOCUSIGN" },
];

// Toolkits that the operator has set up auth configs for. Missing env
// var → toolkit is not yet available; hidden from the set-me-up menu.
export function availableToolkits(): ToolkitMeta[] {
  return TOOLKITS.filter((t) => !!process.env[t.envVar]);
}

function authConfigIdFor(slug: ToolkitSlug): string | null {
  const meta = TOOLKITS.find((t) => t.slug === slug);
  if (!meta) return null;
  return process.env[meta.envVar] ?? null;
}

// Kick off the OAuth flow for a user + toolkit. Returns the consent URL.
export async function initiateConnection(
  userId: ComposioUserId,
  slug: ToolkitSlug,
  callbackUrl?: string,
): Promise<{ redirectUrl: string; connectedAccountId: string }> {
  const authConfigId = authConfigIdFor(slug);
  if (!authConfigId) throw new Error(`No auth config for ${slug} (env: COMPOSIO_AUTH_CONFIG_${slug.toUpperCase()})`);
  const req = await composio().connectedAccounts.initiate(userId, authConfigId, callbackUrl ? { callbackUrl } : undefined);
  return {
    redirectUrl: (req as { redirectUrl: string }).redirectUrl,
    connectedAccountId: (req as { id: string }).id,
  };
}

// One list call returns connection status for all toolkits we care about.
export async function getConnectionStatus(
  userId: ComposioUserId,
): Promise<Record<ToolkitSlug, boolean>> {
  const slugs = availableToolkits().map((t) => t.slug);
  if (slugs.length === 0) {
    return Object.fromEntries(TOOLKITS.map((t) => [t.slug, false])) as Record<ToolkitSlug, boolean>;
  }
  const list = await composio().connectedAccounts.list({
    userIds: [userId],
    toolkitSlugs: slugs,
  });
  const items = (list as { items?: Array<{ status?: string; toolkit?: { slug?: string } }> }).items ?? [];
  const active = new Set(
    items.filter((a) => a.status === "ACTIVE").map((a) => a.toolkit?.slug).filter(Boolean) as string[],
  );
  return Object.fromEntries(TOOLKITS.map((t) => [t.slug, active.has(t.slug)])) as Record<ToolkitSlug, boolean>;
}

// Generate the per-user MCP URL. The MCP config (bundling whichever
// toolkits we want exposed to the agent) is created once in the Composio
// dashboard; we store its ID in env.
export async function generateMcpUrl(userId: ComposioUserId): Promise<{
  url: string;
  headers: Record<string, string>;
} | null> {
  const mcpConfigId = process.env.COMPOSIO_MCP_CONFIG_ID;
  if (!mcpConfigId) return null;
  try {
    const mcp = await (composio() as unknown as {
      experimental: { mcp: { generate: (u: string, c: string) => Promise<{ url: string; headers: Record<string, string> }> } };
    }).experimental.mcp.generate(userId, mcpConfigId);
    return { url: mcp.url, headers: mcp.headers };
  } catch (err) {
    console.error(`[composio] mcp.generate failed for ${userId}:`, err instanceof Error ? err.message : err);
    return null;
  }
}
