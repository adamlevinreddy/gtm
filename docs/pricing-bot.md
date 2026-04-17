# Pricing Slack commands

Two new GTM Classifier Slack commands backed by a persistent Vercel Sandbox.

## Commands

### `pricing-build`
Generate a customer pricing proposal PDF from natural-language input. The bot picks a stylistic reference from the proposal library, writes a new `proposal.tsx`, runs `npx tsx` to compile the PDF, and uploads it to the Slack thread.

```
@GTM Classifier pricing-build
Company: Acme Corp
Logo: https://acme.com/logo.png
Model: 500 agents, 2-year, BYOT preferred, Tapestry-style layout
```

Reactions: 🛠️ → ✅ (or ❌ on failure).

### `pricing-check`
Research/Q&A against the proposal library + `PRICING_ASSUMPTIONS.md`. No files are written; the bot replies in-thread with reasoning + cited proposals.

```
@GTM Classifier pricing-check what's a fair rate for a 1000-agent BYOT contract similar to Tapestry?
```

Reactions: 🔍 → ✅.

### Thread continuation (no prefix needed)
Once a `pricing-build` or `pricing-check` thread is active, **any in-thread mention of the bot** routes back to the same sandbox with the existing mode + history.

```
@GTM Classifier change the per-seat rate to $42 and add a savings callout
```

The persistent sandbox auto-resumes from snapshot, so iteration works even days later.

## Architecture

| Piece | File | Notes |
|---|---|---|
| Slack dispatch | `src/app/api/slack/events/route.ts` | New keyword branches + thread-continuation lookup against `pricing:thread:{thread_ts}` KV key. |
| Sandbox spin-up | `src/app/api/pricing/route.ts` | `Sandbox.get/create` with persistent name `pricing-{thread_ts}`, 60-min session timeout (extendable to 5h Pro max), 30-day snapshot expiration. |
| Driver builder | `src/lib/pricing-agent.ts` | Generates `pricing-driver.mjs` — an Anthropic tool-use loop with tools for file ops, PDF compile, and Slack upload. |
| Reference library | `github.com/ReddySolutions/pricing` | 14 customer proposals, `INDEX.md` catalog, `PRICING_ASSUMPTIONS.md`. Cloned into the sandbox once on first turn. |

## Required env vars (Vercel)

Set these in the Vercel project settings (Production + Preview):

| Var | Purpose | Where to get it |
|---|---|---|
| `PRICING_LIBRARY_GITHUB_PAT` | Sandbox clones the private `ReddySolutions/pricing` repo AND pushes new/updated proposals back. | GitHub → Settings → Developer settings → Fine-grained PAT → repo `ReddySolutions/pricing`, **Contents: Read and write**. Set expiry to 1 year or longer. |

The pricing route also reuses already-configured env vars: `AI_GATEWAY_API_KEY`, `SLACK_BOT_TOKEN`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`.

## Library auto-sync

After every successful `pricing-build` turn, the driver runs `git add Brand Pricing/ && git commit && git pull --rebase && git push` against `ReddySolutions/pricing` `main`. This keeps the canonical library in sync with whatever proposals the bot has built — so iterations compound, and a future pricing-check query can reference a proposal generated an hour ago.

- Commit author: `Reddy Pricing Bot <pricing-bot@reddy.io>`
- Commit message format: `Pricing build turn {N} (thread {ts})`
- Push failure is non-fatal — the Slack reply still succeeds, but the bot posts a ⚠️ warning in-thread so you know the library is out of sync. Safe to rerun a subsequent turn; it'll just commit+push everything accumulated.
- `pricing-check` mode never writes, never pushes.

## Sandbox SDK migration note

This work upgraded `@vercel/sandbox` from `^1.9.0` to `2.0.0-beta.14` (persistent-sandbox beta). Breaking change: `sandbox.sandboxId` → `sandbox.name`. All existing sandbox call sites (`pipeline`, `agent`, `extract`, `persona`) opt out of persistence with `persistent: false`. Only the pricing route uses persistent mode.

## Verification checklist

After deploy + env-var setup:

1. **Library push**: `git ls-remote https://github.com/ReddySolutions/pricing main` shows the consolidated commit.
2. **Existing flows**: trigger `@GTM Classifier campaign last week's google ads` and `process` (pipeline) — confirm no regression.
3. **Build happy path**: `@GTM Classifier pricing-build` with a fake company, logo URL, and pricing model. PDF in thread within ~5 min.
4. **Build iteration**: reply "swap to a purple/lime palette" — new PDF in thread within ~2 min, sandbox auto-resumed.
5. **Long-idle resume**: reply ~24h later, "drop the 1-year tier" — sandbox auto-resumes from snapshot, recompiles.
6. **Check happy path**: `@GTM Classifier pricing-check what's a fair rate for 200 agents BYOT?` — bot cites `PRICING_ASSUMPTIONS.md` numbers and at least one comparable proposal.
7. **Check follow-up**: "what did we charge Robinhood for similar?" — bot pulls actual numbers from `robinhood-proposal/proposal.tsx`.
8. **Vercel dashboard**: thread sandbox shows up with snapshot expiration ~30 days out.
9. **PDF in Slack**: file appears inline (not as a link), downloads as a valid PDF.

## Known limitations

- LabCorp, PDS Health, and Lowe's exist as PDFs only in `~/Downloads/` — no React source. Documented in `INDEX.md`. If a request comes in for any of these as a "make it like X" reference, the bot will fall back to the closest catalog match.
- Conversation history is trimmed to the last 30 messages per thread to bound token cost.
- Sandbox per-session timeout is 60 min; one Claude tool-use loop must complete within that. Cross-turn state is preserved via persistent snapshots.
