import { google, tagmanager_v2 } from "googleapis";

// Read + write access to the GTM container. Uses a GCP service account
// that's been granted Edit (or Publish) role on the container in GTM's
// user management. All three env vars are required:
// - GCP_SA_KEY_JSON: single-line minified JSON for the service account
// - GTM_ACCOUNT_ID:  numeric account ID (NOT the public "GTM-XXXX" string)
// - GTM_CONTAINER_ID: numeric container ID (NOT "GTM-5ZZPN9R2")
//
// Scope set includes write so the agent can stage changes; the skill
// guardrails forbid auto-publish without an explicit user signal.
const SCOPES = [
  "https://www.googleapis.com/auth/tagmanager.edit.containers",
  "https://www.googleapis.com/auth/tagmanager.edit.containerversions",
  "https://www.googleapis.com/auth/tagmanager.publish",
];

let _auth: InstanceType<typeof google.auth.GoogleAuth> | null = null;
function auth() {
  if (_auth) return _auth;
  const keyJson = process.env.GCP_SA_KEY_JSON;
  if (!keyJson) throw new Error("GCP_SA_KEY_JSON not set");
  const credentials = JSON.parse(keyJson);
  _auth = new google.auth.GoogleAuth({ credentials, scopes: SCOPES });
  return _auth;
}

function tm() {
  return google.tagmanager({ version: "v2", auth: auth() });
}

function containerPath() {
  const a = process.env.GTM_ACCOUNT_ID;
  const c = process.env.GTM_CONTAINER_ID;
  if (!a || !c) throw new Error("GTM_ACCOUNT_ID and GTM_CONTAINER_ID required");
  return `accounts/${a}/containers/${c}`;
}

// ────────── Read helpers ──────────

export async function getContainer() {
  const res = await tm().accounts.containers.get({ path: containerPath() });
  return res.data;
}

export async function getLiveVersion(): Promise<tagmanager_v2.Schema$ContainerVersion> {
  const res = await tm().accounts.containers.versions.live({ parent: containerPath() });
  return res.data;
}

export async function listTagsLive() {
  return (await getLiveVersion()).tag ?? [];
}
export async function listTriggersLive() {
  return (await getLiveVersion()).trigger ?? [];
}
export async function listVariablesLive() {
  return (await getLiveVersion()).variable ?? [];
}

export async function listWorkspaces() {
  const res = await tm().accounts.containers.workspaces.list({ parent: containerPath() });
  return res.data.workspace ?? [];
}

export async function listVersionHeaders() {
  const res = await tm().accounts.containers.version_headers.list({ parent: containerPath() });
  return res.data.containerVersionHeader ?? [];
}

// ────────── Audit helpers (bake in the specific findings we flagged) ──────────

const EXPECTED_CTA_EVENT_NAMES = [
  "get_reddy_click", "book_a_demo_click", "play_demo_video",
  "learn_more_click", "cta_click", "button_click",
  "scroll_depth", "form_submit", "generate_lead", "video_start",
];

export async function auditNamedCTAs() {
  const tags = await listTagsLive();
  const findings: Record<string, { present: boolean; tagIds: string[] }> = {};
  for (const want of EXPECTED_CTA_EVENT_NAMES) {
    const matches = tags.filter((t) => {
      const nameMatch = (t.name ?? "").toLowerCase().includes(want);
      const eventNameParam = t.parameter?.find((p) => p.key === "eventName")?.value;
      const eventMatch = (eventNameParam ?? "").toLowerCase() === want.toLowerCase();
      return nameMatch || eventMatch;
    });
    findings[want] = { present: matches.length > 0, tagIds: matches.map((t) => t.tagId!).filter(Boolean) };
  }
  return findings;
}

export async function auditConversionTrigger() {
  const triggers = await listTriggersLive();
  const convCandidates = triggers.filter((t) => {
    const name = (t.name ?? "").toLowerCase();
    return name.includes("demo") || name.includes("conversion") || name.includes("booking") || name.includes("lead");
  });
  return convCandidates.map((t) => ({
    id: t.triggerId,
    name: t.name,
    type: t.type,
    filter: t.filter,
    customEventFilter: t.customEventFilter,
  }));
}

