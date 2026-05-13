"use client";

import { useState, useEffect } from "react";
import type { ReviewItem } from "@/lib/types";

const ACTION_BADGE_CLASSES: Record<ReviewItem["action"], string> = {
  exclude: "bg-red-100 text-red-800",
  tag: "bg-yellow-100 text-yellow-800",
  prospect: "bg-green-100 text-green-800",
};

interface ReviewTableProps {
  items: ReviewItem[];
  onDecisionsChange: (decisions: Record<string, "accept" | "reject">) => void;
}

export function ReviewTable({ items, onDecisionsChange }: ReviewTableProps) {
  const [decisions, setDecisions] = useState<Record<string, "accept" | "reject">>(() => {
    const initial: Record<string, "accept" | "reject"> = {};
    for (const item of items) {
      initial[item.name] = "accept";
    }
    return initial;
  });

  useEffect(() => {
    onDecisionsChange(decisions);
  }, [decisions, onDecisionsChange]);

  function toggle(name: string) {
    setDecisions((prev) => {
      const next = { ...prev };
      next[name] = prev[name] === "accept" ? "reject" : "accept";
      return next;
    });
  }

  return (
    <div className="overflow-x-auto border rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b">
          <tr>
            <th className="text-left px-4 py-3 font-medium text-gray-700">Company</th>
            <th className="text-left px-4 py-3 font-medium text-gray-700">Titles</th>
            <th className="text-left px-4 py-3 font-medium text-gray-700">Action</th>
            <th className="text-left px-4 py-3 font-medium text-gray-700">Category</th>
            <th className="text-left px-4 py-3 font-medium text-gray-700">Rationale</th>
            <th className="text-center px-4 py-3 font-medium text-gray-700">Decision</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const isRejected = decisions[item.name] === "reject";
            const titlesShown = item.titles.slice(0, 5);
            const remaining = item.titles.length - titlesShown.length;

            return (
              <tr
                key={item.name}
                className={`border-b ${isRejected ? "bg-gray-100 opacity-60" : ""}`}
              >
                <td className="px-4 py-3 font-medium text-gray-900">{item.name}</td>
                <td className="px-4 py-3 text-gray-600">
                  {titlesShown.join(", ")}
                  {remaining > 0 && (
                    <span className="text-gray-400 ml-1">+{remaining} more</span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${ACTION_BADGE_CLASSES[item.action]}`}
                  >
                    {item.action}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-600">{item.category || "—"}</td>
                <td className="px-4 py-3 text-gray-600 max-w-xs truncate">
                  {item.rationale || "—"}
                </td>
                <td className="px-4 py-3 text-center">
                  <button
                    type="button"
                    onClick={() => toggle(item.name)}
                    className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                      isRejected
                        ? "bg-gray-200 text-gray-600 hover:bg-gray-300"
                        : "bg-green-100 text-green-800 hover:bg-green-200"
                    }`}
                  >
                    {isRejected ? "Rejected" : "Accepted"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
