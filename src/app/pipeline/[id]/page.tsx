"use client";

import { useEffect, useState, useMemo } from "react";
import { useParams } from "next/navigation";

const PERSONA_LABELS: Record<string, string> = {
  cx_leadership: "CX/CC Leadership",
  ld: "L&D / Training",
  qa: "QA / Quality",
  wfm: "WFM",
  km: "Knowledge Mgmt",
  sales_marketing: "Sales & Marketing",
  it: "IT / Technology",
  excluded: "Excluded",
  unknown: "Unknown",
};

const PERSONA_COLORS: Record<string, string> = {
  cx_leadership: "bg-blue-100 text-blue-800",
  ld: "bg-emerald-100 text-emerald-800",
  qa: "bg-violet-100 text-violet-800",
  wfm: "bg-amber-100 text-amber-800",
  km: "bg-cyan-100 text-cyan-800",
  sales_marketing: "bg-rose-100 text-rose-800",
  it: "bg-slate-100 text-slate-800",
  excluded: "bg-gray-100 text-gray-500",
  unknown: "bg-gray-100 text-gray-600",
};

interface ScoredContact {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  company: string;
  title: string | null;
  agentCount: number | null;
  agentLevelGuess: string | null;
  brandBpoType: string | null;
  projectPriorities: string | null;
  persona: string | null;
  background: string | null;
  score: number;
  scoringBreakdown: {
    agentSize: number;
    seniority: number;
    personaFit: number;
    priorityRelevance: number;
    brandBonus: number;
  };
  bucket: "filtered" | "existing_activity" | "ranked";
  filterReason?: string;
}

interface PipelineResults {
  id: string;
  fileName: string;
  createdAt: string;
  durationMs: number;
  stats: {
    totalRows: number;
    extracted: number;
    ranked: number;
    filtered: number;
    existingActivity: number;
    enriched: number;
    hubspotCreated: number;
    hubspotSkipped: number;
    hubspotErrors: number;
  };
  ranked: ScoredContact[];
  filtered: ScoredContact[];
  existingActivity: ScoredContact[];
}

