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
  const base = process.env.PUBLIC_BASE_URL ?? "https://reddy-gtm.com";
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

    return NextResponse.json({ ok: false, error: `unknown step '${step}'` }, { status: 400 });
  } catch (err) {
    return NextResponse.json(
      { ok: false, step, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
