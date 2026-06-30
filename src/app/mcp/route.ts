import { NextRequest } from "next/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { verifyMcpToken } from "@/lib/mcp-token";

export const maxDuration = 800;
export const dynamic = "force-dynamic";

// Streamable-HTTP MCP server for Reddy-GTM. Single tool `ask_reddy_gtm`
// — a catch-all that runs the existing agent server-side and returns a
// brief synthesized answer + reference URLs. Designed to keep the
// caller's Claude session lean: one tool description, ~700-1500 tokens
// per response.
//
// Auth: `Authorization: Bearer <token>` where token is HMAC-signed
// (see lib/mcp-token.ts) and identifies the teammate by email. Mint
// tokens via /api/mcp/admin/mint-token.

const HEADER_AUTH = "authorization";

function readBearer(req: Request): string | null {
  const h = req.headers.get(HEADER_AUTH);
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function handleMcp(req: Request): Promise<Response> {
  const tokenSecret = process.env.MCP_TOKEN_SECRET;
  if (!tokenSecret) {
    return new Response(JSON.stringify({ error: "MCP_TOKEN_SECRET not set" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  const token = readBearer(req);
  if (!token) {
    return new Response(JSON.stringify({ error: "missing Bearer token" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
    });
  }
  const userEmail = verifyMcpToken(token, tokenSecret);
  if (!userEmail) {
    return new Response(JSON.stringify({ error: "invalid or expired token" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" },
    });
  }

  // Build a fresh McpServer per request — closes over userEmail so the
  // tool handler can pass it to /api/agent/oneshot. Stateless transport
  // (no sessionIdGenerator), JSON response (no SSE).
  const server = new McpServer({ name: "reddy-gtm", version: "0.1.0" });

  // The MCP SDK's tool overloads with zod schemas hit TS2589 in our build.
  // Use a typed wrapper that bypasses the SDK's nested generics.
  const registerWith = server as unknown as {
    tool: (
      name: string,
      description: string,
      params: Record<string, unknown>,
      cb: (
        args: { question: string; customer?: string },
      ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>,
    ) => unknown;
  };
  registerWith.tool(
    "ask_reddy_gtm",
    "Catch-all for any question about Reddy customers, contracts, pricing, security questionnaires, RFPs, marketing campaigns, GTM tag manager, meeting recordings, or HubSpot/Apollo/Granola data. Runs the full Reddy-GTM agent server-side and returns a concise synthesized answer plus reference URLs. The agent reads everything it needs (signed contracts, transcripts, pricing precedent, etc.) without inlining raw artifacts. Examples: 'tell me about Gifthealth's contract', 'what's our typical LoL cap?', 'list the recordings for Acme', 'audit our GTM container', 'recent Granola meetings about pricing'.",
    {
      question: z.string().describe("The question to ask Reddy-GTM. Phrase naturally — same as you'd ask in Slack."),
      customer: z.string().optional().describe("Optional customer scope hint (e.g., 'Gifthealth', 'Vistra'). Helps the agent disambiguate if the question doesn't already name the customer."),
    },
    async ({ question, customer }) => {
      const baseUrl = process.env.PUBLIC_BASE_URL ?? "https://gtm-jet.vercel.app";
      const internalSecret = process.env.MCP_INTERNAL_SECRET;
      if (!internalSecret) {
        return {
          content: [{ type: "text", text: "Server misconfigured: MCP_INTERNAL_SECRET not set." }],
          isError: true,
        };
      }

      const res = await fetch(`${baseUrl}/api/agent/oneshot`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-reddy-internal": internalSecret,
        },
        body: JSON.stringify({ question, userEmail, customer }),
      });

      if (!res.ok) {
        const errBody = await res.text();
        return {
          content: [{ type: "text", text: `Reddy-GTM agent failed (HTTP ${res.status}): ${errBody.slice(0, 500)}` }],
          isError: true,
        };
      }

      const result = (await res.json()) as {
        ok: boolean;
        answer?: string;
        references?: Array<{ label: string; url: string; type: string }>;
        error?: string;
      };

      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Reddy-GTM agent error: ${result.error ?? "unknown"}` }],
          isError: true,
        };
      }

      // Compose: answer text, then a "References:" block of bullet links.
      // The agent's own answer may already include link references inline;
      // this block is the explicit, structured list.
      let text = (result.answer ?? "").trim() || "(no answer)";
      if (Array.isArray(result.references) && result.references.length > 0) {
        const refs = result.references
          .map((r) => `- [${r.label}](${r.url})`)
          .join("\n");
        text = `${text}\n\n**References:**\n${refs}`;
      }

      return {
        content: [{ type: "text", text }],
      };
    },
  );

  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport.handleRequest(req);
}

export async function POST(req: NextRequest) {
  return handleMcp(req);
}

export async function GET(req: NextRequest) {
  return handleMcp(req);
}

export async function DELETE(req: NextRequest) {
  return handleMcp(req);
}
