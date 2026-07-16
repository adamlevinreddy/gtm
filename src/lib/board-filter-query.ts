import { eq } from "drizzle-orm";
import { db } from "./db";
import { workItemLabels } from "./schema";

// Server-only helper for filters the BoardFilter type doesn't model directly
// (currently: "which work items carry this label"). Imports db → never import
// from a client component. Kept separate from board-world.ts (owned by the
// lead) so the UI module can extend its own read surface.

export async function itemIdsForFilters(filter: {
  labelId?: string;
}): Promise<string[]> {
  if (filter.labelId) {
    const rows = await db
      .select({ id: workItemLabels.workItemId })
      .from(workItemLabels)
      .where(eq(workItemLabels.labelId, filter.labelId));
    return rows.map((r) => r.id);
  }
  return [];
}
