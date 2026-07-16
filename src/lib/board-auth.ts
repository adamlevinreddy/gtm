import { NextRequest } from "next/server";

/**
 * Board API auth. Every browser-facing board route is gated by a shared secret
 * in `x-board-secret` (set BOARD_API_SECRET in the environment + passed by the
 * board UI's server-side fetch) plus the acting human's email in `x-board-actor`.
 *
 * Returns the actor email on success, or `null` if the secret is missing/wrong
 * (the caller should 401). Keep this dumb — it is the only gate in front of the
 * CAS choke point, so it must never throw.
 */
export function assertBoardAuth(req: NextRequest): string | null {
  const secret = process.env.BOARD_API_SECRET;
  if (!secret) return null;
  if (req.headers.get("x-board-secret") !== secret) return null;
  const actor = req.headers.get("x-board-actor");
  return actor && actor.length > 0 ? actor : null;
}

/**
 * Internal-only gate for /api/board/bot-run. Requires the board secret but NO
 * actor header, and rejects anything that smells like a browser (an Origin
 * header). Returns true when the request is allowed.
 */
export function assertInternalNoOrigin(req: NextRequest): boolean {
  const secret = process.env.BOARD_API_SECRET;
  if (!secret) return false;
  if (req.headers.get("x-board-secret") !== secret) return false;
  if (req.headers.get("origin")) return false;
  return true;
}