function ScoreBar({ score }: { score: number }) {
  const color =
    score >= 70 ? "bg-emerald-500" :
    score >= 50 ? "bg-blue-500" :
    score >= 30 ? "bg-amber-500" :
    "bg-gray-400";
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-2 bg-gray-200 rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${score}%` }} />
      </div>
      <span className="text-xs font-semibold text-gray-700 w-6">{score}</span>
    </div>
  );
}

function ContactRow({ contact, showScore }: { contact: ScoredContact; showScore: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const name = [contact.firstName, contact.lastName].filter(Boolean).join(" ") || "—";
  const agents = contact.agentCount
    ? contact.agentCount.toLocaleString()
    : contact.agentLevelGuess || "—";
  const persona = contact.persona || "unknown";

  return (
    <>
      <tr
        className="border-b hover:bg-gray-50 cursor-pointer transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        {showScore && (
          <td className="px-4 py-2.5"><ScoreBar score={contact.score} /></td>
        )}
        <td className="px-4 py-2.5 font-medium text-gray-900">{name}</td>
        <td className="px-4 py-2.5 text-gray-600 max-w-48 truncate">{contact.title || "—"}</td>
        <td className="px-4 py-2.5 text-gray-900">{contact.company}</td>
        <td className="px-4 py-2.5">
          <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${PERSONA_COLORS[persona] || PERSONA_COLORS.unknown}`}>
            {PERSONA_LABELS[persona] || persona}
          </span>
        </td>
        <td className="px-4 py-2.5 text-gray-600 text-right">{agents}</td>
        <td className="px-4 py-2.5">
          {contact.brandBpoType && (
            <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${
              contact.brandBpoType === "Brand" ? "bg-green-100 text-green-700" :
              contact.brandBpoType === "BPO" ? "bg-orange-100 text-orange-700" :
              contact.brandBpoType === "Competitor" ? "bg-red-100 text-red-700" :
              "bg-gray-100 text-gray-600"
            }`}>
              {contact.brandBpoType}
            </span>
          )}
        </td>
        {!showScore && contact.filterReason && (
          <td className="px-4 py-2.5 text-sm text-gray-500">{contact.filterReason}</td>
        )}
      </tr>
      {expanded && (
        <tr className="border-b bg-gray-50">
          <td colSpan={showScore ? 7 : 8} className="px-6 py-4">
            <div className="grid grid-cols-2 gap-4 text-sm">
              {contact.email && (
                <div><span className="font-medium text-gray-500">Email:</span> {contact.email}</div>
              )}
              {contact.projectPriorities && (
                <div className="col-span-2"><span className="font-medium text-gray-500">Project Priorities:</span> {contact.projectPriorities}</div>
              )}
              {contact.background && (
                <div className="col-span-2"><span className="font-medium text-gray-500">Background:</span> {contact.background}</div>
              )}
              {showScore && contact.scoringBreakdown && (
                <div className="col-span-2">
                  <span className="font-medium text-gray-500">Score Breakdown:</span>{" "}
                  Agent Size: {Math.round(contact.scoringBreakdown.agentSize)} |{" "}
                  Seniority: {Math.round(contact.scoringBreakdown.seniority)} |{" "}
                  Persona Fit: {Math.round(contact.scoringBreakdown.personaFit)} |{" "}
                  Priority Relevance: {Math.round(contact.scoringBreakdown.priorityRelevance)} |{" "}
                  Brand Bonus: {Math.round(contact.scoringBreakdown.brandBonus)}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

export default function PipelinePage() {
  const params = useParams();
  const id = params.id as string;

  const [data, setData] = useState<PipelineResults | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"ranked" | "filtered" | "existing">("ranked");
  const [personaFilter, setPersonaFilter] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/pipeline/${id}`)
      .then((res) => {
        if (!res.ok) throw new Error("Pipeline results not found");
        return res.json();
      })
      .then((d: PipelineResults) => setData(d))
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [id]);

  const rankedByPersona = useMemo(() => {
    if (!data) return new Map<string, ScoredContact[]>();
    const groups = new Map<string, ScoredContact[]>();
    for (const c of data.ranked) {
      const p = c.persona || "unknown";
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p)!.push(c);
    }
    return groups;
  }, [data]);

  const filteredList = useMemo(() => {
    if (!data) return [];
    if (tab === "ranked") {
      const list = personaFilter
        ? data.ranked.filter(c => (c.persona || "unknown") === personaFilter)
        : data.ranked;
      return list;
    }
    if (tab === "filtered") return data.filtered;
    return data.existingActivity;
  }, [data, tab, personaFilter]);

  if (loading) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-gray-500">Loading pipeline results...</p>
      </main>
    );
  }

  if (error || !data) {
    return (
      <main className="min-h-screen flex items-center justify-center">
        <p className="text-red-600">{error || "Results not found"}</p>
      </main>
    );
  }

  const durationSec = Math.round(data.durationMs / 1000);

  return (
    <main className="min-h-screen p-8 max-w-[1400px] mx-auto">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Pipeline Results: {data.fileName}</h1>
        <p className="text-gray-500 mt-1">
          {new Date(data.createdAt).toLocaleDateString()} — processed in {durationSec}s
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-3 mb-6">
        {[
          { label: "Total Rows", value: data.stats.totalRows, color: "bg-gray-50" },
          { label: "Extracted", value: data.stats.extracted, color: "bg-blue-50" },
          { label: "Ranked", value: data.stats.ranked, color: "bg-emerald-50" },
          { label: "Filtered", value: data.stats.filtered, color: "bg-red-50" },
          { label: "Existing Activity", value: data.stats.existingActivity, color: "bg-amber-50" },
          { label: "Apollo Enriched", value: data.stats.enriched, color: "bg-violet-50" },
          { label: "HubSpot Created", value: data.stats.hubspotCreated, color: "bg-green-50" },
        ].map((stat) => (
          <div key={stat.label} className={`${stat.color} rounded-lg p-3 border`}>
            <div className="text-2xl font-bold text-gray-900">{stat.value}</div>
            <div className="text-xs text-gray-500 mt-0.5">{stat.label}</div>
          </div>
        ))}
      </div>

      {/* Persona chips (for ranked tab) */}
      {tab === "ranked" && (
        <div className="flex flex-wrap gap-2 mb-4">
          <button
            type="button"
            onClick={() => setPersonaFilter(null)}
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
              !personaFilter ? "bg-gray-900 text-white" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
            }`}
          >
            All ({data.ranked.length})
          </button>
          {Array.from(rankedByPersona.entries())
            .sort(([, a], [, b]) => b.length - a.length)
            .map(([persona, list]) => (
              <button
                key={persona}
                type="button"
                onClick={() => setPersonaFilter(personaFilter === persona ? null : persona)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  personaFilter === persona
                    ? "bg-gray-900 text-white"
                    : `${PERSONA_COLORS[persona] || "bg-gray-100 text-gray-600"} hover:brightness-95`
                }`}
              >
                {PERSONA_LABELS[persona] || persona} ({list.length})
              </button>
            ))}
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-4">
        <nav className="flex gap-6">
          {[
            { key: "ranked" as const, label: "Ranked", count: data.stats.ranked, color: "emerald" },
            { key: "filtered" as const, label: "Filtered", count: data.stats.filtered, color: "red" },
            { key: "existing" as const, label: "Existing Activity", count: data.stats.existingActivity, color: "amber" },
          ].map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => { setTab(t.key); setPersonaFilter(null); }}
              className={`pb-3 text-sm font-medium border-b-2 transition-colors ${
                tab === t.key
                  ? `border-${t.color}-600 text-${t.color}-600`
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {t.label}
              <span className={`ml-2 text-xs font-semibold px-2 py-0.5 rounded-full bg-${t.color}-100 text-${t.color}-700`}>
                {t.count}
              </span>
            </button>
          ))}
        </nav>
      </div>

      {/* Table */}
      <div className="overflow-x-auto border rounded-lg">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b">
            <tr>
              {tab === "ranked" && <th className="text-left px-4 py-3 font-medium text-gray-700 w-28">Score</th>}
              <th className="text-left px-4 py-3 font-medium text-gray-700">Name</th>
              <th className="text-left px-4 py-3 font-medium text-gray-700">Title</th>
              <th className="text-left px-4 py-3 font-medium text-gray-700">Company</th>
              <th className="text-left px-4 py-3 font-medium text-gray-700">Persona</th>
              <th className="text-right px-4 py-3 font-medium text-gray-700">Agents</th>
              <th className="text-left px-4 py-3 font-medium text-gray-700">Type</th>
              {tab !== "ranked" && <th className="text-left px-4 py-3 font-medium text-gray-700">Reason</th>}
            </tr>
          </thead>
          <tbody>
            {filteredList.map((contact, i) => (
              <ContactRow key={`${contact.company}-${contact.title}-${i}`} contact={contact} showScore={tab === "ranked"} />
            ))}
            {filteredList.length === 0 && (
              <tr>
                <td colSpan={tab === "ranked" ? 7 : 8} className="px-4 py-8 text-center text-gray-400 italic">
                  No contacts in this category
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
