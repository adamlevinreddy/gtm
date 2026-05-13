import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Anthropic from "@anthropic-ai/sdk";

const MCP_URL = "https://mcp.supermetrics.com/mcp";

// Vercel kills /api/campaign at 300s. We need to land a Slack post
// before that, even if it's a partial answer. Budget the work so we
// always have time for the final post.
const TOTAL_BUDGET_MS = 260_000;          // 260s — 40s margin for Slack post + cleanup
const PER_TOOL_TIMEOUT_MS = 75_000;       // 75s — async data_query + polling fits comfortably
const PER_CLAUDE_TIMEOUT_MS = 60_000;     // 60s — single Claude inference shouldn't take longer
const MAX_ITERATIONS = 25;                // up from 15 — multi-platform discovery needs more

interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

class BudgetExceededError extends Error {
  constructor(public phase: string, public elapsedMs: number) {
    super(`budget exceeded during ${phase} after ${elapsedMs}ms`);
    this.name = "BudgetExceededError";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (err) => { clearTimeout(t); reject(err); });
  });
}

/**
 * Connect to Supermetrics MCP, discover tools, and answer a marketing question
 * using Claude's tool-use loop. Returns the final text answer.
 *
 * Budget-aware: each MCP tool call and each Claude inference is capped, and
 * the whole loop tracks elapsed time so we always exit cleanly with a
 * postable answer (even if partial) before Vercel's 300s function ceiling.
 */
