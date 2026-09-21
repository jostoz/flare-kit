# Adding a new route

`GET /dashboard` (`src/index.tsx`, `src/app/components/UserDashboard.tsx`) is the
canonical example: an authenticated, D1-backed, non-cached route. Copy its
shape rather than re-deriving the pattern.

## 1. Decide: static or dynamic?

This determines the TRD §7.4 latency budget the route is held to, and its
caching behavior once `cache.enabled` is set (`wrangler.jsonc`).

| | Static (`GET /`) | Dynamic (`GET /dashboard`) |
| --- | --- | --- |
| Same response for every visitor | Yes | No — per-user |
| Touches D1 on the hot path | No | Yes |
| `Cache-Control` | `public, max-age=<n>` | `private, no-store` (required) |
| TRD §7.4 budget | p75 < 50ms | p75 < 200ms |

**Never ship a route without an explicit `Cache-Control`.** Once Workers
Caching is enabled, a `200` response with no header falls back to
Cloudflare's heuristic freshness (2 hours) — silently caching per-user data
and serving it to the next visitor. `src/index.tsx` already forces
`private, no-store` on every `/api/*` and `/dashboard` response as a
belt-and-suspenders default; a genuinely public new route has to opt out of
that explicitly the way `GET /` does.

## 2. Auth: gate it before you register it

```ts
app.use("/your-route", requireSession);
```

Register the middleware **before** `app.get("/your-route", ...)`. `requireSession`
sets `c.set("userId", session.user.id)` — read it in the handler via `c.get("userId")`,
never re-derive it.

## 3. Query D1 through `withQuotaGuard`

Every D1 call on a route that can be hit by an end user goes through
`withQuotaGuard` (`src/server/quota.ts`), which converts Cloudflare's opaque
quota-exceeded error into a typed `QuotaExceededError` so the route can
degrade to `503` instead of leaking a `500` (TRD §3.7):

```ts
try {
  const [row] = await withQuotaGuard(() =>
    db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1),
  );
  // ...
} catch (err) {
  if (err instanceof QuotaExceededError) return degradedResponse(err);
  throw err;
}
```

Every `WHERE`/`JOIN`/`ORDER BY` column needs an index (TRD §3.2) — check
`src/db/schema.ts` before adding a new query shape, not after.

## 4. Render with `renderPage`

```ts
return renderPage(<YourComponent data={...} />, "flare-kit — your title", {
  "cache-control": "private, no-store", // omit only for a genuinely public route
});
```

Components are pure SSR (no client-only APIs) and list-bounded — paginate
past 100 rows (TRD §3.1.2).

## 5. Write the integration test first

Add it to `test/integration/`, not `test/`. `test/` runs in a plain Node
environment (`vitest.config.ts`) — it cannot exercise D1, KV, R2, or
`crypto.subtle`'s Workers-specific behavior (see `test/integration/dashboard.test.ts`
for why this distinction matters: it's what caught three real production
bugs — a missing binding, a Drizzle schema mismatch, and a Workers-only
PBKDF2 iteration cap — none of which a Node-environment test could see).

```ts
import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import worker from "../../src/index";

it("rejects an unauthenticated request", async () => {
  const request = new Request("http://example.com/your-route");
  const res = await worker.fetch(request, env, {
    waitUntil: () => {},
    passThroughOnException: () => {},
  } as ExecutionContext);
  expect(res.status).toBe(401);
});
```

Run it with `bun run test:integration` (real D1 via Miniflare, migrations
auto-applied by `test/integration/apply-migrations.ts`) — not `bun test`,
which skips this directory entirely.

## 6. If the route adds a new table or column

1. Edit `src/db/schema.ts`.
2. Hand-write the migration SQL in `drizzle/migrations/000N_description.sql`.
   **Do not run `bun run db:generate` blindly** — this repo's migration
   history predates `drizzle-kit`'s journal tracking (`drizzle/meta/`
   doesn't exist), so `generate` re-baselines the *entire* schema as a new
   `0000_*.sql` file that collides with the real `0000_init.sql` already
   applied in production. Write the incremental `ALTER TABLE`/`CREATE TABLE`
   statements by hand, matching the existing numbered-file convention.
3. `bootstrap.ts` applies unapplied migrations automatically on every
   deploy (tracked via a `__migrations` table) — no separate migration
   step is needed for production.
