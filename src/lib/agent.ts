import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CompanyWithTitles, ClassificationResult } from "./types";
import {
  CLASSIFICATION_SYSTEM_PROMPT,
  buildClassificationPrompt,
} from "./prompts";

export async function classifyWithAgent(
  companies: CompanyWithTitles[]
): Promise<ClassificationResult[]> {
  if (companies.length === 0) return [];

  const userPrompt = buildClassificationPrompt(companies);
  let agentResult = "";

  for await (const message of query({
    prompt: userPrompt,
    options: {
      model: "claude-opus-4-6",
      systemPrompt: CLASSIFICATION_SYSTEM_PROMPT,
      allowedTools: ["WebSearch"],
      maxTurns: 10,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: "https://ai-gateway.vercel.sh",
        ANTHROPIC_AUTH_TOKEN: process.env.AI_GATEWAY_API_KEY || "",
        ANTHROPIC_API_KEY: "",
      } as Record<string, string>,
      betas: ["context-1m-2025-08-07"],
    },
  })) {
    if (message.type === "result" && "result" in message) {
      agentResult = (message as { result: string }).result;
    }
  }

  const jsonMatch = agentResult.match(/\[[\s\S]*\]/);
  if (!jsonMatch) {
    throw new Error(
      `Agent did not return valid JSON. Response: ${agentResult.slice(0, 500)}`
    );
  }

  const parsed: Array<{
    name: string;
    action: string;
    category: string | null;
    rationale: string;
  }> = JSON.parse(jsonMatch[0]);

  return parsed.map((item) => ({
    name: item.name,
    action: item.action as "exclude" | "tag" | "prospect",
    category: item.category,
    confidence: "claude" as const,
    rationale: item.rationale,
  }));
}
