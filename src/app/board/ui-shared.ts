// Client-safe board UI helpers (NO db / work-items imports). Used by the server
// page, BoardClient, FilterBar, BoardSwitcher. Pure presentation logic only.

export const PLUM = "#773D72";

export const KIND_LABEL: Record<string, string> = {
  pricing_proposal: "Pricing", deck_qbr: "QBR deck", meeting_prep: "Prep",
  prep_custom_demo: "Demo prep", rfp_response: "RFP", contract_redline: "Redline",
  followup_email: "Follow-up", book_meeting: "Book mtg", reengage_tickler: "Re-engage",
  recording_link: "Recording", scheduling: "Scheduling", account_research: "Research",
  enablement_collateral: "Enablement", crm_update: "CRM", log_to_hubspot: "HubSpot note",
  propose_stage_move: "Stage move", action_items: "Action", generic: "Task",
};

// All assignable kinds, grouped for the filter dropdown (label → value).
export const KIND_OPTIONS: { value: string; label: string }[] = Object.entries(
  KIND_LABEL
).map(([value, label]) => ({ value, label }));

// --- Assignee identity --------------------------------------------------------

/** Title-cased display name from an email local-part: "jane.doe" → "Jane Doe". */
export function personName(email: string | null | undefined): string {
  if (!email) return "Unassigned";
  const local = email.split("@")[0];
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join(" ") || local;
}

/** Up to two initials for the avatar: "jane.doe" → "JD"; single token → first 2. */
export function personInitials(email: string | null | undefined): string {
  if (!email) return "·";
  const parts = email.split("@")[0].split(/[._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return email.split("@")[0].slice(0, 2).toUpperCase();
}

// Stable per-person avatar color. Deterministic hash → curated palette so the
// same person is always the same hue (and it never clashes with the plum UI).
const AVATAR_PALETTE: { bg: string; fg: string }[] = [
  { bg: "#E9DDE8", fg: "#6B3266" }, // plum
  { bg: "#DCE7EF", fg: "#2F5872" }, // steel blue
  { bg: "#DCEBE0", fg: "#356048" }, // green
  { bg: "#F1E2D2", fg: "#8A5A24" }, // amber
  { bg: "#E6DEF2", fg: "#564080" }, // violet
  { bg: "#F2DEE5", fg: "#8C3A55" }, // rose
  { bg: "#DDE9E9", fg: "#2F6160" }, // teal
  { bg: "#EAE6D6", fg: "#6E6231" }, // olive
];

export function avatarColor(email: string | null | undefined): {
  bg: string;
  fg: string;
} {
  if (!email) return { bg: "#EDEDF0", fg: "#9A9AA3" }; // muted = unassigned
  let h = 0;
  for (let i = 0; i < email.length; i++) {
    h = (h * 31 + email.charCodeAt(i)) | 0;
  }
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

// --- Misc presentation --------------------------------------------------------

export function relTime(d: Date): string {
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h`;
  const days = Math.round(h / 24);
  if (days === 1) return "1d";
  if (days < 30) return `${days}d`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function dueLabel(d: Date): { text: string; cls: string } {
  const diff = d.getTime() - Date.now();
  const text = `due ${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  if (diff < 0) return { text: `${text} · overdue`, cls: "text-red-700" };
  if (diff < 7 * 86400000) return { text, cls: "text-amber-700" };
  return { text, cls: "text-zinc-400" };
}
