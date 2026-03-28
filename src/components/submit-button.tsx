"use client";

import { useState } from "react";

interface SubmitButtonProps {
  reviewId: string;
  decisions: Record<string, "accept" | "reject">;
  onSubmitted: () => void;
}

export function SubmitButton({ reviewId, decisions, onSubmitted }: SubmitButtonProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const acceptCount = Object.values(decisions).filter((d) => d === "accept").length;
  const rejectCount = Object.values(decisions).filter((d) => d === "reject").length;

  async function handleSubmit() {
    setLoading(true);
    setError(null);

    try {
      const submitRes = await fetch(`/api/review/${reviewId}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decisions }),
      });
      if (!submitRes.ok) {
        const data = await submitRes.json();
        throw new Error(data.error || "Failed to submit decisions");
      }

      const commitRes = await fetch(`/api/review/${reviewId}/commit`, {
        method: "POST",
      });
      if (!commitRes.ok) {
        const data = await commitRes.json();
        throw new Error(data.error || "Failed to commit changes");
      }

      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        onClick={handleSubmit}
        disabled={loading}
        className="px-6 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {loading ? "Submitting..." : "Submit Decisions"}
      </button>
      <span className="text-sm text-gray-500">
        {acceptCount} accepted, {rejectCount} rejected
      </span>
      {error && <span className="text-sm text-red-600">{error}</span>}
    </div>
  );
}
