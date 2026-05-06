"use client";

import { useEffect, useState, useMemo } from "react";
import { useParams } from "next/navigation";
import { ReviewTable } from "@/components/review-table";
import { SubmitButton } from "@/components/submit-button";
import type { ReviewData, ClassificationResult } from "@/lib/types";

const PERSONA_LABELS: Record<string, string> = {
  cx_leadership: "CX/CC Leadership",
  ld: "L&D",
  qa: "QA Ops",
  wfm: "WFM",
  km: "Knowledge Mgmt",
  sales_marketing: "Sales & Marketing",
  it: "IT / Technology",
  excluded: "Excluded",
  unknown: "Unknown",
};

function CollapsibleSection({
  title,
  count,
  color,
  children,
}: {
  title: string;
  count: number;
  color: "red" | "amber";
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const colorMap = {
    red: { border: "border-red-200", bg: "bg-red-50", text: "text-red-800", badge: "bg-red-100 text-red-700" },
    amber: { border: "border-amber-200", bg: "bg-amber-50", text: "text-amber-800", badge: "bg-amber-100 text-amber-700" },
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
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${c.badge}`}>{count}</span>
        </div>
      </button>
      {open && <div className="px-4 py-3 text-sm text-gray-700">{children}</div>}
    </div>
  );
}

function groupByCategory(results: ClassificationResult[]): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  for (const r of results) {
    const key = r.category || "Uncategorized";
    if (!groups[key]) groups[key] = [];
    groups[key].push(r.name);
  }
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
  const [tab, setTab] = useState<"classification" | "attendees">("classification");

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

  const attendees = useMemo(() => {
    if (!review?.attendees) return [];
    return review.attendees.filter((a) => a.persona !== "excluded");
  }, [review]);

  const attendeesByPersona = useMemo(() => {
    const groups: Record<string, typeof attendees> = {};
    for (const a of attendees) {
      const key = a.persona || "unknown";
      if (!groups[key]) groups[key] = [];
      groups[key].push(a);
    }
    return groups;
  }, [attendees]);

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
        <p className="text-gray-600">Your decisions have been submitted and committed to the database.</p>
      </main>
    );
  }

  const totalProcessed = review.knownResults.length + review.items.length;

  return (
    <main className="min-h-screen p-8 max-w-7xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Review: {review.source}</h1>
        <p className="text-gray-500 mt-1">
          {totalProcessed} companies processed. {review.knownResults.length} known matches.
          {attendees.length > 0 && ` ${attendees.length} attendees classified.`}
        </p>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex gap-6">
          <button
            type="button"
            onClick={() => setTab("classification")}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
              tab === "classification"
                ? "border-blue-600 text-blue-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            Classification
          </button>
          <button
            type="button"
            onClick={() => setTab("attendees")}
            className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
              tab === "attendees"
                ? "border-purple-600 text-purple-600"
                : "border-transparent text-gray-500 hover:text-gray-700"
            }`}
          >
            Attendees
            {attendees.length > 0 && (
              <span className="ml-2 text-xs font-semibold px-2 py-0.5 rounded-full bg-purple-100 text-purple-700">
                {attendees.length}
              </span>
            )}
          </button>
        </nav>
      </div>

      {/* Classification Tab */}
      {tab === "classification" && (
        <>
          <div className="mb-8 space-y-3">
            <CollapsibleSection title="Excluded Vendors" count={excluded.length} color="red">
              {excluded.length === 0 ? (
                <p className="text-gray-400 italic">None</p>
              ) : (
                <div className="space-y-2">
                  {Object.entries(excludedGroups)
                    .sort(([, a], [, b]) => b.length - a.length)
                    .map(([category, names]) => (
                      <div key={category}>
                        <span className="font-medium text-gray-900">{category} ({names.length}):</span>{" "}
                        <span className="text-gray-600">{names.join(", ")}</span>
                      </div>
                    ))}
                </div>
              )}
            </CollapsibleSection>

            <CollapsibleSection title="Tagged — Different Outreach" count={tagged.length} color="amber">
              {tagged.length === 0 ? (
                <p className="text-gray-400 italic">None</p>
              ) : (
                <div className="space-y-2">
                  {Object.entries(taggedGroups)
                    .sort(([, a], [, b]) => b.length - a.length)
                    .map(([category, names]) => (
                      <div key={category}>
                        <span className="font-medium text-gray-900">{category} ({names.length}):</span>{" "}
                        <span className="text-gray-600">{names.join(", ")}</span>
                      </div>
                    ))}
                </div>
              )}
            </CollapsibleSection>
          </div>

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
        </>
      )}

      {/* Attendees Tab */}
      {tab === "attendees" && (
        <div>
          {attendees.length === 0 ? (
            <p className="text-gray-400 italic py-8 text-center">
              Attendee data still loading... refresh in a moment.
            </p>
          ) : (
            <>
              {/* Persona summary */}
              <div className="flex flex-wrap gap-2 mb-6">
                {Object.entries(attendeesByPersona)
                  .sort(([, a], [, b]) => b.length - a.length)
                  .map(([persona, list]) => (
                    <span
                      key={persona}
                      className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-700"
                    >
                      {PERSONA_LABELS[persona] || persona}
                      <span className="font-bold">{list.length}</span>
                    </span>
                  ))}
              </div>

              <div className="overflow-x-auto border rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b">
                    <tr>
                      <th className="text-left px-4 py-3 font-medium text-gray-700">Company</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-700">Title</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-700">Persona</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-700">In HubSpot</th>
                      <th className="text-left px-4 py-3 font-medium text-gray-700">Contact Name</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attendees.map((a, i) => (
                      <tr key={`${a.company}-${a.title}-${i}`} className="border-b">
                        <td className="px-4 py-2 font-medium text-gray-900">{a.company}</td>
                        <td className="px-4 py-2 text-gray-600">{a.title}</td>
                        <td className="px-4 py-2">
                          <span className="inline-block px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-700">
                            {PERSONA_LABELS[a.persona] || a.persona}
                          </span>
                        </td>
                        <td className="px-4 py-2">
                          {a.inHubspot ? (
                            <span className="text-green-600 font-medium">Yes</span>
                          ) : (
                            <span className="text-gray-400">No</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-gray-600">{a.hubspotName || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
    </main>
  );
}
