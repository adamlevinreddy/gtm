import { kv } from "@vercel/kv";
import { v4 as uuidv4 } from "uuid";
import type { ReviewData, ReviewItem, ClassificationResult } from "./types";

const REVIEW_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

export async function createReview(params: {
  source: string;
  items: ReviewItem[];
  knownResults: ClassificationResult[];
  fileName?: string;
}): Promise<string> {
  const id = uuidv4();
  const review: ReviewData = {
    id,
    source: params.source,
    createdAt: new Date().toISOString(),
    status: "pending",
    items: params.items,
    knownResults: params.knownResults,
    decisions: null,
    commitSummary: null,
    fileName: params.fileName,
  };
  await kv.set(`review:${id}`, review, { ex: REVIEW_TTL_SECONDS });
  return id;
}

export async function getReview(id: string): Promise<ReviewData | null> {
  return kv.get<ReviewData>(`review:${id}`);
}

export async function submitDecisions(
  id: string,
  decisions: Record<string, "accept" | "reject">
): Promise<void> {
  const review = await getReview(id);
  if (!review) throw new Error(`Review ${id} not found`);
  review.status = "submitted";
  review.decisions = decisions;
  await kv.set(`review:${id}`, review, { ex: REVIEW_TTL_SECONDS });
}

export async function markCommitted(
  id: string,
  summary: { exclusionsAdded: number; tagsAdded: number; prospectsAdded: number }
): Promise<void> {
  const review = await getReview(id);
  if (!review) throw new Error(`Review ${id} not found`);
  review.status = "committed";
  review.commitSummary = summary;
  await kv.set(`review:${id}`, review, { ex: REVIEW_TTL_SECONDS });
}
