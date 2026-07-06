// Card-mute store — which meetings/series should NOT get an auto-posted
// post-meeting Play card in Slack. This mirrors meeting-optout.ts (same
// series/occurrence identity model, same KV-hash pattern) but is a DIFFERENT
// concern: muting the card never touches whether the notetaker bot joins or
// records — the meeting is still captured, transcribed, and searchable; we just
// don't push the generative card. It's a lighter toggle, like "don't join,"
// managed from the same Settings "Notetaker schedule" list.
//
// The wrinkle: the mute is SET at schedule time keyed by ical_uid (we have the
// calendar event there), but CHECKED at card time inside proposeFromMeeting,
// which only has a Recall botId. meeting-optout is enforced against
// CalendarEvents (which carry ical_uid); the card is enforced against a botId.
// So we persist a botId → { icalUid, startTime } ref at bot-creation time
// (kvKeyBotMeetingRef, written next to the invitees) and resolve through it.
//
// We reuse meeting-optout's pure key builders + types so the two stores stay
// identical in shape; only the hash differs.

import { kv } from "@/lib/kv-client";
import { kvKeyBotMeetingRef } from "@/lib/recall-calendar-v2";
import { seriesBlockKey, occurrenceBlockKey, type BlockScope, type MeetingBlock } from "@/lib/meeting-optout";

const CARD_MUTE_HASH = "recall:cardmute:blocks:v1";

export async function listCardMutes(): Promise<MeetingBlock[]> {
  const all = await kv.hgetall<Record<string, MeetingBlock>>(CARD_MUTE_HASH).catch(() => null);
  if (!all) return [];
  return Object.values(all).sort((a, b) => (a.addedAt < b.addedAt ? 1 : -1));
}

export async function addCardMute(opts: {
  scope: BlockScope;
  icalUid: string;
  startTime?: string;
  title?: string;
  addedBy?: string;
}): Promise<MeetingBlock> {
  if (opts.scope === "occurrence" && !opts.startTime) {
    throw new Error("occurrence mute requires startTime");
  }
  const key =
    opts.scope === "series" ? seriesBlockKey(opts.icalUid) : occurrenceBlockKey(opts.icalUid, opts.startTime!);
  const block: MeetingBlock = {
    key,
    scope: opts.scope,
    icalUid: opts.icalUid,
    startTime: opts.scope === "occurrence" ? opts.startTime : undefined,
    title: opts.title,
    addedBy: opts.addedBy,
    addedAt: new Date().toISOString(),
  };
  await kv.hset(CARD_MUTE_HASH, { [key]: block });
  return block;
}

export async function removeCardMute(key: string): Promise<void> {
  await kv.hdel(CARD_MUTE_HASH, key);
}

/**
 * Is the post-meeting card muted for this bot's meeting/series? Resolves the
 * botId → { icalUid, startTime } ref written at schedule time, then checks the
 * card-mute hash (a series mute wins over a single-occurrence mute). Returns
 * the matching mute or null. Manual/URL bots and any bot scheduled before this
 * ref existed have no ref → never muted (fail-open: better a card than a
 * silently-dropped one).
 */
export async function isCardMutedForBot(botId: string): Promise<MeetingBlock | null> {
  const ref = await kv
    .get<{ icalUid?: string; startTime?: string }>(kvKeyBotMeetingRef(botId))
    .catch(() => null);
  if (!ref?.icalUid) return null;
  const all = (await kv.hgetall<Record<string, MeetingBlock>>(CARD_MUTE_HASH).catch(() => null)) ?? {};
  const series = all[seriesBlockKey(ref.icalUid)];
  if (series) return series;
  if (ref.startTime) {
    const occ = all[occurrenceBlockKey(ref.icalUid, ref.startTime)];
    if (occ) return occ;
  }
  return null;
}