export async function auditScrollDepth() {
  const triggers = await listTriggersLive();
  const scrollTriggers = triggers.filter((t) => t.type === "scrollDepth");
  return scrollTriggers.map((t) => ({
    id: t.triggerId,
    name: t.name,
    parameter: t.parameter,
  }));
}

// Summary for the agent — one call returns the triage-relevant snapshot.
export async function auditDump() {
  const [container, liveVersion, namedCTAs, conversionTriggers, scrollTriggers] = await Promise.all([
    getContainer(),
    getLiveVersion(),
    auditNamedCTAs(),
    auditConversionTrigger(),
    auditScrollDepth(),
  ]);
  return {
    container: {
      containerId: container.containerId,
      publicId: container.publicId,
      name: container.name,
      usageContext: container.usageContext,
    },
    liveVersion: {
      containerVersionId: liveVersion.containerVersionId,
      name: liveVersion.name,
      tagCount: liveVersion.tag?.length ?? 0,
      triggerCount: liveVersion.trigger?.length ?? 0,
      variableCount: liveVersion.variable?.length ?? 0,
    },
    allTags: (liveVersion.tag ?? []).map((t) => ({
      id: t.tagId, name: t.name, type: t.type,
      firingTriggerIds: t.firingTriggerId,
    })),
    namedCTAs,
    conversionTriggers,
    scrollTriggers,
  };
}

// ────────── Write helpers (workspace-based — never modifies live directly) ──────────

export async function ensureAgentWorkspace(
  name: string = `reddy-gtm-agent-${new Date().toISOString().slice(0, 10)}`,
): Promise<tagmanager_v2.Schema$Workspace> {
  const existing = await listWorkspaces();
  const match = existing.find((w) => w.name === name);
  if (match) return match;
  const res = await tm().accounts.containers.workspaces.create({
    parent: containerPath(),
    requestBody: { name, description: "Reddy-GTM agent staging workspace" },
  });
  return res.data;
}

function wsPath(workspaceId: string) {
  return `${containerPath()}/workspaces/${workspaceId}`;
}

export async function createTag(workspaceId: string, body: tagmanager_v2.Schema$Tag) {
  const res = await tm().accounts.containers.workspaces.tags.create({
    parent: wsPath(workspaceId),
    requestBody: body,
  });
  return res.data;
}

export async function updateTag(workspaceId: string, tagId: string, body: tagmanager_v2.Schema$Tag) {
  const res = await tm().accounts.containers.workspaces.tags.update({
    path: `${wsPath(workspaceId)}/tags/${tagId}`,
    requestBody: body,
  });
  return res.data;
}

export async function createTrigger(workspaceId: string, body: tagmanager_v2.Schema$Trigger) {
  const res = await tm().accounts.containers.workspaces.triggers.create({
    parent: wsPath(workspaceId),
    requestBody: body,
  });
  return res.data;
}

export async function updateTrigger(workspaceId: string, triggerId: string, body: tagmanager_v2.Schema$Trigger) {
  const res = await tm().accounts.containers.workspaces.triggers.update({
    path: `${wsPath(workspaceId)}/triggers/${triggerId}`,
    requestBody: body,
  });
  return res.data;
}

// Stage a change for human review — create a version from the workspace but
// DO NOT publish. User must publish in the GTM UI.
export async function createVersion(workspaceId: string, name: string, notes?: string) {
  const res = await tm().accounts.containers.workspaces.create_version({
    path: wsPath(workspaceId),
    requestBody: { name, notes: notes ?? "Staged by Reddy-GTM agent — review before publishing" },
  });
  return res.data;
}

// EXPLICIT publish — agent should only call this when user says so.
// Returns the published version.
export async function publishVersion(versionId: string) {
  const res = await tm().accounts.containers.versions.publish({
    path: `${containerPath()}/versions/${versionId}`,
  });
  return res.data;
}

// Enable one or more GTM built-in variables in a workspace. Type names
// follow Google's enum — common ones: "scrollDepthThreshold",
// "scrollDepthUnits", "scrollDirection", "formClasses", "formElement",
// "formId", "videoCurrentTime", "videoDuration", etc.
export async function enableBuiltInVariables(workspaceId: string, types: string[]) {
  const res = await tm().accounts.containers.workspaces.built_in_variables.create({
    parent: wsPath(workspaceId),
    type: types,
  });
  return res.data;
}
