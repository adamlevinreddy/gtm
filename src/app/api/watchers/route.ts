import { NextRequest, NextResponse } from "next/server";
import { addWatch, listWatches, getWatch, cancelWatch, snoozeWatch, type WatchSignal, type WatchStatus } from "@/lib/watchers";
import { resolveApiViewer } from "@/lib/viewer";

// Conditional-follow-up ("watch") API.
//   POST  — create a watch. Called by the sandbox agent (x-board-secret) when a
//           user asks in chat to set up a conditional follow-up, and reusable by
//           the post-meeting "arm" button. Server-to-server only.
//   GET    — list a viewer's watches (board_viewer cookie) for a management view.
//   DELETE — cancel one (?id=), viewer-gated.

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SIGNALS: WatchSignal[] = ["no_reply", "no_activity", "time_only"];
const MAX_HORIZON_MS = 90 * 24 * 60 * 60 * 1000; // sanity cap: check within ~90 days
const MAX_PENDING_PER_OWNER = 25; // guard against a runaway agent / dupes

type CreateBody = {
  owner?: unknown;
  account?: unknown;
  domain?: unknown;
  botId?: unknown;
  play?: unknown;
  signal?: unknown;
  note?: unknown;
  slackChannel?: unknown;
  slackThreadTs?: unknown;
  // when to check: an ISO date/time, epoch ms, or a relative day count.
  checkAfter?: unknown;
  inDays?: unknown;
  // "since" for the signal; defaults to now.
  anchor?: unknown;
};

function toMs(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

export async function POST(req: NextRequest) {
  const secret = process.env.BOARD_API_SECRET;
  if (!secret || req.headers.get("x-board-secret") !== secret) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  let b: CreateBody;
  try {
    b = (await req.json()) as CreateBody;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const owner = typeof b.owner === "string" && b.owner.includes("@") ? b.owner.toLowerCase() : null;
  const signal = SIGNALS.includes(b.signal as WatchSignal) ? (b.signal as WatchSignal) : null;
  const note = typeof b.note === "string" ? b.note.slice(0, 500) : "";
  if (!owner || !signal || !note) {
    return NextResponse.json({ ok: false, error: "need owner (email), signal (no_reply|no_activity|time_only), note" }, { status: 400 });
  }

  const now = Date.now();
  let checkAfter =
    toMs(b.checkAfter) ??
    (typeof b.inDays === "number" && b.inDays > 0 ? now + b.inDays * 24 * 60 * 60 * 1000 : null);
  if (!checkAfter) return NextResponse.json({ ok: false, error: "need checkAfter (ISO/ms) or inDays" }, { status: 400 });
  // Clamp: never in the past (min +1h so a same-day arm doesn't fire instantly), never absurdly far out.
  checkAfter = Math.min(Math.max(checkAfter, now + 60 * 60 * 1000), now + MAX_HORIZON_MS);

  const account = typeof b.account === "string" && b.account.trim() ? b.account.trim() : null;
  const domain = typeof b.domain === "string" && b.domain.trim() ? b.domain.trim().toLowerCase() : null;

  // Cap active watches per owner (runaway-agent / duplicate guard).
  const pending = await listWatches({ owner, status: "pending" }).catch(() => []);
  if (pending.length >= MAX_PENDING_PER_OWNER) {
    return NextResponse.json(
      { ok: false, error: `you already have ${pending.length} active follow-up watches (max ${MAX_PENDING_PER_OWNER}) — cancel some first` },
      { status: 429 },
    );
  }

  const w = await addWatch({
    owner,
    account,
    domain,
    botId: typeof b.botId === "string" && b.botId ? b.botId : null,
    slackChannel: typeof b.slackChannel === "string" && b.slackChannel ? b.slackChannel : null,
    slackThreadTs: typeof b.slackThreadTs === "string" && b.slackThreadTs ? b.slackThreadTs : null,
    play: typeof b.play === "string" && b.play ? b.play : "recap_email",
    signal,
    checkAfter,
    anchor: toMs(b.anchor) ?? now,
    note,
  });
  return NextResponse.json({ ok: true, watch: { id: w.id, account: w.account, signal: w.signal, checkAfter: w.checkAfter, note: w.note } });
}

export async function GET(req: NextRequest) {
  const viewer = resolveApiViewer(req);
  if (!viewer) return NextResponse.json({ ok: false, error: "sign in required" }, { status: 401 });
  const status = req.nextUrl.searchParams.get("status");
  // Owner-scoped only — a viewer sees their own watches, never the team's.
  const watches = await listWatches({
    owner: viewer,
    ...(status ? { status: status as WatchStatus } : {}),
  }).catch(() => []);
  return NextResponse.json({ ok: true, watches });
}

export async function DELETE(req: NextRequest) {
  const viewer = resolveApiViewer(req);
  if (!viewer) return NextResponse.json({ ok: false, error: "sign in required" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ ok: false, error: "need id" }, { status: 400 });
  // Only the owner can cancel their watch (no cross-user IDOR).
  const existing = await getWatch(id);
  if (!existing) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  if (existing.owner !== viewer) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const w = await cancelWatch(id);
  return NextResponse.json({ ok: !!w, watch: w });
}

// Snooze a watch (push its check date out). Owner-scoped.
export async function PATCH(req: NextRequest) {
  const viewer = resolveApiViewer(req);
  if (!viewer) return NextResponse.json({ ok: false, error: "sign in required" }, { status: 401 });
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ ok: false, error: "need id" }, { status: 400 });
  const daysRaw = Number(req.nextUrl.searchParams.get("days") ?? "3");
  const days = Number.isFinite(daysRaw) ? Math.min(Math.max(Math.round(daysRaw), 1), 90) : 3;
  const existing = await getWatch(id);
  if (!existing) return NextResponse.json({ ok: false, error: "not found" }, { status: 404 });
  if (existing.owner !== viewer) return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  const w = await snoozeWatch(id, days);
  return NextResponse.json({ ok: !!w, watch: w });
}
