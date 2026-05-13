import { NextRequest, NextResponse } from "next/server";
import { mintMcpToken } from "@/lib/mcp-token";

// Mint a bearer token for a teammate's email so they can install the
// Reddy-GTM MCP server in Claude Desktop. Gated by MCP_ADMIN_SECRET.
//
//   curl -X POST -H "x-admin-secret: $MCP_ADMIN_SECRET" \
//     "https://gtm-jet.vercel.app/api/mcp/admin/mint-token" \
//     -d '{"email":"someone@reddy.io","ttl_days":365}'
//
// Returns: { token, expiresAt, claudeDesktopConfig }
export async function POST(req: NextRequest) {
  const adminSecret = process.env.MCP_ADMIN_SECRET;
  const tokenSecret = process.env.MCP_TOKEN_SECRET;
  if (!adminSecret || !tokenSecret) {
    return NextResponse.json(
      { ok: false, error: "MCP_ADMIN_SECRET or MCP_TOKEN_SECRET not set" },
      { status: 500 },
    );
  }
  if (req.headers.get("x-admin-secret") !== adminSecret) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: { email?: string; ttl_days?: number };
  try {
    body = (await req.json()) as { email?: string; ttl_days?: number };
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }
  const email = body.email?.trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return NextResponse.json({ ok: false, error: "missing/invalid email" }, { status: 400 });
  }
  const ttlDays = Math.min(Math.max(1, body.ttl_days ?? 365), 365 * 2);
  const ttlSeconds = ttlDays * 24 * 60 * 60;

  const token = mintMcpToken(email, ttlSeconds, tokenSecret);
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  const baseUrl = process.env.PUBLIC_BASE_URL ?? "https://gtm-jet.vercel.app";
  const claudeDesktopConfig = {
    mcpServers: {
      "reddy-gtm": {
        type: "http",
        url: `${baseUrl}/mcp`,
        headers: { Authorization: `Bearer ${token}` },
      },
    },
  };

  return NextResponse.json({ ok: true, email, token, expiresAt, ttlDays, claudeDesktopConfig });
}
