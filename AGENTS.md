# AGENTS.md

Read this first if you've never seen this repo before — it tells you what
`flare-kit` is, how it's laid out, and how to work in it without having to
read every file to figure that out.

## What this is

A full-stack, $0/month micro-SaaS boilerplate that runs entirely on
Cloudflare's Free Tier: Workers (SSR + API), D1 (SQL), KV, R2, native rate
limiting, and a built-in AI assistant subsystem (multi-provider chat,
vision, web search, MCP tool-calling, a Telegram channel, and a scheduled
usage-reconciliation job). Every free-tier limit it's designed against is
documented and measured in `docs/TRD.md`; every claim in this repo is
backed by a real deploy, not just a passing typecheck — see "Verified in
this repo" in `README.md`.

No Node.js server, no Vercel/Netlify function, no Durable Objects, no paid
add-on required to run it. Optional AI providers (Gemini, DeepSeek,
OpenRouter) and the Telegram channel are opt-in via environment variables —
the app runs and is useful with none of them configured.

## Quick start

```bash
bun install                     # postinstall runs `wrangler types`
bun run dev                     # wrangler dev, local
bun run typecheck               # tsc, Node-side code
bun run typecheck:integration   # tsc, Workers-runtime test code
bun test                        # vitest, plain Node — fast unit tests
bun run test:integration        # vitest, real Workers runtime (Miniflare) — see "Testing" below
bun run budget:check            # free-tier quota projection gate
CLOUDFLARE_API_TOKEN=... bun run scripts/bootstrap.ts   # deploy (see "Deploying" below)
```

## Where things live

```
src/
  index.tsx           Hono app entrypoint. Route registration, middleware
                       ordering, the `Env` interface (every binding this
                       Worker needs), and the `scheduled` export (cron).
  server/
    auth.ts            better-auth config (sessions in D1, PBKDF2 via crypto.subtle)
    stripe.ts           Checkout + idempotent webhook handling
    r2.ts                Client-direct presigned upload URLs
    quota.ts             withQuotaGuard/QuotaExceededError — D1 quota-exceeded handling
    ai.ts                 /api/ai/chat route + runChatTurn (the shared chat-turn
                           core every channel uses: quota, history, routing,
                           tool-calling, persistence)
    ai-providers.ts        Workers AI / Gemini / DeepSeek / OpenRouter provider
                            classes, smart routing (classifyComplexity/resolveAiProvider)
    tools.ts                webSearchTool (DuckDuckGo)
    mcp.ts                   Minimal MCP client (tools/list, tools/call) + adapter
                             into this repo's ToolDefinition shape
    cron.ts                  Daily Neuron-usage reconciliation (real GraphQL
                              Analytics API vs. the D1 estimate)
    telegram.ts               Telegram webhook channel — reuses runChatTurn
  db/
    schema.ts           Drizzle table definitions (source of truth for the schema)
    client.ts             createDb(D1Database) -> typed Drizzle client
  app/
    render.tsx            renderPage() — SSR via React 19 renderToReadableStream
    components/            Pure SSR React components (no client-only APIs)
  lib/cf/                Cloudflare REST API client used by scripts/bootstrap.ts

drizzle/migrations/    Hand-written, numbered SQL migrations (see "Migrations" below)
scripts/
  bootstrap.ts           The actual deploy path — see "Deploying"
  budget-check.ts          Free-tier quota projection gate
  budget-cpu-live.ts        Real cpuTime measurement via wrangler tail
  bench-ttfb.ts              Multi-region TTFB benchmark against a live deploy
  teardown.ts                 Tears down what bootstrap created

test/                   Plain-Node unit tests (`bun test`)
test/integration/       Real-Workers-runtime tests (`bun run test:integration`)
docs/
  TRD.md                 Full technical requirements + free-tier budget math
  adding-a-route.md        Step-by-step checklist for adding a new route
```

## Adding something new

**A new route?** Follow `docs/adding-a-route.md` — it's a checklist: static
vs. dynamic caching decision, `requireSession` placement, `withQuotaGuard`
for every D1 call, `renderPage`, and writing the integration test first.

**A new AI provider?** Extend `OpenAiCompatibleProvider` in
`ai-providers.ts` if it speaks the OpenAI chat-completions shape (like
`DeepSeekProvider`/`OpenRouterProvider` do) — you only supply a base URL,
model id, and auth header; the tool-calling loop is shared. Otherwise
implement `AiProvider` directly (see `GeminiProvider` for a non-OpenAI-shaped
example). Wire it into `resolveAiProvider`'s precedence chain and
`bootstrap.ts`'s optional-bindings section.

**A new tool for the AI to call?** Implement `ToolDefinition` (`tools.ts`)
and add it to the `tools` array built in `ai.ts`'s `runChatTurn` — or, for
tools that live on someone else's server, point `MCP_SERVER_URL` at an MCP
server instead of writing code at all.

**A new channel (like Telegram)?** Call `runChatTurn(env, db, userId,
prompt, image?)` from `ai.ts` — it's channel-agnostic. Look at
`telegram.ts` as the reference: no session cookie, its own auth mechanism,
its own reply delivery, same core.

**A new table or column?** Edit `src/db/schema.ts`, then hand-write the
migration — see "Migrations" below.

## Deploying

**Never run `wrangler deploy` directly against this repo's real account.**
The deploy path is:

