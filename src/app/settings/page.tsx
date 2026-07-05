import type { Metadata } from "next";
import { getConnectionStatus, TOOLKITS } from "@/lib/composio";
import { PLUM, BORDER, BORDER_SOFT, OK } from "@/lib/tokens";
import AppShell, { resolveViewer } from "@/app/AppShell";
import WelcomeGate from "@/app/WelcomeGate";
import BotScheduleClient from "./BotScheduleClient";
import AddBotNow from "./AddBotNow";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export const metadata: Metadata = { title: "Settings" };

// /settings — Daybreak Phase 6. The notetaker's schedule, the "bot missed
// my meeting" rescue, and per-person tool connections, in one place.

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
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

export default async function SettingsPage() {
  const viewer = await resolveViewer();
  if (!viewer) return <WelcomeGate />;

  let connections: Record<string, boolean> | null = null;
  if (process.env.COMPOSIO_API_KEY) {
    connections = await getConnectionStatus(viewer).catch(() => null);
  }

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
          title="Send the notetaker to a meeting now"
          subtitle="For meetings the calendar flow missed — last-minute invites, someone else's calendar."
        >
          <AddBotNow />
        </Section>

        <Section
          title="Notetaker schedule"
          subtitle="Skip any upcoming meeting or recurring series; undo any time."
        >
          <BotScheduleClient />
        </Section>

        <Section
          title="Your connections"
          subtitle="Tools the assistant can use on your behalf. Connect or refresh via Slack: run /reddy-connect or say “@Reddy-GTM set me up”."
        >
          {connections ? (
            <div className="flex flex-wrap gap-2">
              {TOOLKITS.map((t) => {
                const on = !!connections?.[t.slug];
                return (
                  <span
                    key={t.slug}
                    className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-medium"
                    style={{
                      borderColor: on ? `${OK}55` : BORDER,
                      background: on ? `${OK}0F` : "#FAFAFA",
                      color: on ? OK : "#8F8291",
                    }}
                  >
                    <span
                      className="h-1.5 w-1.5 rounded-full"
                      style={{ background: on ? OK : "#D4D4D8" }}
                    />
                    {t.label}
                  </span>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-zinc-400">
              Connection status unavailable right now — the tools still work from Slack.
            </p>
          )}
        </Section>
      </div>
    </AppShell>
  );
}
