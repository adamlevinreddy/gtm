import { postToChannel, salesChannel } from "@/lib/slack";
import { recentMeetingIndex } from "@/lib/recall-index";
import { listSessions } from "@/lib/sessions";
import { runAgentAnswer } from "@/lib/proactive-run";
import { PLAYS, ALL_PLAY_IDS, playRunPrompt } from "@/lib/plays";

// Friday-morning proactive digests (Arc VII). Three agent passes, each posting a
// Slack digest — the reactive→proactive migration: instead of waiting to be
// asked, the bot surfaces (1) accounts going quiet, (2) product signal for
// engineering, (3) manual workflows worth turning into Plays. Each is
// best-effort and independent; one failing never blocks the others.
//
// They run SEQUENTIALLY (the oneshot lane keys its sandbox by email, so two
// concurrent same-email runs would race the shared turn file). Poll windows are
// sized so all three fit inside the cron's 800s budget.

const SLACK_HINT =
  "Format the answer as a concise, Slack-friendly digest (mrkdwn: *bold*, • bullets, short lines). No preamble.";

function engChannel(): string | undefined {
  return process.env.ENG_SLACK_CHANNEL_ID || salesChannel();
}

function buildEngSignalPrompt(meetings: Array<{ botId: string; title: string; customer: string }>): string {
  const list = meetings
    .map((m) => `  - bot_id ${m.botId} — ${m.title}${m.customer ? ` (${m.customer})` : ""}`)
    .join("\n");
  return [
    `Review THIS WEEK's customer & prospect meetings and pull out the product signal for engineering — concrete bugs, feature requests, and blockers customers raised. This is a digest for the eng team, not sales logistics.`,
    ``,
    `THIS WEEK'S MEETINGS (read each transcript by bot_id; skip internal all-@reddy.io ones):`,
    list || "  (none found)",
    "KB glob: `corpora/success/customers/*/meetings/<bot_id>/transcript.txt` ('_unsorted' is a real slug).",
    ``,
    `Group the findings by theme (e.g. "Reporting", "Integrations", "Onboarding friction"). For each item: one line, the customer name, and a short paraphrase or quote. Separate clear BUGS from FEATURE REQUESTS. Skip pricing/scheduling/sales chatter. If nothing notable came up this week, say so in one line.`,
    ``,
    SLACK_HINT,
  ].join("\n");
}

function buildMetaPrompt(sessionTitles: string[]): string {
  const existing = ALL_PLAY_IDS.map((id) => `${PLAYS[id].label}`).join(", ");
  const titles = sessionTitles.slice(0, 80).map((t) => `  - ${t}`).join("\n");
  return [
    `Review how the team has been using the Reddy GTM assistant this week and spot repeated MANUAL workflows that aren't yet a "Play" (a saved, one-click templated workflow).`,
    ``,
    `EXISTING PLAYS (don't re-propose these): ${existing}.`,
    ``,
    `RECENT SESSION TITLES (what people asked the assistant to do):`,
    titles || "  (no recent sessions)",
    ``,
    `Look for patterns — the same kind of ask typed out by hand several times, or a multi-step task people keep re-explaining. Propose 1–3 NEW candidate Plays: for each, a short name, one line on what it would do, and roughly how often it showed up. If nothing new stands out, say the current Plays cover it. Keep it to a few bullets — this is a nudge, not a report.`,
    ``,
    SLACK_HINT,
  ].join("\n");
}

export type FridayPlaysResult = {
  ok: boolean;
  posted: string[];
  errors: string[];
};

export async function runFridayPlays(opts: { runId: string }): Promise<FridayPlaysResult> {
  const posted: string[] = [];
  const errors: string[] = [];
  const channel = salesChannel();

  // Gather this week's meetings once (shared by the eng-signal pass).
  const pat = process.env.PRICING_LIBRARY_GITHUB_PAT ?? "";
  const week = await recentMeetingIndex(pat, 7, 100).catch(() => []);
  const meetings = week
    .filter((m) => m.bot_id && m.has_transcript)
    .slice(0, 25)
    .map((m) => ({ botId: m.bot_id, title: m.title ?? "(untitled)", customer: m.account_canonical || m.customer_slug || "" }));

  // 1) Accounts going quiet — the accounts_quiet Play, run proactively.
  try {
    const ans = await runAgentAnswer(`${playRunPrompt("accounts_quiet", {})}\n\n${SLACK_HINT}`, {
      requestId: `${opts.runId}:quiet`,
      pollTimeoutMs: 180_000,
    });
    if (ans && channel) {
      await postToChannel(channel, { text: `🌙 *Accounts going quiet*\n\n${ans}` });
      posted.push("accounts_quiet");
    } else if (!ans) errors.push("accounts_quiet: no answer");
  } catch (err) {
    errors.push(`accounts_quiet: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2) Product signal for engineering.
  try {
    const ans = await runAgentAnswer(buildEngSignalPrompt(meetings), {
      requestId: `${opts.runId}:eng`,
      pollTimeoutMs: 270_000,
    });
    const ch = engChannel();
    if (ans && ch) {
      await postToChannel(ch, { text: `🛠️ *Customer signal for engineering — this week*\n\n${ans}` });
      posted.push("eng_signal");
    } else if (!ans) errors.push("eng_signal: no answer");
  } catch (err) {
    errors.push(`eng_signal: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 3) Plays we could template (the meta pass).
  try {
    const sessions = await listSessions({ sinceMs: Date.now() - 7 * 24 * 60 * 60 * 1000, limit: 120 }).catch(() => []);
    const titles = sessions.map((s) => s.title).filter(Boolean);
    const ans = await runAgentAnswer(buildMetaPrompt(titles), {
      requestId: `${opts.runId}:meta`,
      pollTimeoutMs: 120_000,
    });
    if (ans && channel) {
      await postToChannel(channel, { text: `🔁 *Plays we could template*\n\n${ans}` });
      posted.push("meta");
    } else if (!ans) errors.push("meta: no answer");
  } catch (err) {
    errors.push(`meta: ${err instanceof Error ? err.message : String(err)}`);
  }

  return { ok: errors.length === 0, posted, errors };
}
