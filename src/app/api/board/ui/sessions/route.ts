import { NextRequest, NextResponse } from "next/server";
import { createSession, listSessions, type SessionScope } from "@/lib/sessions";
import { verifyViewerCookie } from "@/lib/viewer";
import { VIEWER_COOKIE } from "@/lib/team";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Sessions collection (Daybreak Phase 8): GET = sessions, POST = create one.
// Cookie-gated. GET defaults to the viewer's own but ?who=<email>|all widens
// to a teammate or the whole team (sales is a team sport).

function viewer(req: NextRequest): string | null {
  return verifyViewerCookie(req.cookies.get(VIEWER_COOKIE)?.value);
}

export async function GET(req: NextRequest) {
  const v = viewer(req);
  if (!v) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const who = req.nextUrl.searchParams.get("who");
  const owner = who === "all" ? undefined : who || v;
  const sessions = await listSessions({ owner }).catch(() => []);
  return NextResponse.json({ ok: true, sessions });
}

export async function POST(req: NextRequest) {
  const v = viewer(req);
  if (!v) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { title?: string; scope?: SessionScope } | null;
  if (!body?.title) return NextResponse.json({ ok: false, error: "missing title" }, { status: 400 });
  const scope: SessionScope = body.scope
    ? {
        botIds: Array.isArray(body.scope.botIds)
          ? body.scope.botIds.filter((b): b is string => typeof b === "string").slice(0, 250)
          : undefined,
        note: typeof body.scope.note === "string" ? body.scope.note.slice(0, 300) : undefined,
        label: typeof body.scope.label === "string" ? body.scope.label.slice(0, 120) : undefined,
      }
    : null;
  const session = await createSession({ viewer: v, title: body.title, scope });
  return NextResponse.json({ ok: true, session });
}
