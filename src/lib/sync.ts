import { db } from "./db";
import { syncLog, agentRuns } from "./schema";
import { eq, and, lte } from "drizzle-orm";

/**
 * Log a sync operation between Supabase and an external system.
 */
export async function logSync(params: {
  system: string;
  direction: "outbound" | "inbound" | "bidirectional";
  entityType: string;
  entityId: string;
  externalId?: string;
  operation: string;
  changeset?: unknown;
  success: boolean;
  errorMessage?: string;
  durationMs?: number;
}) {
  await db.insert(syncLog).values({
    system: params.system,
    direction: params.direction,
    entityType: params.entityType,
    entityId: params.entityId,
    externalId: params.externalId,
    operation: params.operation,
    changeset: params.changeset,
    success: params.success,
    errorMessage: params.errorMessage,
    durationMs: params.durationMs,
  });
}

/**
 * Get failed syncs that are ready for retry.
 */
export async function getFailedSyncs() {
  return db
    .select()
    .from(syncLog)
    .where(
      and(
        eq(syncLog.success, false),
        lte(syncLog.nextRetryAt, new Date())
      )
    );
}

/**
 * Record a Claude agent execution.
 * Returns the agent_run ID for linking to other records.
 */
export async function recordAgentRun(params: {
  agentType: string;
  status: "running" | "success" | "failed" | "timeout";
  model?: string;
  inputSummary?: unknown;
  outputSummary?: unknown;
  errorMessage?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  reviewId?: string;
}): Promise<number> {
  const [row] = await db
    .insert(agentRuns)
    .values({
      agentType: params.agentType,
      status: params.status,
      model: params.model,
      inputSummary: params.inputSummary,
      outputSummary: params.outputSummary,
      errorMessage: params.errorMessage,
      durationMs: params.durationMs,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      reviewId: params.reviewId,
      completedAt: params.status !== "running" ? new Date() : undefined,
    })
    .returning({ id: agentRuns.id });

  return row.id;
}

/**
 * Update an agent run (e.g., when it completes).
 */
export async function completeAgentRun(
  id: number,
  result: {
    status: "success" | "failed" | "timeout";
    outputSummary?: unknown;
    errorMessage?: string;
    durationMs?: number;
    inputTokens?: number;
    outputTokens?: number;
  }
) {
  await db
    .update(agentRuns)
    .set({
      status: result.status,
      outputSummary: result.outputSummary,
      errorMessage: result.errorMessage,
      durationMs: result.durationMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      completedAt: new Date(),
    })
    .where(eq(agentRuns.id, id));
}
