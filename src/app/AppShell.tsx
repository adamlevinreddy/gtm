import Link from "next/link";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { unreadNotificationCount } from "@/lib/board-world";
import { VIEWER_COOKIE } from "@/lib/team";
import { verifyViewerCookie } from "@/lib/viewer";
import ViewerPicker from "./board/ViewerPicker";
import Gate from "@/app/Gate";
import CommandK from "@/components/CommandK";
import { ssoEnabled } from "@/lib/workos";

// ---------------------------------------------------------------------------
// The ONE app chrome. Every page renders inside this shell so navigation
// never jumps: brand → Home / Meetings / Board / Inbox / Settings →
// identity picker, in that order, in the same place, on every screen.
// Pages contribute only a title/subtitle, optional right-side actions, and
// their content. Don't hand-roll another header.
//
// Identity is BLOCKING (Daybreak Phase 6): without a verified viewer cookie
// the shell renders the welcome gate instead of any page.
// ---------------------------------------------------------------------------

export const PLUM = "#773D72";

export type NavKey = "home" | "meetings" | "sessions" | "library" | "tasks" | "board" | "inbox" | "settings";

const NAV: Array<{ key: NavKey; label: string; href: string }> = [
  { key: "home", label: "Home", href: "/" },
  { key: "meetings", label: "Meetings", href: "/meetings" },
  { key: "sessions", label: "Sessions", href: "/s" },
  { key: "library", label: "Library", href: "/library" },
  { key: "tasks", label: "Tasks", href: "/tasks" },
  { key: "board", label: "Board", href: "/board" },
  { key: "inbox", label: "Inbox", href: "/board/inbox" },
  { key: "settings", label: "Settings", href: "/settings" },
];

/** ?as= override or the verified cookie — NULL when anonymous. Pages that
 * pass the result to AppShell get the blocking gate for free; never re-add
 * a default here (that's how "everyone is adam@" came back once already).
 * The ?as= convenience is honor-system: it dies the moment SSO is on. */
export async function resolveViewer(asParam?: string): Promise<string | null> {
  const cookieStore = await cookies();
  return (
    (!ssoEnabled() && asParam && asParam.includes("@") ? asParam : null) ||
    verifyViewerCookie(cookieStore.get(VIEWER_COOKIE)?.value)
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
  /** Pass when the page already resolved the viewer (e.g. honoring ?as=).
   * null/undefined → the shell falls back to the cookie, then the gate. */
  viewer?: string | null;
  children: ReactNode;
}) {
  const cookieStore = await cookies();
  const cookieViewer = verifyViewerCookie(cookieStore.get(VIEWER_COOKIE)?.value);

  // No identity → the gate, nothing else. (?as= via viewerProp keeps
  // automation/deep-link flows working without a browser cookie.)
  const viewer = viewerProp ?? cookieViewer ?? null;
  if (!viewer) return <Gate />;

  const unread = await unreadNotificationCount(viewer).catch(() => 0);

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50">
      {/* Full-width bar with FIXED edges — brand pinned left, picker pinned
          right, independent of each page's content width. Never give this
          container a page-driven max-width: that's what made the nav "fly
          around" between pages. */}
      <header className="sticky top-0 z-40 border-b border-zinc-200/80 bg-white/85 backdrop-blur">
        <div className="flex h-14 w-full items-center gap-6 px-6">
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

          <div className="ml-auto flex shrink-0 items-center gap-3">
            <CommandK />
            <ViewerPicker viewer={viewer} sso={ssoEnabled()} />
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
