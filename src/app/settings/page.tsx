import type { Metadata } from "next";
import { getConnectionStatus, availableToolkits, TOOLKITS, type ToolkitSlug } from "@/lib/composio";
import { isConnected as isGranolaConnected } from "@/lib/granola";
import { PLUM, BORDER, BORDER_SOFT, OK } from "@/lib/tokens";
import AppShell, { resolveViewer } from "@/app/AppShell";
import Gate from "@/app/Gate";
import BotScheduleClient from "./BotScheduleClient";
import AddBotNow from "./AddBotNow";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export const metadata: Metadata = { title: "Settings" };

// /settings — Daybreak Phase 6 (+ Arc V one-click web connections). The
// notetaker's schedule, the "bot missed my meeting" rescue, and per-person
// tool connections — now connectable right here, no Slack round-trip.

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border bg-white" style={{ borderColor: BORDER }}>
      <div className="border-b px-5 py-3" style={{ borderColor: BORDER_SOFT }}>
        <h2 className="text-sm font-semibold" style={{ color: PLUM }}>{title}</h2>
        {subtitle && <p className="mt-0.5 text-xs text-zinc-500">{subtitle}</p>}
      </div>
      <div className="p-5">{children}</div>
    </section>
  );
}

// A connected service (green ✓) or a one-click "Connect" button that kicks off
// OAuth and returns here. `href` absent → connected.
function ConnRow({ label, connected, href }: { label: string; connected: boolean; href?: string }) {
  if (connected) {
    return (
      <span
        className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium"
        style={{ borderColor: `${OK}55`, background: `${OK}0F`, color: OK }}
      >
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: OK }} />
        {label}
      </span>
    );
  }
  return (
    <a
      href={href}
      className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium no-underline transition-colors hover:border-zinc-400"
      style={{ borderColor: BORDER, background: "#FAFAFA", color: "#574B59" }}
    >
      <span className="text-[13px] leading-none" style={{ color: PLUM }}>+</span>
      Connect {label}
    </a>
  );
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ connected?: string; connect?: string; slug?: string }>;
}) {
  const viewer = await resolveViewer();
  if (!viewer) return <Gate />;
  const sp = await searchParams;

  let connections: Record<ToolkitSlug, boolean> | null = null;
  let granolaOn = false;
  if (process.env.COMPOSIO_API_KEY) {
    [connections, granolaOn] = await Promise.all([
      getConnectionStatus(viewer).catch(() => null),
      isGranolaConnected(viewer).catch(() => false),
    ]);
  }
  const toolkits = availableToolkits();
  const emailQ = encodeURIComponent(viewer);

  // Post-OAuth banner (Composio returns to ?connected=<slug>).
  const justConnected = sp.connected
    ? TOOLKITS.find((t) => t.slug === sp.connected)?.label ?? sp.connected
    : null;
  const connectError = sp.connect === "error" || sp.connect === "badslug";

  return (
    <AppShell
      active="settings"
      viewer={viewer}
      title="Settings"
      subtitle={`Notetaker, connections, and preferences — signed in as ${viewer}.`}
      maxWidth="max-w-4xl"
    >
      <div className="flex flex-col gap-5">
        <Section
          title="Connect your tools"
          subtitle="Reddy works your Google Workspace and HubSpot on your behalf. Click Connect once — it opens a secure OAuth window and you're set (or connect from Slack with /reddy-connect)."
        >
          {justConnected && (
            <div
              className="mb-4 rounded-lg border px-3 py-2 text-xs font-medium"
              style={{ borderColor: `${OK}55`, background: `${OK}0F`, color: OK }}
            >
              ✓ {justConnected} connected.
            </div>
          )}
          {connectError && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-600">
              Couldn&apos;t start that connection — try again, or use <code>/reddy-connect</code> in Slack.
            </div>
          )}

          {connections ? (
            <div className="flex flex-col gap-4">
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
                  Core — connect these
                </p>
                <div className="flex flex-wrap gap-2">
                  {toolkits.map((t) => (
                    <ConnRow
                      key={t.slug}
                      label={t.label}
                      connected={!!connections?.[t.slug]}
                      href={`/api/composio/connect?slug=${t.slug}`}
                    />
                  ))}
                </div>
              </div>
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">
                  Meetings <span className="normal-case font-normal text-zinc-400">(optional — the notetaker already covers calls)</span>
                </p>
                <ConnRow label="Granola" connected={granolaOn} href={`/api/oauth/granola/start?email=${emailQ}`} />
              </div>
            </div>
          ) : (
            <p className="text-sm text-zinc-400">
              Connection status unavailable right now — the tools still work from Slack.
            </p>
          )}
        </Section>

        <Section
          title="Send the notetaker to a meeting now"
          subtitle="For meetings the calendar flow missed — last-minute invites, someone else's calendar."
        >
          <AddBotNow />
        </Section>

        <Section
          title="Notetaker schedule"
          subtitle="Skip the bot on any meeting or series, or keep the recording but mute its post-meeting play card. Undo any time."
        >
          <BotScheduleClient viewerEmail={viewer} />
        </Section>
      </div>
    </AppShell>
  );
}
