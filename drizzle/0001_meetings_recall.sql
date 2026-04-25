-- Add Recall.ai bot tracking to meetings.
-- Run from Supabase SQL editor (or `psql $POSTGRES_URL_NON_POOLING -f drizzle/0001_meetings_recall.sql`).
-- Idempotent — safe to re-run.

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS recall_bot_id text;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS recall_attribution_confidence text;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS recall_platform text;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS recall_meeting_url text;

CREATE INDEX IF NOT EXISTS idx_meetings_recall_bot ON meetings(recall_bot_id);
