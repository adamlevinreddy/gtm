import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReviewItem, ClassificationResult } from "@/lib/types";

// --- Mock @vercel/kv with in-memory Map -----------------------------------

const store = new Map<string, string>();

vi.mock("@vercel/kv", () => {
  return {
    kv: {
      set: vi.fn(async (key: string, value: unknown) => {
        store.set(key, JSON.stringify(value));
      }),
      get: vi.fn(async (key: string) => {
        const v = store.get(key);
        return v ? JSON.parse(v) : null;
      }),
    },
  };
});

// --- Mock uuid to produce deterministic IDs --------------------------------

let uuidCounter = 0;
vi.mock("uuid", () => ({
  v4: () => `test-uuid-${++uuidCounter}`,
}));

// --- Test data -------------------------------------------------------------

const sampleItems: ReviewItem[] = [
  {
    name: "Salesforce",
    titles: ["Account Executive", "VP Sales"],
    action: "exclude",
    category: "vendor",
    rationale: "CRM vendor",
  },
  {
    name: "Unknown Startup",
    titles: ["CEO"],
    action: "prospect",
    category: null,
    rationale: "Small company, likely prospect",
  },
];

const sampleKnownResults: ClassificationResult[] = [
  {
    name: "Google",
    action: "tag",
    category: "big-tech",
    confidence: "known",
    rationale: null,
  },
];

// --- Tests -----------------------------------------------------------------

describe("kv", () => {
  beforeEach(() => {
    store.clear();
    uuidCounter = 0;
  });

  describe("createReview + getReview", () => {
    it("creates a review and retrieves it with status 'pending'", async () => {
      const { createReview, getReview } = await import("@/lib/kv");

      const id = await createReview({
        source: "conference-2026.xlsx",
        items: sampleItems,
        knownResults: sampleKnownResults,
      });

      expect(id).toBe("test-uuid-1");

      const review = await getReview(id);
      expect(review).not.toBeNull();
      expect(review!.id).toBe("test-uuid-1");
      expect(review!.source).toBe("conference-2026.xlsx");
      expect(review!.status).toBe("pending");
      expect(review!.items).toEqual(sampleItems);
      expect(review!.knownResults).toEqual(sampleKnownResults);
      expect(review!.decisions).toBeNull();
      expect(review!.commitSummary).toBeNull();
      expect(review!.createdAt).toBeTruthy();
    });

    it("stores the review with a 7-day TTL", async () => {
      const { createReview } = await import("@/lib/kv");
      const { kv } = await import("@vercel/kv");

      await createReview({
        source: "test.xlsx",
        items: [],
        knownResults: [],
      });

      expect(kv.set).toHaveBeenCalledWith(
        "review:test-uuid-1",
        expect.objectContaining({ id: "test-uuid-1" }),
        { ex: 7 * 24 * 60 * 60 }
      );
    });
  });

  describe("getReview", () => {
    it("returns null for a non-existent ID", async () => {
      const { getReview } = await import("@/lib/kv");

      const review = await getReview("does-not-exist");
      expect(review).toBeNull();
    });
  });

  describe("submitDecisions", () => {
    it("updates status to 'submitted' and stores decisions", async () => {
      const { createReview, getReview, submitDecisions } = await import(
        "@/lib/kv"
      );

      const id = await createReview({
        source: "event.xlsx",
        items: sampleItems,
        knownResults: sampleKnownResults,
      });

      const decisions: Record<string, "accept" | "reject"> = {
        Salesforce: "accept",
        "Unknown Startup": "reject",
      };

      await submitDecisions(id, decisions);

      const review = await getReview(id);
      expect(review!.status).toBe("submitted");
      expect(review!.decisions).toEqual(decisions);
      // items and knownResults should be preserved
      expect(review!.items).toEqual(sampleItems);
      expect(review!.knownResults).toEqual(sampleKnownResults);
    });

    it("throws for a non-existent review", async () => {
      const { submitDecisions } = await import("@/lib/kv");

      await expect(
        submitDecisions("missing-id", { Acme: "accept" })
      ).rejects.toThrow("Review missing-id not found");
    });
  });

  describe("markCommitted", () => {
    it("updates status to 'committed' and stores commit summary", async () => {
      const { createReview, getReview, submitDecisions, markCommitted } =
        await import("@/lib/kv");

      const id = await createReview({
        source: "event.xlsx",
        items: sampleItems,
        knownResults: sampleKnownResults,
      });

      await submitDecisions(id, { Salesforce: "accept" });

      const summary = {
        exclusionsAdded: 1,
        tagsAdded: 0,
        prospectsAdded: 0,
      };
      await markCommitted(id, summary);

      const review = await getReview(id);
      expect(review!.status).toBe("committed");
      expect(review!.commitSummary).toEqual(summary);
      // decisions should still be preserved
      expect(review!.decisions).toEqual({ Salesforce: "accept" });
    });

    it("throws for a non-existent review", async () => {
      const { markCommitted } = await import("@/lib/kv");

      await expect(
        markCommitted("missing-id", {
          exclusionsAdded: 0,
          tagsAdded: 0,
          prospectsAdded: 0,
        })
      ).rejects.toThrow("Review missing-id not found");
    });
  });
});
