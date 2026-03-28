"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { ReviewTable } from "@/components/review-table";
import { SubmitButton } from "@/components/submit-button";
import type { ReviewData } from "@/lib/types";

export default function ReviewPage() {
  const params = useParams();
  const id = params.id as string;

  const [review, setReview] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, "accept" | "reject">>({});
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    fetch(`/api/review/${id}`)
      .then((res) => {
        if (!res.ok) throw new Error("Review not found");
        return res.json();
      })
      .then((data: ReviewData) => {
        setReview(data);
        const initial: Record<string, "accept" | "reject"> = {};
        for (const item of data.items) {
          initial[item.name] = "accept";
        }
        setDecisions(initial);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-gray-500">Loading review...</p>
      </main>
    );
  }

  if (error || !review) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-red-600">{error || "Review not found"}</p>
      </main>
    );
  }

  if (review.status === "committed") {
    return (
      <main className="min-h-screen p-8 max-w-7xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Review Complete</h1>
        <p className="text-gray-600">
          This review has been committed.
          {review.commitSummary && (
            <span>
              {" "}{review.commitSummary.exclusionsAdded} exclusions,{" "}
              {review.commitSummary.tagsAdded} tags,{" "}
              {review.commitSummary.prospectsAdded} prospects added.
            </span>
          )}
        </p>
      </main>
    );
  }

  if (submitted || review.status === "submitted") {
    return (
      <main className="min-h-screen p-8 max-w-7xl mx-auto">
        <h1 className="text-2xl font-bold text-gray-900 mb-4">Review Submitted</h1>
        <p className="text-gray-600">Your decisions have been submitted and are being committed to the repo.</p>
      </main>
    );
  }

  return (
    <main className="min-h-screen p-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Review: {review.source}</h1>
        <p className="text-gray-500 mt-1">
          {review.knownResults.length} companies matched automatically.{" "}
          {review.items.length} need your review.
        </p>
      </div>

      <ReviewTable items={review.items} onDecisionsChange={setDecisions} />

      <div className="mt-6 sticky bottom-0 bg-white py-4 border-t">
        <SubmitButton
          reviewId={id}
          decisions={decisions}
          onSubmitted={() => setSubmitted(true)}
        />
      </div>
    </main>
  );
}
