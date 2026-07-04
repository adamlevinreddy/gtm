import Link from "next/link";
import BotScheduleClient from "./BotScheduleClient";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const PLUM = "#773D72";

export default function BotSchedulePage() {
  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-7">
      <div className="mx-auto max-w-4xl">
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg text-lg" style={{ background: "#F0E8EF" }}>
            🤖
          </div>
          <div className="mr-2">
            <h1 className="text-xl font-semibold tracking-tight text-zinc-900">Bot schedule</h1>
            <p className="text-sm text-zinc-500">
              Upcoming meetings the notetaker will join — skip any meeting or recurring series.
            </p>
          </div>
          <div className="ml-auto flex items-center gap-1 rounded-lg border border-zinc-200 bg-white p-0.5">
            <Link
              href="/"
              className="rounded-md px-2.5 py-1 text-sm font-medium text-zinc-600 no-underline hover:bg-zinc-50"
            >
              Home
            </Link>
            <Link
              href="/board"
              className="rounded-md px-2.5 py-1 text-sm font-medium text-zinc-600 no-underline hover:bg-zinc-50"
            >
              Boards
            </Link>
            <Link
              href="/board/meetings"
              className="rounded-md px-2.5 py-1 text-sm font-medium text-zinc-600 no-underline hover:bg-zinc-50"
            >
              Meetings
            </Link>
            <span
              className="rounded-md px-2.5 py-1 text-sm font-medium text-white"
              style={{ background: PLUM }}
            >
              Bot schedule
            </span>
          </div>
        </header>

        <BotScheduleClient />
      </div>
    </main>
  );
}
