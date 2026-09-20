# flare-kit

Full-stack $0/month Micro-SaaS boilerplate on the Cloudflare Free Tier. See `docs/TRD.md` for the full technical requirements document, including every free-tier limit verified against Cloudflare's current docs and the measurements backing each design decision.

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
bun install
bun run dev              # wrangler dev, local
bun run typecheck
bun test                 # vitest: quota degradation + SSR CPU smoke test
bun run budget:check     # TRD §7.2 data-quota projection gate
bun run size              # wrangler dry-run + gzip bundle size check (TRD §7.6)
CLOUDFLARE_API_TOKEN=... bun run deploy    # TRD §5 one-command provisioning
CLOUDFLARE_API_TOKEN=... bun run teardown  # tears down what bootstrap created
```

## Verified in this repo

- `bun run typecheck` — clean.
- `bun test` — 4/4 passing (quota degradation contract, SSR CPU smoke test).
- `bun run budget:check` — passes at 66.7% D1 read/write, 33.3% Workers requests, projected at 5,000 MAU.
- `wrangler deploy --dry-run` — builds clean with all 7 bindings; **600 KB gzip**, under the 1 MB budget.
- Live `bootstrap.ts` roundtrip against the real Cloudflare REST API — deployed to `https://flare-kit-app.jostoztado.workers.dev` (D1 + KV + R2 + AI bindings live, HTTP 200).
- `bun run bench:ttfb` (TRD §7.4) against the live deployment — p75 373ms across 5 regions (US, Brazil, Germany, Japan, Hong Kong via check-host.net). **Neither TRD budget applies to `GET /` as shipped**: no `Cache-Control` header (not edge-cached) and no D1 query on the hot path (not the dynamic-with-D1 case) — see script output for the full caveat. Not a pass/fail gate until one of those is added.

## Not verified in this environment

- `wrangler dev --remote` `cpuTime` reading — needs a live Cloudflare session; the committed CPU test is a coarse local smoke test, not this authoritative measurement (TRD §7.1).

## Deviation from the original plan

TanStack Start's own Vite/Nitro build pipeline for the Cloudflare Workers target was not wired in — it can't be verified end-to-end without a live deploy, and shipping an unverified build pipeline is worse than being explicit. The default SSR here is architecturally equivalent (React SSR on the Worker, TanStack Router for client navigation) and is fully measured: see TRD §3.1.1.
