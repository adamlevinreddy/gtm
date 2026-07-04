import type { Metadata } from "next";
import AppShell from "@/app/AppShell";
import BotScheduleClient from "./BotScheduleClient";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = { title: "Bot schedule" };

export default function BotSchedulePage() {
  return (
    <AppShell
      active="schedule"
      title="Bot schedule"
      subtitle="Upcoming meetings the notetaker will join — skip any meeting or recurring series."
      maxWidth="max-w-4xl"
    >
      <BotScheduleClient />
    </AppShell>
  );
}
