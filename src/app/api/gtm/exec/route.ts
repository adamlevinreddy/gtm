import { NextRequest, NextResponse } from "next/server";
import type { tagmanager_v2 } from "googleapis";
import {
  ensureAgentWorkspace,
  createTag,
  updateTag,
  createTrigger,
  updateTrigger,
  createVersion,
  publishVersion,
  listTagsLive,
  listTriggersLive,
  listVariablesLive,
  listVersionHeaders,
  getLiveVersion,
  enableBuiltInVariables,
  deleteWorkspace,
  listWorkspaces,
} from "@/lib/gtm";

export const maxDuration = 60;

// POST /api/gtm/exec — flexible write/read endpoint for the agent. Ops:
//
//   Read-only:
//   - "listTags" | "listTriggers" | "listVariables" | "listVersions" | "getLive"
//
//   Write (workspace-scoped, safe — does NOT go live):
//   - "ensureWorkspace" { name? }
//   - "createTag"    { workspaceId, tag: Schema$Tag }
//   - "updateTag"    { workspaceId, tagId, tag: Schema$Tag }
//   - "createTrigger"{ workspaceId, trigger: Schema$Trigger }
//   - "updateTrigger"{ workspaceId, triggerId, trigger: Schema$Trigger }
//   - "createVersion"{ workspaceId, name, notes? } — snapshot for human review
//
//   Destructive (requires explicit user signal — agent must NOT call without
//   confirmation in Slack):
//   - "publishVersion" { versionId } — makes the version LIVE on reddy.io
type Op =
  | { op: "listTags" }
  | { op: "listTriggers" }
  | { op: "listVariables" }
  | { op: "listVersions" }
  | { op: "getLive" }
  | { op: "ensureWorkspace"; name?: string }
  | { op: "createTag"; workspaceId: string; tag: tagmanager_v2.Schema$Tag }
  | { op: "updateTag"; workspaceId: string; tagId: string; tag: tagmanager_v2.Schema$Tag }
  | { op: "createTrigger"; workspaceId: string; trigger: tagmanager_v2.Schema$Trigger }
  | { op: "updateTrigger"; workspaceId: string; triggerId: string; trigger: tagmanager_v2.Schema$Trigger }
  | { op: "createVersion"; workspaceId: string; name: string; notes?: string }
  | { op: "publishVersion"; versionId: string }
  | { op: "enableBuiltInVariables"; workspaceId: string; types: string[] }
  | { op: "listWorkspaces" }
  | { op: "deleteWorkspace"; workspaceId: string };

export async function POST(req: NextRequest) {
  let body: Op;
  try {
    body = (await req.json()) as Op;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  try {
    switch (body.op) {
      case "listTags":          return NextResponse.json({ ok: true, data: await listTagsLive() });
      case "listTriggers":      return NextResponse.json({ ok: true, data: await listTriggersLive() });
      case "listVariables":     return NextResponse.json({ ok: true, data: await listVariablesLive() });
      case "listVersions":      return NextResponse.json({ ok: true, data: await listVersionHeaders() });
      case "getLive":           return NextResponse.json({ ok: true, data: await getLiveVersion() });
      case "ensureWorkspace":   return NextResponse.json({ ok: true, data: await ensureAgentWorkspace(body.name) });
      case "createTag":         return NextResponse.json({ ok: true, data: await createTag(body.workspaceId, body.tag) });
      case "updateTag":         return NextResponse.json({ ok: true, data: await updateTag(body.workspaceId, body.tagId, body.tag) });
      case "createTrigger":     return NextResponse.json({ ok: true, data: await createTrigger(body.workspaceId, body.trigger) });
      case "updateTrigger":     return NextResponse.json({ ok: true, data: await updateTrigger(body.workspaceId, body.triggerId, body.trigger) });
      case "createVersion":     return NextResponse.json({ ok: true, data: await createVersion(body.workspaceId, body.name, body.notes) });
      case "publishVersion":    return NextResponse.json({ ok: true, data: await publishVersion(body.versionId) });
      case "enableBuiltInVariables": return NextResponse.json({ ok: true, data: await enableBuiltInVariables(body.workspaceId, body.types) });
      case "listWorkspaces":    return NextResponse.json({ ok: true, data: await listWorkspaces() });
      case "deleteWorkspace":   return NextResponse.json({ ok: true, data: await deleteWorkspace(body.workspaceId) });
      default:
        return NextResponse.json({ ok: false, error: `unknown op` }, { status: 400 });
    }
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
