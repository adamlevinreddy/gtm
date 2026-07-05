"use client";

import { MessageSquareText } from "lucide-react";
import { askReddy } from "@/components/ChatDock";
import { PLUM } from "@/lib/tokens";

// One click → the global dock, pre-scoped to this account's transcripts.
export default function AccountAsk({ account, botIds }: { account: string; botIds: string[] }) {
  return (
    <button
      type="button"
      onClick={() =>
        askReddy(
          botIds.length
            ? {
                botIds,
                scopeNote: `everything about the account ${account}`,
                title: `Ask about ${account}`,
                scopeLabel: `${botIds.length} meeting${botIds.length === 1 ? "" : "s"}`,
              }
            : { question: `What do we know about ${account}? Check HubSpot and the library.`, title: `Ask about ${account}` },
        )
      }
      className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold text-white"
      style={{ background: PLUM }}
    >
      <MessageSquareText size={14} /> Ask about this account
    </button>
  );
}
