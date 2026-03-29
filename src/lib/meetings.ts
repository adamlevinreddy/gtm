import { db } from "./db";
import { meetings } from "./schema";
import { eq } from "drizzle-orm";

/**
 * Create a meeting record.
 * The Granola MCP tools are available in the Claude environment but not yet
 * wired into automated flows. This module provides the data layer.
 */
export async function createMeeting(data: {
  accountId?: string;
  opportunityId?: string;
  title: string;
  meetingDate: Date;
  attendees?: { name: string; email?: string; role?: string }[];
  transcript?: string;
  summary?: string;
  source: string;
  granolaMeetingId?: string;
}) {
  const [row] = await db
    .insert(meetings)
    .values({
      accountId: data.accountId,
      opportunityId: data.opportunityId,
      title: data.title,
      meetingDate: data.meetingDate,
      attendees: data.attendees,
      transcript: data.transcript,
      summary: data.summary,
      source: data.source,
      granolaMeetingId: data.granolaMeetingId,
    })
    .returning({ id: meetings.id });

  return row.id;
}

/**
 * Get all meetings for an account, ordered by date descending.
 */
export async function getMeetingsByAccount(accountId: string) {
  return db
    .select()
    .from(meetings)
    .where(eq(meetings.accountId, accountId))
    .orderBy(meetings.meetingDate);
}