```bash
bunx wrangler deploy --dry-run --outdir dist   # build only, writes dist/
CLOUDFLARE_API_TOKEN=... bun run scripts/bootstrap.ts   # raw Cloudflare API upload
```

`bootstrap.ts` is a raw multipart upload against the Cloudflare REST API,
not `wrangler deploy` — every binding (D1, KV, R2, AI, rate limiter, every
secret) is built by hand in that script from `process.env`, not read from
`wrangler.jsonc`. A new required binding has to be added to `bootstrap.ts`'s
`bindings` array or it silently won't exist in production.

**Secret bindings persist across deploys even when omitted from a
`bootstrap.ts` run** — Cloudflare does not clear a `secret_text` binding
just because a later deploy's `bindings` array doesn't include it. Every
optional provider/channel (Gemini, DeepSeek, OpenRouter, MCP, Telegram,
Analytics reconciliation) is opt-in via an env var passed to `bootstrap.ts`
— omitting one on a given run just means that run doesn't touch that
secret, not that the feature gets disabled. Check actual live bindings with
`GET /accounts/{id}/workers/scripts/{name}/bindings` if you need to know
what's really configured; delete one with `DELETE
/accounts/{id}/workers/scripts/{name}/secrets/{name}`.

`wrangler.jsonc`'s `database_id`/KV `id` are literally
`"REPLACE_WITH_D1_ID"` / `"REPLACE_WITH_KV_ID"` in the committed file — real
IDs only exist in the gitignored `.flare-kit.state.json`. Any command that
needs them locally (`wrangler dev --remote`, `wrangler tail`, `wrangler d1
execute` against the real DB) requires temporarily patching
`wrangler.jsonc` with the real values, then reverting (`git diff
wrangler.jsonc` must be empty) before committing.

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

Two Vitest configs that cannot share a runtime:

- `bun test` (`vitest.config.ts`) — plain Node. Fast, no bindings.
- `bun run test:integration` (`vitest.integration.config.ts`) — the real
  Workers runtime via `@cloudflare/vitest-plugin` (real D1, KV, R2,
  `crypto.subtle`, migrations auto-applied). This is what catches bugs a
  Node-environment test can't see: a missing binding, a Drizzle/D1 schema
  mismatch, a Workers-only crypto limit.

**`cloudflare:test` in this repo's version of `@cloudflare/vitest-plugin`
has no in-isolate `fetchMock`** (unlike `@cloudflare/vitest-pool-workers`).
A Node-side `vi.stubGlobal("fetch", ...)` never reaches code running inside
the workerd isolate these integration tests exercise. Any function that
needs to make a real outbound `fetch` and be integration-tested (`cron.ts`,
`telegram.ts`) takes an injectable `fetchImpl: typeof fetch = fetch`
parameter — follow that pattern for new outbound-fetch code.

Workers AI (`env.AI.run`) has no local simulator and bills real Neurons
even in Miniflare tests — stub it in `beforeEach` (see
`test/integration/ai-memory.test.ts`).

## Verifying live

Every feature in this repo has been verified against the real production
deploy, not just typechecked — curl the live endpoint, inspect `wrangler
tail --format json` for real errors, clean up any test data afterward via
the D1 REST query endpoint. Keep doing this for new features.

`wrangler tail --format json` output is **not** newline-delimited JSON —
it's concatenated pretty-printed objects; parse it with a brace-depth
counter, not a line-based JSON parser.

Cloudflare gives no way to manually trigger a deployed Worker's Cron
Trigger in production, and `wrangler dev --test-scheduled --remote`'s
`/cdn-cgi/handler/scheduled` route is itself blocked by Cloudflare's edge
(`error 1042`) before reaching the dev Worker. To verify scheduled-handler
logic live, replicate its exact D1/external-API calls directly against
production instead.

## Environment variables

All optional except the first three, which `bootstrap.ts` requires to
provision anything:

| Var | Required for |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Any `bootstrap.ts`/`teardown.ts` run |
| `AUTH_SECRET` | Generated once by `bootstrap.ts`, persisted in `.flare-kit.state.json` |
| `GOOGLE_AI_API_KEY` | Gemini text + vision + tool-calling |
| `DEEPSEEK_API_KEY` | DeepSeek text + tool-calling (cheaper than Gemini) |
| `OPENROUTER_API_KEY` | OpenRouter text + tool-calling (independent quota pool; currently the top-preference complex-tier provider) |
| `MCP_SERVER_URL` | One remote MCP server's tools exposed to the chat tool-calling loop |
| `CF_ANALYTICS_API_TOKEN` | Daily Neuron-usage reconciliation cron (needs Account Analytics:Read scope — deliberately not the deploy token) |
| `TELEGRAM_BOT_TOKEN` + `TELEGRAM_WEBHOOK_SECRET` | Telegram channel (see README "Telegram setup") |
| `GOOGLE_CLIENT_ID`/`SECRET`, `GITHUB_CLIENT_ID`/`SECRET` | OAuth login providers |

Provider precedence for the AI "complex" routing tier:
**OpenRouter > DeepSeek > Gemini > Workers AI (default, no key needed)**.
Vision always requires Gemini specifically regardless of the other keys.

## Secrets in chat

If a real API key/token is pasted into a conversation, treat it as
already-compromised — proceed with it, but remind whoever's driving to
rotate it afterward. Never echo a full key back in a response.
