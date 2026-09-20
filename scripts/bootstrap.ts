#!/usr/bin/env bun
/**
 * Agent-ready provisioning (TRD §5). Every step is idempotent: re-running
 * bootstrap() against an already-provisioned account reuses existing
 * resources instead of duplicating or failing.
 *
 * Usage: CLOUDFLARE_API_TOKEN=... bun run scripts/bootstrap.ts
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CloudflareClient } from "../src/lib/cf/client";

const REQUIRED_SCOPES_HINT =
  "Workers Scripts:Edit, Workers KV Storage:Edit, Workers R2 Storage:Edit, D1:Edit, Workers AI:Edit, Account Settings:Read";

interface BootstrapResult {
  accountId: string;
  workerUrl: string;
  d1DatabaseId: string;
  kvNamespaceId: string;
  r2BucketName: string;
}

export async function bootstrap(opts: { apiToken: string; workerName?: string }): Promise<BootstrapResult> {
  const workerName = opts.workerName ?? "flare-kit-app";
  const cf = new CloudflareClient(opts.apiToken);

  // 1. Verify token.
  const verified = await cf.verifyToken();
  if (verified.status !== "active") {
    throw new Error(`Cloudflare API token is not active. Required scopes: ${REQUIRED_SCOPES_HINT}`);
  }

  // 2. Account ID.
  const accountId = await cf.getAccountId();

  // 3-5. Create D1 / KV / R2 (idempotent: find-or-create).
  const [d1, kv, r2] = await Promise.all([
    cf.findOrCreateD1(accountId, "flare-kit-db"),
    cf.findOrCreateKv(accountId, "flare-kit-config"),
    cf.findOrCreateR2(accountId, "flare-kit-assets"),
  ]);

  // 6. Apply migrations, tracked in __migrations so reruns skip applied files.
  await cf.runD1Query(
    accountId,
    d1.uuid,
    "CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const migrationsDir = join(import.meta.dir, "..", "drizzle", "migrations");
  const migrationFiles = existsSync(migrationsDir) ? readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort() : [];
  for (const file of migrationFiles) {
    const applied = (await cf.runD1Query(
      accountId,
      d1.uuid,
      `SELECT name FROM __migrations WHERE name = '${file.replace(/'/g, "''")}'`,
    )) as Array<{ results: unknown[] }>;
    if (applied[0]?.results?.length) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    await cf.runD1Query(accountId, d1.uuid, sql);
    await cf.runD1Query(
      accountId,
      d1.uuid,
      `INSERT INTO __migrations (name, applied_at) VALUES ('${file.replace(/'/g, "''")}', ${Date.now()})`,
    );
  }

  // 7-8. Deploy Worker with bindings pointed at the real resource IDs.
  const metadata = {
    main_module: "index.js",
    compatibility_date: "2026-09-01",
    compatibility_flags: ["nodejs_compat"],
    bindings: [
      { type: "d1", name: "DB", id: d1.uuid },
      { type: "kv_namespace", name: "CONFIG_KV", namespace_id: kv.id },
      { type: "r2_bucket", name: "ASSETS_BUCKET", bucket_name: r2.name },
      { type: "ai", name: "AI" },
    ],
  };
  const form = new FormData();
  form.append("metadata", JSON.stringify(metadata));
  const bundlePath = join(import.meta.dir, "..", "dist", "index.js");
  if (!existsSync(bundlePath)) {
    throw new Error("Missing build output at dist/index.js — run the build before bootstrap.");
  }
  form.append("index.js", new Blob([readFileSync(bundlePath)], { type: "application/javascript+module" }), "index.js");
  await cf.deployWorker(accountId, workerName, form);

  // 9. Ensure the workers.dev subdomain is enabled.
  await cf.enableSubdomain(accountId, workerName);
  const { subdomain } = await cf.getAccountSubdomain(accountId);
  const workerUrl = `https://${workerName}.${subdomain}.workers.dev`;

  // Persist real IDs for reruns / local dev, never the token itself.
  const state: BootstrapResult = { accountId, workerUrl, d1DatabaseId: d1.uuid, kvNamespaceId: kv.id, r2BucketName: r2.name };
  await Bun.write(join(import.meta.dir, "..", ".flare-kit.state.json"), JSON.stringify(state, null, 2));

  return state;
}

if (import.meta.main) {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) {
    console.error("Missing CLOUDFLARE_API_TOKEN environment variable.");
    process.exit(1);
  }
  try {
    const result = await bootstrap({ apiToken });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    process.exit(1);
  }
}
