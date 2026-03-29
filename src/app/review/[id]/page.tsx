"use client";

import { useEffect, useState, useMemo } from "react";
import { useParams } from "next/navigation";
import { ReviewTable } from "@/components/review-table";
import { SubmitButton } from "@/components/submit-button";
import type { ReviewData, ClassificationResult, HubSpotCompanyMatch } from "@/lib/types";

function CollapsibleSection({
  title,
  count,
  color,
  children,
}: {
  title: string;
  count: number;
  color: "red" | "amber" | "blue";
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  const colorMap = {
    red: {
      border: "border-red-200",
      bg: "bg-red-50",
      text: "text-red-800",
      badge: "bg-red-100 text-red-700",
    },
    amber: {
      border: "border-amber-200",
      bg: "bg-amber-50",
      text: "text-amber-800",
      badge: "bg-amber-100 text-amber-700",
    },
    blue: {
      border: "border-blue-200",
      bg: "bg-blue-50",
      text: "text-blue-800",
      badge: "bg-blue-100 text-blue-700",
    },
  };

  const c = colorMap[color];

  return (
    <div className={`border ${c.border} rounded-lg overflow-hidden`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center justify-between px-4 py-3 ${c.bg} hover:brightness-95 transition-all`}
      >
        <div className="flex items-center gap-2">
          <span className={`text-sm font-medium ${c.text}`}>
            {open ? "\u25BC" : "\u25B6"} {title}
          </span>
          <span
            className={`text-xs font-semibold px-2 py-0.5 rounded-full ${c.badge}`}
          >
            {count}
          </span>
        </div>
      </button>
      {open && <div className="px-4 py-3 text-sm text-gray-700">{children}</div>}
    </div>
  );
}

function groupByCategory(
  results: ClassificationResult[]
): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const r of results) {
    const key = r.category || "Uncategorized";
    if (!groups[key]) groups[key] = [];
    groups[key].push(r.name);
  }
  // Sort names within each group
  for (const key of Object.keys(groups)) {
    groups[key].sort((a, b) => a.localeCompare(b));
  }
  return groups;
}

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

  const { excluded, tagged } = useMemo(() => {
    if (!review) return { excluded: [], tagged: [] };
    return {
      excluded: review.knownResults.filter((r) => r.action === "exclude"),
      tagged: review.knownResults.filter((r) => r.action === "tag"),
    };
  }, [review]);

  const excludedGroups = useMemo(() => groupByCategory(excluded), [excluded]);
  const taggedGroups = useMemo(() => groupByCategory(tagged), [tagged]);

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

  const totalProcessed = review.knownResults.length + review.items.length;

  return (
    <main className="min-h-screen p-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Review: {review.source}</h1>
        <p className="text-gray-500 mt-1">
          {totalProcessed} companies processed. {review.knownResults.length} known
          matches. {review.items.filter(i => i.action === "exclude" || i.action === "tag").length} suggestions to review.
        </p>
      </div>

      {/* Known Results Summary */}
      <div className="mb-8 space-y-3">
        <CollapsibleSection
          title="Excluded Vendors"
          count={excluded.length}
          color="red"
        >
          {excluded.length === 0 ? (
            <p className="text-gray-400 italic">None</p>
          ) : (
            <div className="space-y-2">
              {Object.entries(excludedGroups)
                .sort(([, a], [, b]) => b.length - a.length)
                .map(([category, names]) => (
                  <div key={category}>
                    <span className="font-medium text-gray-900">
                      {category} ({names.length}):
                    </span>{" "}
                    <span className="text-gray-600">{names.join(", ")}</span>
                  </div>
                ))}
            </div>
          )}
        </CollapsibleSection>

        <CollapsibleSection
          title="Tagged — Different Outreach"
          count={tagged.length}
          color="amber"
        >
          {tagged.length === 0 ? (
            <p className="text-gray-400 italic">None</p>
          ) : (
            <div className="space-y-2">
              {Object.entries(taggedGroups)
                .sort(([, a], [, b]) => b.length - a.length)
                .map(([category, names]) => (
                  <div key={category}>
                    <span className="font-medium text-gray-900">
                      {category} ({names.length}):
                    </span>{" "}
                    <span className="text-gray-600">{names.join(", ")}</span>
                  </div>
                ))}
            </div>
          )}
        </CollapsibleSection>

      </div>

      {/* HubSpot CRM Matches */}
      {review.hubspotMatches && review.hubspotMatches.length > 0 && (
        <div className="mb-8">
          <div className="border border-purple-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 bg-purple-50">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-purple-800">
                  HubSpot CRM Matches
                </span>
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
                  {review.hubspotMatches.reduce((sum, m) => sum + m.contacts.length, 0)} contacts at {review.hubspotMatches.length} companies
                </span>
              </div>
              <p className="text-xs text-purple-600 mt-1">
                These attendees match existing contacts in your HubSpot CRM.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-purple-50/50 border-b border-purple-100">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium text-purple-700">Name</th>
                    <th className="text-left px-4 py-2 font-medium text-purple-700">Title</th>
                    <th className="text-left px-4 py-2 font-medium text-purple-700">Company</th>
                  </tr>
                </thead>
                <tbody>
                  {review.hubspotMatches.flatMap((match) =>
                    match.contacts.map((contact, i) => (
                      <tr key={`${match.company}-${i}`} className="border-b border-purple-50">
                        <td className="px-4 py-2 font-medium text-gray-900">{contact.name}</td>
                        <td className="px-4 py-2 text-gray-600">{contact.title || "—"}</td>
                        <td className="px-4 py-2 text-gray-600">{match.company}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Divider before review table — only show exclude/tag suggestions */}
      {(() => {
        const reviewableItems = review.items.filter(
          (item) => item.action === "exclude" || item.action === "tag"
        );
        const prospectItems = review.items.filter(
          (item) => item.action === "prospect"
        );
        return (
          <>
            <div className="border-t border-gray-300 pt-6 mb-4">
              <h2 className="text-lg font-semibold text-gray-800">
                Review Claude&apos;s Suggestions ({reviewableItems.length})
              </h2>
              <p className="text-sm text-gray-500 mt-1">
                Claude suggests excluding or tagging these companies. Accept to add them to your lists, or reject to keep them as prospects.
                {prospectItems.length > 0 && (
                  <span className="text-gray-400"> ({prospectItems.length} companies identified as prospects — no action needed.)</span>
                )}
              </p>
            </div>

            {reviewableItems.length > 0 ? (
              <ReviewTable items={reviewableItems} onDecisionsChange={setDecisions} />
            ) : (
              <p className="text-gray-400 italic py-8 text-center">
                {review.items.length === 0
                  ? "Classification still in progress... refresh in a moment."
                  : "No exclusion or tag suggestions — all unknowns were identified as prospects."}
              </p>
            )}
          </>
        );
      })()}

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
