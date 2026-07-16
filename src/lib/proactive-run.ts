import { selfBaseUrl } from "@/lib/work-items";

// Run the shared sandbox agent once and get its answer text back — the building
// block for scheduled/proactive digests (EOD tasks, Friday plays). It hits the
// SAME oneshot lane the web chat uses (/api/agent/oneshot), so a digest has the
// full toolset (KB read, board_list, HubSpot) and the same guardrails. The
// caller decides what to do with the answer (usually postToChannel).
//
// lane "web" keeps the agent in MCP mode: it doesn't post to Slack itself and
// doesn't mirror a session — the answer lands at mcp:result:{requestId} and is
// returned here. Cron routes should give this a generous pollTimeoutMs (under
// their own maxDuration) since a digest reads several transcripts.

export async function runAgentAnswer(
  question: string,
  opts?: { requestId?: string; pollTimeoutMs?: number; userEmail?: string },
): Promise<string | null> {
  const secret = process.env.MCP_INTERNAL_SECRET;
  if (!secret) return null;
  try {
    const res = await fetch(`${selfBaseUrl()}/api/agent/oneshot`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-reddy-internal": secret },
      body: JSON.stringify({
        question,
        // A DEDICATED runner email → its own per-user oneshot sandbox, isolated
        // from the real-time post-meeting curation sandbox (which uses
        // POST_MEETING_AGENT_EMAIL). Without this a 5pm/8am digest firing while a
        // meeting-end curation runs would race the shared inbox turn file. The
        // web lane skips session mirroring, so the runner email never surfaces.
        userEmail: opts?.userEmail || process.env.PROACTIVE_AGENT_EMAIL || "proactive-bot@reddy.io",
        pollTimeoutMs: opts?.pollTimeoutMs ?? 285_000,
        requestId: opts?.requestId,
        lane: "web",
      }),
    });
    const j = (await res.json().catch(() => null)) as { ok?: boolean; answer?: string } | null;
    return j?.ok && j.answer ? j.answer : null;
  } catch {
    return null;
  }
}
