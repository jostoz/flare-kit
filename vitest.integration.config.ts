import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Runs against the real Workers runtime (workerd) via Miniflare — actual D1/
 * KV/R2/ratelimit bindings, not mocks. Separate from vitest.config.ts (plain
 * Node) because the two runtimes can't share one Vitest config: React SSR's
 * Node-specific test helpers and workerd's binding-backed `cloudflare:test`
 * APIs don't compose in a single environment.
 *
 * This is what would have caught 3 of the 4 bugs in commit 6bf7e18 before a
 * live deploy: a missing `ratelimit` binding and better-auth's Drizzle
 * schema mismatch both throw identically here as they did in production,
 * because this runs the same runtime — not a description of it.
 */
export default defineConfig(async () => {
  const migrationsPath = path.join(import.meta.dirname, "drizzle", "migrations");
  const migrations = await readD1Migrations(migrationsPath);

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            // Test-only value — never the real production secret.
            AUTH_SECRET: "test-only-secret-do-not-use-in-production-32ch",
          },
        },
      }),
    ],
    test: {
      include: ["test/integration/**/*.test.ts"],
      setupFiles: ["./test/integration/apply-migrations.ts"],
    },
  };
});
