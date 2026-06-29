import { NextRequest, NextResponse } from "next/server";
import { composio, initiateConnection, getConnectionStatus } from "@/lib/composio";
import { BOT_ADDR } from "@/lib/bot-mail";

// One-time setup for the bot@reddy.io Gmail lane. Internal-auth only.
//   POST {step:"connect"} → returns a Google consent URL; open it while signed
//      into bot@reddy.io to grant Composio Gmail (send + read) access.
//   POST {step:"status"}  → whether bot@reddy.io's Gmail is connected.
//   POST {step:"arm"}     → registers this app's webhook + creates the Gmail
//      new-message trigger for bot@reddy.io (run AFTER connect succeeds).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60;

function webhookUrl(): string {
  const base = process.env.PUBLIC_BASE_URL ?? "https://gtm-jet.vercel.app";
  return `${base}/api/webhooks/composio`;
}

export async function POST(req: NextRequest) {
  const secret = process.env.MCP_INTERNAL_SECRET;
  if (!secret || req.headers.get("x-reddy-internal") !== secret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => ({}))) as { step?: string };
  const step = body.step ?? "status";

  try {
    if (step === "connect") {
      const { redirectUrl, connectedAccountId } = await initiateConnection(BOT_ADDR, "gmail");
      return NextResponse.json({
        ok: true,
        step,
        connectedAccountId,
        redirectUrl,
        instructions: `Open redirectUrl in a browser signed into ${BOT_ADDR}, grant access, then POST {step:"arm"}.`,
      });
    }

    if (step === "status") {
      const status = await getConnectionStatus(BOT_ADDR);
      return NextResponse.json({ ok: true, step, botAddress: BOT_ADDR, gmailConnected: !!status.gmail, status });
    }

    if (step === "arm") {
      const status = await getConnectionStatus(BOT_ADDR);
      if (!status.gmail) {
        return NextResponse.json(
          { ok: false, error: `${BOT_ADDR} Gmail not connected yet — run step:"connect" first.` },
          { status: 409 }
        );
      }
      // Register where Composio POSTs trigger events.
      const sub = await composio().triggers.setWebhookSubscription({ webhookUrl: webhookUrl() });
      // Resolve the Gmail new-message trigger slug (don't hardcode).
      const types = (await composio().triggers.listTypes({ toolkits: ["gmail"] })) as {
        items?: Array<{ slug?: string; name?: string }>;
      };
      const items = types.items ?? [];
      const match =
        items.find((t) => /NEW.*(GMAIL_)?MESSAGE/i.test(t.slug ?? "")) ??
        items.find((t) => /new/i.test(t.slug ?? "") && /message/i.test(t.slug ?? ""));
      const slug = match?.slug ?? "GMAIL_NEW_GMAIL_MESSAGE";
      const trigger = await composio().triggers.create(BOT_ADDR, slug);
      return NextResponse.json({
        ok: true,
        step,
        webhookUrl: webhookUrl(),
        subscription: sub,
        triggerSlug: slug,
        availableGmailTriggers: items.map((t) => t.slug).filter(Boolean),
        trigger,
      });
    }

    if (step === "diag") {
      // Temporary: exercise the exact Composio calls sendBotEmail + fetchAuthResults
      // use, returning raw results/errors so we can see WHY a live send failed.
      const b = body as { messageId?: string };
      const msgId = b.messageId ?? "19f158066d325dcb";
      type ToolRes = { successful?: boolean; error?: unknown; data?: Record<string, unknown> };
      type ExecExtra = { version?: string; dangerouslySkipVersionCheck?: boolean };
      const tryTool = async (slug: string, args: Record<string, unknown>, extra: ExecExtra = {}) => {
        try {
          const r = (await composio().tools.execute(slug, { userId: BOT_ADDR, arguments: args, ...extra })) as ToolRes;
          return { ok: r?.successful ?? null, error: r?.error ?? null };
        } catch (e) {
          return { threw: e instanceof Error ? e.message : String(e) };
        }
      };
      const out: Record<string, unknown> = {};
      try {
        const list = (await composio().connectedAccounts.list({ userIds: [BOT_ADDR], toolkitSlugs: ["gmail"] })) as {
          items?: Array<{ id?: string; status?: string }>;
        };
        out.connections = (list.items ?? []).map((a) => ({ id: a.id, status: a.status }));
      } catch (e) {
        out.connections_error = e instanceof Error ? e.message : String(e);
      }
      // Probe version strategies on a READ-ONLY fetch (no emails) to find which
      // clears "Toolkit version not specified": (a) constructor global "latest",
      // (b) per-call version "latest", (c) dangerouslySkipVersionCheck.
      const fa = { message_id: msgId, format: "minimal" };
      out.fetch_global = await tryTool("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", fa);
      out.fetch_version_latest = await tryTool("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", fa, { version: "latest" });
      out.fetch_skipcheck = await tryTool("GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID", fa, { dangerouslySkipVersionCheck: true });
      return NextResponse.json({ ok: true, step, out });
    }

    return NextResponse.json({ ok: false, error: `unknown step '${step}'` }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, step, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
