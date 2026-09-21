# flare-kit

Full-stack $0/month Micro-SaaS boilerplate on the Cloudflare Free Tier. See `docs/TRD.md` for the full technical requirements document, including every free-tier limit verified against Cloudflare's current docs and the measurements backing each design decision. Adding a new route? See [`docs/adding-a-route.md`](docs/adding-a-route.md) first.

## Stack

- **Router/SSR:** [Hono](https://hono.dev) + React 19 `renderToReadableStream` (direct, no build-pipeline dependency — see TRD §3.1)
- **Data:** Cloudflare D1 + Drizzle ORM (`drizzle/migrations/`)
- **Auth:** Better Auth, sessions in D1, PBKDF2-SHA256 via `crypto.subtle` (never bcrypt/argon2 — TRD §3.1.2)
- **Payments:** Stripe Checkout + idempotent webhooks
- **AI:** Workers AI with a per-user daily Neuron quota
- **Files:** R2 with client-direct presigned uploads
- **Rate limiting:** native `ratelimits` binding (not KV — TRD §0)

## Commands

```bash
bun install              # postinstall runs `wrangler types`
bun run dev              # wrangler dev, local
bun run typecheck
bun run typecheck:integration
bun test                 # vitest, Node environment: quota degradation + SSR CPU smoke test
bun run test:integration # vitest, real Workers runtime (Miniflare): D1 + auth + caching, see docs/adding-a-route.md
bun run budget:check     # TRD §7.2 data-quota projection gate
bun run size              # wrangler dry-run + gzip bundle size check (TRD §7.6)
bun run bench:ttfb        # TRD §7.4 multi-region TTFB against a live deployment
CLOUDFLARE_API_TOKEN=... bun run deploy    # TRD §5 one-command provisioning
CLOUDFLARE_API_TOKEN=... bun run teardown  # tears down what bootstrap created
```

## Verified in this repo

- `bun run typecheck` / `bun run typecheck:integration` — clean.
- `bun test` — 4/4 passing (quota degradation contract, SSR CPU smoke test).
- `bun run test:integration` — 4/4 passing against the real Workers runtime (Miniflare: real D1, real `crypto.subtle`, real bindings) — sign-up → sign-in → authenticated `/dashboard`, an unauthenticated `/api/*` rate-limit check, and `/` cache headers. This suite is what would have caught 3 of the 4 bugs listed below before they ever reached a live deploy; see `docs/adding-a-route.md`.
- `bun run budget:check` — passes at 66.7% D1 read/write, 33.3% Workers requests, projected at 5,000 MAU.
- `wrangler deploy --dry-run` — builds clean with all 7 bindings; **600 KB gzip**, under the 1 MB budget.
- Live `bootstrap.ts` roundtrip against the real Cloudflare REST API — deployed to `https://flare-kit-app.jostoztado.workers.dev`.
- Full auth loop live: sign-up → sign-in → authenticated `GET /dashboard` (real D1 query: `users` + `ai_usage`) — HTTP 200 end-to-end with a real session cookie. This was **never exercised before**; fixing it surfaced four separate pre-existing bugs, all fixed and verified live (see below). Re-tested with 4 additional fresh sign-ups after the fixes — all 200, no flakiness.
- `GET /` edge-caching (TRD §7.4): `Cache-Control: public, max-age=60` + Workers Caching enabled (`cache_options` in the deploy metadata — the field name differs from `wrangler.jsonc`'s `cache` key; the raw multipart API doesn't read `wrangler.jsonc` at all). `Cf-Cache-Status` confirmed `MISS` → `HIT` on a second request.
- `bun run bench:ttfb` (TRD §7.4) — p75 131ms across 5 regions, warm cache (`Cf-Cache-Status: HIT`). The script checks `Cache-Control` dynamically now (it used to hardcode a claim that went stale the moment caching shipped) but asserts no pass/fail: this number is dominated by check-host.net's budget-VPS-to-edge network transit, not Cloudflare's server-side compute time, which is what TRD §7.4 actually budgets — a real regression there would need `Server-Timing` or a similar edge-side measurement, not an external network probe. `GET /dashboard` and `/api/*` are defended with `Cache-Control: private, no-store` (belt-and-suspenders against Cloudflare's 2-hour heuristic-freshness default once caching is enabled) — confirmed `Cf-Cache-Status: BYPASS`.

## Bugs found and fixed while wiring the first real authenticated route

All four were live, pre-existing, and silent — nothing exercised `/dashboard` or any `/api/*` route end-to-end before this session, so none had ever thrown:

1. **`src/lib/cf/client.ts`** — `request()` hardcoded `Content-Type: application/json` on every call, stomping the multipart boundary `fetch` generates for `FormData` bodies. Broke `deployWorker`.
2. **`src/db/schema.ts` / `src/server/auth.ts`** — better-auth requires `account` and `verification` tables (credential passwords live in `accounts.password`, not a `users` column) plus `emailVerified`/`image`/`updatedAt` on `users` and `token`/`createdAt`/`ipAddress`/`userAgent` on `sessions`. None of this existed; every authenticated request threw `Drizzle schema mismatch`. Fixed with `drizzle/migrations/0001_add_auth_tables.sql` (production `users` had 0 rows at the time — no backfill needed) and explicit `{ mode: "timestamp_ms" }` on every better-auth-owned date column (without it, Drizzle passes raw JS `Date` objects to D1 instead of epoch millis).
3. **`src/server/auth.ts`** — `PBKDF2_ITERATIONS = 210_000` exceeds the Cloudflare Workers runtime's hard cap of 100,000 iterations (`NotSupportedError`, production-only — `wrangler dev`/Node both allow more, which is why this was never caught locally). Capped at 100,000.
4. **`scripts/bootstrap.ts`** — the deploy metadata's `bindings` array never included the `ratelimit` binding (`API_LIMITER`) or an `AUTH_SECRET` secret, both present in `wrangler.jsonc` but silently absent from every deploy done through `bootstrap.ts` instead of `wrangler deploy`. `API_LIMITER` being `undefined` crashed every `/api/*` request before even reaching a route handler. `AUTH_SECRET` is now generated once and persisted in the gitignored `.flare-kit.state.json` so reruns reuse it instead of rotating it and invalidating every live session.

## Not verified in this environment

- `wrangler dev --remote` `cpuTime` reading — needs a live Cloudflare session; the committed CPU test is a coarse local smoke test, not this authoritative measurement (TRD §7.1).

## Deviation from the original plan

TanStack Start's own Vite/Nitro build pipeline for the Cloudflare Workers target was not wired in — it can't be verified end-to-end without a live deploy, and shipping an unverified build pipeline is worse than being explicit. The default SSR here is architecturally equivalent (React SSR on the Worker, TanStack Router for client navigation) and is fully measured: see TRD §3.1.1.
