import { selfBaseUrl, type DigestItem } from "./work-items";

// ============================================================================
// "Focus today" is NOT computed deterministically. We hand the open board
// items to the sandbox agent (Claude Code, running as a teammate with their
// connected tools) and let it decide the single most important thing to focus
// on -- weighing the board against its own context (today's calendar, recent
// meetings, deal momentum). Read-only: it proposes a focus line, writes nothing.
//
// The deterministic top-priority item (DigestData.focusToday) is the fallback
// when the agent can't run (no MCP secret / no DIGEST_AGENT_EMAIL / error), so
// the digest never breaks.
// ============================================================================

export type Focus = { text: string; source: "agent" | "heuristic" };

function buildFocusQuestion(open: DigestItem[]): string {
  const lines = open.length
    ? open
        .map(
          (it, i) =>
            `${i + 1}. [${it.kind}] ${it.title}` +
            `${it.customerSlug ? ` (${it.customerSlug})` : ""}` +
            `${it.ownerEmail ? ` — ${it.ownerEmail.split("@")[0]}` : ""}`
        )
        .join("\n")
    : "(no open items on the board)";

  return [
    "You are writing the *single* “Focus today” line for the GTM team’s 7am morning digest.",
    "",
    "Below are the OPEN items on the tracking board. Using these PLUS your own context",
    "(today’s calendar, recent meetings, deal momentum, anything time-sensitive), decide the",
    "ONE most important thing the team should focus on today.",
    "",
    "Rules:",
    "- Answer in ONE or TWO sentences. Name the item/customer and *why it matters most today*.",
    "- Pick exactly one focus — do not list several.",
    "- Read-only. Do NOT draft anything customer-facing and do NOT propose any writes.",
    "- If the board is empty, suggest the single highest-leverage thing based on your context.",
    "",
    "Open board items:",
    lines,
  ].join("\n");
}

/**
 * Returns the agent-authored focus line, or null if the agent path is
 * unavailable (caller falls back to the deterministic heuristic).
 */
export async function deriveFocusViaAgent(open: DigestItem[]): Promise<Focus | null> {
  const secret = process.env.MCP_INTERNAL_SECRET;
  const userEmail = process.env.DIGEST_AGENT_EMAIL;
  if (!secret || !userEmail) return null;

  try {
    const res = await fetch(`${selfBaseUrl()}/api/agent/oneshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-reddy-internal": secret },
      body: JSON.stringify({ question: buildFocusQuestion(open), userEmail }),
    });
    const json = (await res.json()) as { ok?: boolean; answer?: string };
    if (json?.ok && typeof json.answer === "string" && json.answer.trim()) {
      return { text: json.answer.trim(), source: "agent" };
    }
  } catch {
    // fall through to heuristic
  }
  return null;
}
