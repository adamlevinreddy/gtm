import Link from "next/link";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { unreadNotificationCount } from "@/lib/board-world";
import { VIEWER_COOKIE } from "@/lib/team";
import ViewerPicker from "./board/ViewerPicker";

// ---------------------------------------------------------------------------
// The ONE app chrome. Every page renders inside this shell so navigation
// never jumps: brand → Home / Meetings / Bot schedule / Board / Inbox →
// identity picker, in that order, in the same place, on every screen.
// Pages contribute only a title/subtitle, optional right-side actions, and
// their content. Don't hand-roll another header.
// ---------------------------------------------------------------------------

export const PLUM = "#773D72";

export type NavKey = "home" | "meetings" | "schedule" | "board" | "inbox";

const NAV: Array<{ key: NavKey; label: string; href: string }> = [
  { key: "home", label: "Home", href: "/" },
  { key: "meetings", label: "Meetings", href: "/board/meetings" },
  { key: "schedule", label: "Bot schedule", href: "/board/meetings/schedule" },
  { key: "board", label: "Board", href: "/board" },
  { key: "inbox", label: "Inbox", href: "/board/inbox" },
];

export async function resolveViewer(asParam?: string): Promise<string> {
  const cookieStore = await cookies();
  return (
    (asParam && asParam.includes("@") ? asParam : undefined) ||
    cookieStore.get(VIEWER_COOKIE)?.value ||
    process.env.BOARD_DEFAULT_VIEWER ||
    "adam@reddy.io"
  );
}

export default async function AppShell({
  active,
  title,
  subtitle,
  actions,
  maxWidth = "max-w-7xl",
  viewer: viewerProp,
  children,
}: {
  active: NavKey;
  /** Page title row; omit for pages that open with their own hero card. */
  title?: string;
  subtitle?: ReactNode;
  /** Page-specific controls rendered right of the title (switchers, tabs). */
  actions?: ReactNode;
  maxWidth?: string;
  /** Pass when the page already resolved the viewer (e.g. honoring ?as=). */
  viewer?: string;
  children: ReactNode;
}) {
  const viewer = viewerProp ?? (await resolveViewer());
  const unread = await unreadNotificationCount(viewer).catch(() => 0);

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50">
      <header className="sticky top-0 z-40 border-b border-zinc-200/80 bg-white/85 backdrop-blur">
        <div className={`mx-auto flex h-14 items-center gap-6 px-6 ${maxWidth} w-full`}>
          <Link href="/" className="flex shrink-0 items-center gap-2.5 no-underline">
            <span
              className="flex h-7 w-7 items-center justify-center rounded-lg text-sm font-bold text-white"
              style={{ background: PLUM }}
              aria-hidden
            >
              R
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-zinc-900">
              Reddy <span style={{ color: PLUM }}>GTM</span>
            </span>
          </Link>

          <nav className="flex min-w-0 items-center gap-1 overflow-x-auto" aria-label="Primary">
            {NAV.map((item) => {
              const isActive = item.key === active;
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className="relative shrink-0 rounded-md px-2.5 py-1.5 text-sm font-medium no-underline transition-colors"
                  style={
                    isActive
                      ? { color: PLUM, background: "#F5EDF4" }
                      : { color: "#63566A" }
                  }
                >
                  {item.label}
                  {item.key === "inbox" && unread > 0 && (
                    <span
                      className="ml-1.5 inline-flex min-w-[18px] items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums text-white"
                      style={{ background: PLUM }}
                    >
                      {unread > 99 ? "99+" : unread}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>

          <div className="ml-auto shrink-0">
            <ViewerPicker viewer={viewer} />
          </div>
        </div>
      </header>

      <main className={`mx-auto w-full flex-1 px-6 py-6 ${maxWidth}`}>
        {(title || actions) && (
          <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
            <div>
              {title && (
                <h1 className="text-xl font-semibold tracking-tight text-zinc-900">{title}</h1>
              )}
              {subtitle && <p className="mt-0.5 text-sm text-zinc-500">{subtitle}</p>}
            </div>
            {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
