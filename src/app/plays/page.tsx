import type { Metadata } from "next";
import AppShell, { resolveViewer } from "@/app/AppShell";
import Gate from "@/app/Gate";
import PlaysGallery from "@/components/PlaysGallery";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const metadata: Metadata = { title: "Plays" };

// /plays — the team's templated GTM workflows, browsable and one-click runnable
// (Arc VII). Same PLAYS registry the post-meeting Slack card curates from, so a
// play is the same play everywhere. Running one opens the Ask Reddy dock and
// tags the session under Plays in /s.

export default async function PlaysPage() {
  const viewer = await resolveViewer();
  if (!viewer) return <Gate />;
  return (
    <AppShell
      active="plays"
      viewer={viewer}
      title="Plays"
      subtitle="Templated workflows the team runs again and again — recaps, pricing, RFPs, redlines, catch-ups. Click one to kick it off."
      maxWidth="max-w-5xl"
    >
      <PlaysGallery />
    </AppShell>
  );
}
