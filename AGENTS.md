# Agent instructions

Read this before touching anything. See `docs/TRD.md` for the full technical
requirements and `docs/adding-a-route.md` for the route-authoring checklist —
this file is the operational gotchas that aren't obvious from reading the
code, mostly learned the hard way across prior sessions.

## Deploy path

**Never run `wrangler deploy` directly against this repo's real account.**
The deploy path is:

```bash
bunx wrangler deploy --dry-run --outdir dist   # build only, writes dist/
CLOUDFLARE_API_TOKEN=... bun run scripts/bootstrap.ts   # raw Cloudflare API upload
```

`bootstrap.ts` is a raw multipart upload against the Cloudflare REST API, not
`wrangler deploy` — bindings (D1, KV, R2, AI, rate limiter, every secret) are
built by hand in that script from `process.env`, not read from
`wrangler.jsonc`. If you add a new required binding, add it to
`bootstrap.ts`'s `bindings` array or it silently won't exist in production
(this has caused real outages — a missing `ratelimit` binding crashed every
`/api/*` request before it ever reached a handler).

**Secret bindings persist across deploys even when omitted from a
`bootstrap.ts` run** — Cloudflare does not clear a `secret_text` binding
just because a later deploy's `bindings` array doesn't include it. Don't
assume an unconfigured-looking feature means its secret was wiped; check via
`GET /accounts/{id}/workers/scripts/{name}/bindings` before concluding that.
To actually remove one, `DELETE /accounts/{id}/workers/scripts/{name}/secrets/{name}`.

Every optional provider/channel (Gemini, DeepSeek, OpenRouter, MCP,
Telegram, Analytics reconciliation) is opt-in via an env var passed to
`bootstrap.ts` — omitting one just means that deploy doesn't touch that
secret, not that the feature is disabled if it was already configured.

## `wrangler.jsonc` placeholders

`database_id`/KV `id` are literally `"REPLACE_WITH_D1_ID"` /
`"REPLACE_WITH_KV_ID"` in the committed file — real IDs only exist in the
gitignored `.flare-kit.state.json`. Any command that needs them locally
(`wrangler dev --remote`, `wrangler tail`, `wrangler d1 execute` against the
real DB) requires temporarily patching `wrangler.jsonc` with the real values
from `.flare-kit.state.json`, then reverting (`git diff wrangler.jsonc`
must be empty) before committing. Never commit real IDs into this file.

## Migrations

**Never run `bun run db:generate` (or any `drizzle-kit generate`) blindly.**
This repo's migration history predates `drizzle-kit`'s journal tracking
(`drizzle/meta/` doesn't exist) — `generate` re-baselines the entire schema
as a new `0000_*.sql` that collides with the real, already-applied
`0000_init.sql`. Hand-write `drizzle/migrations/000N_description.sql`
matching the existing numbered convention. `bootstrap.ts` applies unapplied
migrations automatically on every deploy (tracked via a `__migrations`
table) — no separate migration step.

## Testing

Two separate Vitest configs that cannot share a runtime:

- `bun test` / `vitest.config.ts` — plain Node environment. Fast, no
  bindings. Mocks everything binding-shaped.
- `bun run test:integration` / `vitest.integration.config.ts` — the real
  Workers runtime via `@cloudflare/vitest-plugin` (real D1, KV, R2,
  `crypto.subtle`, migrations auto-applied). This is what catches real
  production bugs a Node-environment test can't see (a missing binding, a
  Drizzle/D1 schema mismatch, a Workers-only PBKDF2 iteration cap).

**`cloudflare:test` in this repo's version of `@cloudflare/vitest-plugin`
has no in-isolate `fetchMock`** (unlike `@cloudflare/vitest-pool-workers`).
A Node-side `vi.stubGlobal("fetch", ...)` never reaches code running inside
the workerd isolate these integration tests exercise. Any function that
needs to make a real outbound `fetch` and be tested (`cron.ts`,
`telegram.ts`) takes an injectable `fetchImpl: typeof fetch = fetch`
parameter instead — follow that pattern for new outbound-fetch code that
needs integration-test coverage.

Workers AI (`env.AI.run`) has no local simulator and bills real Neurons even
in Miniflare tests — stub it in `beforeEach` (see
`test/integration/ai-memory.test.ts`).

## Live verification

Every feature in this repo is verified against the real production deploy
(`https://flare-kit-app.jostoztado.workers.dev`), not just typechecked —
curl the live endpoint, inspect `wrangler tail --format json` for real
errors, then clean up test data via the D1 REST query endpoint (`DELETE
FROM messages; DELETE FROM ai_usage; DELETE FROM accounts; DELETE FROM
sessions; DELETE FROM users;` — always in that order, FK-adjacent tables
first even though nothing enforces it). Keep doing this for new features;
"it typechecks" is not "it works."

`wrangler tail --format json` output is **not** newline-delimited JSON — it's
concatenated pretty-printed objects. Parse it with a brace-depth counter
(see any `_eval` call in this session's history that builds `objs` by
tracking `{`/`}` depth), not a line-based JSON parser.

Cloudflare gives no way to manually trigger a deployed Worker's Cron
Trigger in production, and `wrangler dev --test-scheduled --remote`'s
`/cdn-cgi/handler/scheduled` route is itself intercepted and blocked by
Cloudflare's edge (`error 1042`) before reaching the dev Worker. To verify
scheduled-handler logic live, replicate its exact D1/external-API calls
directly against production (see `src/server/cron.ts`'s verification in the
README) rather than fighting the dev-server routing.

## Secrets in chat

Real API keys/tokens pasted into a conversation are treated as
already-compromised — proceed with them, but always remind the user to
rotate afterward. Never echo a full key back in a response.

## Budget gate

`bun run budget:check` must stay ≤ 80% of every free-tier resource
(`budget.config.ts`'s `ROUTE_MIX` model) before any feature is considered
done. A new D1-writing route changes the weighted projection — rerun the
gate, don't assume it still passes.