export async function answerCampaignQuestion(question: string): Promise<string> {
  const apiKey = process.env.SUPERMETRICS_API_KEY;
  if (!apiKey) {
    throw new Error("SUPERMETRICS_API_KEY is not configured");
  }

  const startedAt = Date.now();
  const elapsed = () => Date.now() - startedAt;
  const budgetLeft = () => TOTAL_BUDGET_MS - elapsed();

  // Connect to Supermetrics MCP
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  });

  const mcpClient = new Client({ name: "reddy-gtm", version: "1.0.0" });
  await withTimeout(mcpClient.connect(transport), 15_000, "mcp connect");

  // Track the most recent assistant text in case we run out of budget
  // mid-loop — we'd rather post "here's what I gathered before timing
  // out" than nothing.
  let lastTextSnapshot = "";

  try {
    // Discover available tools
    const { tools: mcpTools } = await withTimeout(mcpClient.listTools(), 10_000, "mcp listTools");

    // Convert MCP tools to Anthropic tool format
    const anthropicTools: Anthropic.Tool[] = mcpTools.map((t: McpTool) => ({
      name: t.name,
      description: t.description || "",
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
    }));

    // Run Claude tool-use loop
    const claude = new Anthropic({
      apiKey: process.env.AI_GATEWAY_API_KEY,
      baseURL: "https://ai-gateway.vercel.sh",
    });

    const systemPrompt = `You are a marketing analytics assistant for Reddy, a B2B SaaS company. You have access to Supermetrics tools that can query marketing campaign data from connected ad platforms (Google Ads, LinkedIn Ads, Meta Ads, etc.) and analytics (Google Analytics 4).

All Reddy users are on Pacific Time (America/Los_Angeles). When the user says "today", "yesterday", or "this week", interpret those boundaries as PT, not UTC. Pass PT-anchored date ranges to data_query (most ad platforms accept ISO dates and treat them as the platform's own timezone — do not pass raw UTC instants).

When answering questions:
1. First call get_today to know the current date for date ranges. Note the user is on Pacific Time — adjust if get_today returns a UTC date that crosses the PT day boundary.
2. Use data_source_discovery to find relevant data sources.
3. Use accounts_discovery to find connected accounts.
4. Use field_discovery to find the right metrics and dimensions.
5. Use data_query to submit queries, then get_async_query_results to retrieve data.
6. Synthesize results into a clear, concise answer with key numbers and trends.

Format your answer for Slack (use *bold* for emphasis, bullet points for lists). Keep it actionable — highlight what's working, what's not, and any recommendations.`;

    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: question },
    ];

    if (budgetLeft() < PER_CLAUDE_TIMEOUT_MS) throw new BudgetExceededError("pre-first-call", elapsed());
    let response = await withTimeout(
      claude.messages.create({
        model: "anthropic/claude-sonnet-4-6",
        max_tokens: 4096,
        system: systemPrompt,
        tools: anthropicTools,
        messages,
      }),
      PER_CLAUDE_TIMEOUT_MS,
      "claude(initial)",
    );
    lastTextSnapshot = snapshotText(response.content);

    let iterations = 0;
    while (response.stop_reason === "tool_use" && iterations < MAX_ITERATIONS) {
      if (budgetLeft() < PER_CLAUDE_TIMEOUT_MS) {
        throw new BudgetExceededError(`tool loop (iter ${iterations})`, elapsed());
      }
      iterations++;
      const assistantContent = response.content;
      messages.push({ role: "assistant", content: assistantContent });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of assistantContent) {
        if (block.type === "tool_use") {
          if (budgetLeft() < PER_TOOL_TIMEOUT_MS) {
            // Not enough time for this tool to safely run + return — bail.
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: "Error: query budget exhausted; aborting before this call.",
              is_error: true,
            });
            continue;
          }
          try {
            const result = await withTimeout(
              mcpClient.callTool({
                name: block.name,
                arguments: block.input as Record<string, unknown>,
              }),
              PER_TOOL_TIMEOUT_MS,
              `mcp.${block.name}`,
            );

            const textContent = (result.content as Array<{ type: string; text?: string }>)
              .filter((c) => c.type === "text")
              .map((c) => c.text)
              .join("\n");

            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: textContent || JSON.stringify(result.content),
            });
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(`[supermetrics] tool ${block.name} failed: ${msg}`);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `Error: ${msg}`,
              is_error: true,
            });
          }
        }
      }

      messages.push({ role: "user", content: toolResults });

      response = await withTimeout(
        claude.messages.create({
          model: "anthropic/claude-sonnet-4-6",
          max_tokens: 4096,
          system: systemPrompt,
          tools: anthropicTools,
          messages,
        }),
        PER_CLAUDE_TIMEOUT_MS,
        `claude(iter ${iterations})`,
      );
      const snap = snapshotText(response.content);
      if (snap) lastTextSnapshot = snap;
    }

    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );
    const finalText = textBlocks.map((b) => b.text).join("\n").trim();
    if (finalText) return finalText;
    if (iterations >= MAX_ITERATIONS) {
      return [
        `Hit the ${MAX_ITERATIONS}-iteration tool-use cap without a final answer.`,
        lastTextSnapshot ? `Last partial:\n${lastTextSnapshot}` : "",
        "Try narrowing the question to one platform at a time.",
      ].filter(Boolean).join("\n\n");
    }
    return "No answer generated.";
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      console.warn(`[supermetrics] ${err.message}`);
      return [
        `Hit the time budget for this campaign query (${Math.round(err.elapsedMs / 1000)}s of ${Math.round(TOTAL_BUDGET_MS / 1000)}s allowed) before producing a final answer.`,
        lastTextSnapshot ? `Last partial:\n${lastTextSnapshot}` : "",
        "Try splitting into one platform at a time (Google Ads, then LinkedIn, then GA4) — each on its own typically completes in ~30-60s.",
      ].filter(Boolean).join("\n\n");
    }
    throw err;
  } finally {
    await mcpClient.close().catch(() => {});
  }
}

// Pull the first ~600 chars of any text blocks in an assistant message,
// for use as a partial-answer fallback if we time out mid-loop.
function snapshotText(content: Anthropic.ContentBlock[]): string {
  const text = content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
  return text.length > 600 ? text.slice(0, 600) + "…" : text;
}
