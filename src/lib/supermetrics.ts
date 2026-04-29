import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Anthropic from "@anthropic-ai/sdk";

const MCP_URL = "https://mcp.supermetrics.com/mcp";

interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Connect to Supermetrics MCP, discover tools, and answer a marketing question
 * using Claude's tool-use loop. Returns the final text answer.
 */
export async function answerCampaignQuestion(question: string): Promise<string> {
  const apiKey = process.env.SUPERMETRICS_API_KEY;
  if (!apiKey) {
    throw new Error("SUPERMETRICS_API_KEY is not configured");
  }

  // Connect to Supermetrics MCP
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  });

  const mcpClient = new Client({ name: "reddy-gtm", version: "1.0.0" });
  await mcpClient.connect(transport);

  try {
    // Discover available tools
    const { tools: mcpTools } = await mcpClient.listTools();

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

    let messages: Anthropic.MessageParam[] = [
      { role: "user", content: question },
    ];

    let response = await claude.messages.create({
      model: "anthropic/claude-sonnet-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      tools: anthropicTools,
      messages,
    });

    // Tool-use loop (max 15 iterations for the multi-step discovery workflow)
    let iterations = 0;
    while (response.stop_reason === "tool_use" && iterations < 15) {
      iterations++;
      const assistantContent = response.content;
      messages.push({ role: "assistant", content: assistantContent });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of assistantContent) {
        if (block.type === "tool_use") {
          try {
            const result = await mcpClient.callTool({
              name: block.name,
              arguments: block.input as Record<string, unknown>,
            });

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
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: `Error: ${err instanceof Error ? err.message : String(err)}`,
              is_error: true,
            });
          }
        }
      }

      messages.push({ role: "user", content: toolResults });

      response = await claude.messages.create({
        model: "anthropic/claude-sonnet-4-6",
        max_tokens: 4096,
        system: systemPrompt,
        tools: anthropicTools,
        messages,
      });
    }

    // Extract final text
    const textBlocks = response.content.filter(
      (b): b is Anthropic.TextBlock => b.type === "text"
    );
    return textBlocks.map((b) => b.text).join("\n") || "No answer generated.";
  } finally {
    await mcpClient.close();
  }
}
