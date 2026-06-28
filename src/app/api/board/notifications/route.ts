import { NextRequest, NextResponse } from "next/server";
import { assertBoardAuth } from "@/lib/board-auth";
import { badRequest, unauthorized } from "../_lib";
import {
  listNotifications,
  unreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
} from "@/lib/board-world";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * POST /api/board/notifications
 * Auth: board secret + actor. The recipient is ALWAYS the authenticated actor.
 * Dispatches on `action`:
 *  - { action:'list', unreadOnly? }   → { ok, notifications, unreadCount }
 *  - { action:'markRead', id }        → { ok, marked }
 *  - { action:'markAllRead' }         → { ok, marked }  (count)
 */
export async function POST(req: NextRequest) {
  const actor = assertBoardAuth(req);
  if (!actor) return unauthorized();

  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    id?: string;
    unreadOnly?: boolean;
  };

  switch (body.action) {
    case "list": {
      const [notifications, unreadCount] = await Promise.all([
        listNotifications(actor, body.unreadOnly ?? false),
        unreadNotificationCount(actor),
      ]);
      return NextResponse.json({ ok: true, notifications, unreadCount });
    }
    case "markRead": {
      if (!body.id) return badRequest("missing id");
      const marked = await markNotificationRead(body.id);
      return NextResponse.json({ ok: true, marked });
    }
    case "markAllRead": {
      const marked = await markAllNotificationsRead(actor);
      return NextResponse.json({ ok: true, marked });
    }
    default:
      return badRequest("unknown action");
  }
}
