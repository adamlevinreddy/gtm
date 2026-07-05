// THE date/time formatters. The audit found three divergent hand-rolled PT
// formatters — every surface formats through these instead. All display is
// America/Los_Angeles (the whole team is Pacific).

const TZ = "America/Los_Angeles";

function safeDate(iso: string | Date | null | undefined): Date | null {
  if (!iso) return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "Wed, Jul 8, 9:00 AM PT" */
export function fmtDayTimePT(iso: string | Date | null | undefined): string {
  const d = safeDate(iso);
  if (!d) return "";
  return (
    new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(d) + " PT"
  );
}

/** "9:00 AM" */
export function fmtTimePT(iso: string | Date | null | undefined): string {
  const d = safeDate(iso);
  if (!d) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "numeric",
    minute: "2-digit",
  }).format(d);
}

/** "Jul 8" */
export function fmtDayPT(iso: string | Date | null | undefined): string {
  const d = safeDate(iso);
  if (!d) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    month: "short",
    day: "numeric",
  }).format(d);
}

/** "Wednesday, Jul 8" */
export function fmtWeekdayPT(iso: string | Date | null | undefined): string {
  const d = safeDate(iso);
  if (!d) return "";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(d);
}

/** Stable PT calendar-day key: "2026-07-08" — for grouping. */
export function dayKeyPT(iso: string | Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(iso instanceof Date ? iso : new Date(iso));
}

/** Epoch ms of midnight PT, `daysAgo` days back — for "today"/"overnight"
 * windows that respect the team's calendar day, not UTC's. */
export function ptStartOfDayMs(daysAgo = 0): number {
  const now = new Date();
  const ymd = dayKeyPT(now); // "YYYY-MM-DD" in PT
  const offsetName = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "shortOffset" })
    .formatToParts(now)
    .find((p) => p.type === "timeZoneName")?.value ?? "GMT-8";
  const m = offsetName.match(/GMT([+-])(\d{1,2})/);
  const offsetHours = m ? (m[1] === "-" ? Number(m[2]) : -Number(m[2])) : 8;
  return Date.parse(`${ymd}T00:00:00Z`) + offsetHours * 3600_000 - daysAgo * 24 * 3600_000;
}

/** "47m" / "1h 12m" from two ISO timestamps; "" when either is missing. */
export function fmtDuration(start: string | null | undefined, end: string | null | undefined): string {
  const s = safeDate(start);
  const e = safeDate(end);
  if (!s || !e) return "";
  const mins = Math.round((e.getTime() - s.getTime()) / 60000);
  if (mins <= 0 || mins > 24 * 60) return "";
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60 ? `${mins % 60}m` : ""}`.trim();
}
