import { avatarColor, personInitials, personName } from "./ui-shared";

// Assignee chip: colored initials avatar + name, with a 🤖 marker when the bot
// is co-assigned. "Unassigned" renders muted + italic so an unowned card is
// visually distinct. Pure presentational — safe in server and client trees.

export function Avatar({
  email,
  size = 18,
}: {
  email: string | null | undefined;
  size?: number;
}) {
  const { bg, fg } = avatarColor(email);
  return (
    <span
      title={email ? personName(email) : "Unassigned"}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        minWidth: size,
        background: bg,
        color: fg,
        fontSize: Math.round(size * 0.42),
        lineHeight: 1,
      }}
      aria-hidden="true"
    >
      {personInitials(email)}
    </span>
  );
}

export function Assignee({
  email,
  botAssigned,
  size = 18,
  className = "",
}: {
  email: string | null | undefined;
  botAssigned?: boolean;
  size?: number;
  className?: string;
}) {
  const unassigned = !email;
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <Avatar email={email} size={size} />
      <span
        className={
          unassigned
            ? "italic text-zinc-400"
            : "text-zinc-600"
        }
      >
        {personName(email)}
      </span>
      {botAssigned && (
        <span title="Reddy bot co-assigned" aria-label="bot assigned">
          🤖
        </span>
      )}
    </span>
  );
}
