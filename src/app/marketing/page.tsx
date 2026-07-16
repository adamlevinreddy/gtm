import type { Metadata } from "next";
import AppShell, { resolveViewer } from "@/app/AppShell";
import Gate from "@/app/Gate";
import { listLibraryFiles, type LibraryFile } from "@/lib/library";
import MarketingClient from "./MarketingClient";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

export const metadata: Metadata = { title: "Marketing" };

// /marketing — the go-to-market content surface (distinct from the sales/board
// brain). First use case: writing blog posts. The chat here runs on FABLE with
// the live website source + our marketing corpus + every customer call, and the
// upload area commits new material straight into the KB so the next sandbox has
// it. SEO/Search-Console APIs come later.

export default async function MarketingPage() {
  const viewer = await resolveViewer();
  if (!viewer) return <Gate />;

  // The current marketing library (corpora/marketing/**) — prior blogs, briefs,
  // brand material, and anything uploaded here. Best-effort; the chat still
  // works if this can't load.
  let materials: LibraryFile[] = [];
  const pat = process.env.PRICING_LIBRARY_GITHUB_PAT;
  if (pat) {
    try {
      const all = await listLibraryFiles(pat);
      materials = all
        .filter((f) => f.category === "marketing")
        .sort((a, b) => a.path.localeCompare(b.path));
    } catch {
      materials = [];
    }
  }

  return (
    <AppShell
      active="marketing"
      viewer={viewer}
      title="Marketing"
      subtitle="Create on-brand content with Reddy — grounded in our site, our library, and real customer calls. Runs on Fable."
      maxWidth="max-w-6xl"
    >
      <MarketingClient materials={materials} />
    </AppShell>
  );
}
