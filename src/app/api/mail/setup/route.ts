import { NextRequest, NextResponse } from "next/server";
import { composio, initiateConnection, getConnectionStatus } from "@/lib/composio";
import { BOT_ADDR } from "@/lib/bot-mail";
import { commitToKb, readKbFile, KB_REPO } from "@/lib/github-kb";

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

    if (step === "toolschema") {
      // Read-only: confirm the exact input param names (cc / attachment) for the
      // Gmail send tools so reply-all + future attachments use the right keys.
      const tools = composio().tools as unknown as {
        getRawComposioToolBySlug: (slug: string, opts?: unknown) => Promise<{
          inputParameters?: { properties?: Record<string, unknown>; required?: string[] };
        }>;
      };
      const out: Record<string, unknown> = {};
      for (const slug of ["GMAIL_SEND_EMAIL", "GMAIL_REPLY_TO_THREAD"]) {
        try {
          const t = await tools.getRawComposioToolBySlug(slug);
          out[slug] = {
            params: Object.keys(t?.inputParameters?.properties ?? {}),
            required: t?.inputParameters?.required ?? [],
          };
        } catch (e) {
          out[slug] = { threw: e instanceof Error ? e.message : String(e) };
        }
      }
      return NextResponse.json({ ok: true, step, out });
    }

    if (step === "attachprobe") {
      // One-shot probe that settles every risky unknown for the attachment build:
      // (1) the `attachment` param schema, (2) File + files.upload in this runtime,
      // (3) KB binary round-trip (readKbFile corrupts vs raw read), (4) a real
      // end-to-end attach-send to adam@reddy.io.
      const out: Record<string, unknown> = {};
      const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;

      // 1) attachment param schema
      try {
        const tools = composio().tools as unknown as {
          getRawComposioToolBySlug: (s: string, o?: unknown) => Promise<{ inputParameters?: { properties?: Record<string, unknown> } }>;
        };
        const t = await tools.getRawComposioToolBySlug("GMAIL_SEND_EMAIL");
        out.attachmentSchema = t?.inputParameters?.properties?.attachment ?? null;
      } catch (e) {
        out.attachmentSchema_err = e instanceof Error ? e.message : String(e);
      }

      // 2) File constructibility + files API is the real (node) class, not the workerd proxy
      try {
        const f = new File([Buffer.from("test")], "probe.txt", { type: "text/plain" });
        const filesApi = (composio() as unknown as { files?: { upload?: unknown } }).files;
        out.runtime = { fileCtor: typeof File, instanceofFile: f instanceof File, name: f.name, type: f.type, filesUpload: typeof filesApi?.upload };
      } catch (e) {
        out.runtime_err = e instanceof Error ? e.message : String(e);
      }

      // 3) KB binary round-trip — commit all 256 byte values, read back two ways
      if (pat) {
        const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
        const probePath = "mail-attachments/_probe/roundtrip.bin";
        try {
          await commitToKb({ pat, message: "attachprobe", files: [{ path: probePath, base64: bytes.toString("base64") }] });
          const viaReadKbFile = await readKbFile(pat, probePath).catch(() => null);
          const rawRes = await fetch(
            `https://api.github.com/repos/${KB_REPO.owner}/${KB_REPO.name}/contents/${probePath}?ref=main`,
            { headers: { Authorization: `Bearer ${pat}`, Accept: "application/vnd.github.raw", "X-GitHub-Api-Version": "2022-11-28" } },
          );
          const rawBuf = Buffer.from(await rawRes.arrayBuffer());
          out.kbRoundtrip = {
            committed: bytes.length,
            readKbFileMatches: viaReadKbFile ? Buffer.from(viaReadKbFile, "utf8").equals(bytes) : false,
            rawStatus: rawRes.status,
            rawLen: rawBuf.length,
            rawMatches: rawBuf.equals(bytes),
          };
          await commitToKb({ pat, message: "attachprobe cleanup", files: [{ path: probePath, delete: true }] }).catch(() => {});
        } catch (e) {
          out.kbRoundtrip_err = e instanceof Error ? e.message : String(e);
        }
      }

      // 4) real attach-send: stage a readable .txt via files.upload, attach to a fresh email
      try {
        const probeTxt = Buffer.from("Reddy-GTM attachment probe — if this file is attached, email attachments work end to end.\n");
        const file = new File([probeTxt], "reddy-attachment-probe.txt", { type: "text/plain" });
        const filesApi = (composio() as unknown as { files: { upload: (a: unknown) => Promise<unknown> } }).files;
        const uploaded = await filesApi.upload({ file, toolSlug: "GMAIL_SEND_EMAIL", toolkitSlug: "gmail" });
        out.uploaded = uploaded;
        const sendRes = (await composio().tools.execute("GMAIL_SEND_EMAIL", {
          userId: BOT_ADDR,
          arguments: { recipient_email: "adam@reddy.io", subject: "Reddy-GTM attachment probe", body: "Attachment plumbing test — see attached file.", is_html: false, attachment: uploaded },
          dangerouslySkipVersionCheck: true,
        })) as { successful?: boolean; error?: unknown };
        out.send = { successful: sendRes?.successful ?? null, error: sendRes?.error ?? null };
      } catch (e) {
        out.attachSend_err = e instanceof Error ? e.message : String(e);
      }

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
