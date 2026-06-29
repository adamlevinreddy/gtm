// ============================================================================
// "Cone of silence" — the in-meeting confidentiality trigger.
//
// If someone says the LITERAL phrase "cone of silence" during a meeting, the
// Recall bot keeps recording (we never touch the bot) but the meeting is
// treated as confidential: it is NOT posted to Slack and NOT persisted to the
// KB, so it never shows up in the board / meetings view — and, just as
// important, the agent's local KB clone never sees its transcript to read back.
//
// Detection lives in two places that share this module:
//   - realtime transcript webhook (sets the marker mid-meeting, best case), and
//   - the reconcile webhook (scans the final transcript as the guarantee).
// The post-meeting triage helpers also consult the marker as a backstop so a
// cone meeting can never be slacked no matter how the triage is invoked.
// ============================================================================

import { kv } from "@/lib/kv-client";

// The trigger must be the WHOLE phrase, in order. `\b` anchors prevent matches
// inside other words (e.g. "silicone of silence", "cone of silenced") and the
// user's explicit rule that "cone" alone or "silence" alone must NOT trigger.
// `\s+` tolerates the transcript's word-join whitespace (incl. newlines).
const CONE_OF_SILENCE_RE = /\bcone\s+of\s+silence\b/i;

/** True iff the text contains the literal phrase "cone of silence". */
export function detectConeOfSilence(text: string | null | undefined): boolean {
  return !!text && CONE_OF_SILENCE_RE.test(text);
}

const coneKey = (botId: string) => `cone:silence:${botId}`;
// Long-lived so every later reconcile pass / backstop honors it (meetings can
// re-reconcile for days; 90d comfortably outlives that).
const MARKER_TTL_SECONDS = 90 * 24 * 60 * 60;

/** Has this meeting been flagged confidential? */
export async function isConeOfSilence(botId: string): Promise<boolean> {
  if (!botId) return false;
  return (await kv.get(coneKey(botId)).catch(() => null)) != null;
}

/** Flag a meeting confidential (idempotent). */
export async function markConeOfSilence(botId: string): Promise<void> {
  if (!botId) return;
  await kv.set(coneKey(botId), new Date().toISOString(), { ex: MARKER_TTL_SECONDS }).catch(() => {});
}
