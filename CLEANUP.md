# Cleanup — firehose debug instrumentation

This file tracks temporary debug/verbosity code added while chasing pricing-bot failures. Delete this file + the items below once the pricing flow is reliable.

## What to trim

1. **`src/lib/pricing-agent.ts`** — currently dumps every trace entry to Slack as its own message (`dumpTraceToSlack`). Once failures are rare:
   - Replace `dumpTraceToSlack(header)` with a single concise message: iteration count, last tool name, last tool error message, trace KV key for anyone who wants the firehose.
   - Keep `TRACE` array + `kvSet` on the trace key — cheap insurance for future debugging.
   - Drop `traceInfo` calls that are purely informational (keep exec_output captures — they're load-bearing for compile_pdf debugging).
   - Change `kvSet(TRACE_KEY, TRACE)` TTL to 7 days (currently 30) and trim to last 100 entries.

2. **`scripts/debug-pricing.mjs`** — keep. Useful forever. Maybe promote to a `pnpm debug:pricing` script in `package.json`.

3. **`docs/pricing-bot.md` Debugging section** — keep, but update once the final UX settles.

4. **Delete this `CLEANUP.md`** when all of the above is done.

## How to know we're ready

- Three consecutive `pricing-build` runs with varied inputs all succeed (PDF posted, ✅ reaction, commit on library main).
- No red reaction on any `pricing-build` or `pricing-check` for a full week.
