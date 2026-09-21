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

// Persisted alongside BootstrapResult in .flare-kit.state.json but never
// returned from bootstrap() or logged — printing it would defeat the point.
interface PersistedState extends BootstrapResult {
  authSecret: string;
}

function loadExistingAuthSecret(statePath: string): string | undefined {
  if (!existsSync(statePath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<PersistedState>;
    return parsed.authSecret;
  } catch {
    return undefined;
  }
}

/** 32 random bytes, hex-encoded — reused across reruns so redeploying never invalidates live sessions. */
function generateAuthSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function bootstrap(opts: { apiToken: string; workerName?: string }): Promise<BootstrapResult> {
  const workerName = opts.workerName ?? "flare-kit-app";
  const cf = new CloudflareClient(opts.apiToken);
  const statePath = join(import.meta.dir, "..", ".flare-kit.state.json");
  const authSecret = loadExistingAuthSecret(statePath) ?? generateAuthSecret();

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
  const bindings: Array<Record<string, unknown>> = [
    { type: "d1", name: "DB", id: d1.uuid },
    { type: "kv_namespace", name: "CONFIG_KV", namespace_id: kv.id },
    { type: "r2_bucket", name: "ASSETS_BUCKET", bucket_name: r2.name },
    { type: "ai", name: "AI" },
    { type: "ratelimit", name: "API_LIMITER", namespace_id: "1001", simple: { limit: 100, period: 60 } },
    { type: "secret_text", name: "AUTH_SECRET", text: authSecret },
  ];
  // Optional providers: only bound if their credentials are present in the
  // deploy environment, so bootstrap.ts stays runnable without them.
  // GOOGLE_AI_API_KEY routes /api/ai/chat to Gemini instead of Workers AI
  // (src/server/ai-providers.ts) — a Google AI Studio key, distinct from
  // GOOGLE_CLIENT_ID/SECRET below (OAuth login, not inference).
  if (process.env.GOOGLE_AI_API_KEY) {
    bindings.push({ type: "secret_text", name: "GOOGLE_AI_API_KEY", text: process.env.GOOGLE_AI_API_KEY });
  }
  // DEEPSEEK_API_KEY (opt-in): preferred over GOOGLE_AI_API_KEY for the
  // complex text tier — cheaper per token, no aggressive rate limit (see
  // src/server/ai-providers.ts). Vision stays Gemini-only regardless.
  if (process.env.DEEPSEEK_API_KEY) {
    bindings.push({ type: "secret_text", name: "DEEPSEEK_API_KEY", text: process.env.DEEPSEEK_API_KEY });
  }
  // OPENROUTER_API_KEY (opt-in): preferred over both DEEPSEEK_API_KEY and
  // GOOGLE_AI_API_KEY for the complex text tier — an independent
  // quota/billing pool from the other two (see src/server/ai-providers.ts).
  if (process.env.OPENROUTER_API_KEY) {
    bindings.push({ type: "secret_text", name: "OPENROUTER_API_KEY", text: process.env.OPENROUTER_API_KEY });
  }
  // MCP_SERVER_URL (opt-in): a single remote MCP server whose tools are
  // exposed to the chat tool-calling loop alongside web_search (see
  // src/server/mcp.ts). Not a secret — a public server URL.
  if (process.env.MCP_SERVER_URL) {
    bindings.push({ type: "plain_text", name: "MCP_SERVER_URL", text: process.env.MCP_SERVER_URL });
  }
  // TRD §3.5 daily Neuron reconciliation cron (src/server/cron.ts).
  // CF_ACCOUNT_ID reuses the accountId already resolved above — the
  // running Worker needs to know its own account to query the GraphQL
  // Analytics API. CF_ANALYTICS_API_TOKEN is opt-in and deliberately NOT
  // reused from CLOUDFLARE_API_TOKEN (this script's own deploy token,
  // which has far broader permissions than a Worker should ever hold) —
  // supply a separate, narrowly-scoped Account Analytics:Read token.
  bindings.push({ type: "plain_text", name: "CF_ACCOUNT_ID", text: accountId });
  if (process.env.CF_ANALYTICS_API_TOKEN) {
    bindings.push({ type: "secret_text", name: "CF_ANALYTICS_API_TOKEN", text: process.env.CF_ANALYTICS_API_TOKEN });
  }
  // Telegram channel (src/server/telegram.ts). Both opt-in and required
  // together — the webhook handler 503s without a bot token, and rejects
  // every request without a secret to check against.
  if (process.env.TELEGRAM_BOT_TOKEN) {
    bindings.push({ type: "secret_text", name: "TELEGRAM_BOT_TOKEN", text: process.env.TELEGRAM_BOT_TOKEN });
  }
  if (process.env.TELEGRAM_WEBHOOK_SECRET) {
    bindings.push({ type: "secret_text", name: "TELEGRAM_WEBHOOK_SECRET", text: process.env.TELEGRAM_WEBHOOK_SECRET });
  }
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    bindings.push({ type: "plain_text", name: "GOOGLE_CLIENT_ID", text: process.env.GOOGLE_CLIENT_ID });
    bindings.push({ type: "secret_text", name: "GOOGLE_CLIENT_SECRET", text: process.env.GOOGLE_CLIENT_SECRET });
  }
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    bindings.push({ type: "plain_text", name: "GITHUB_CLIENT_ID", text: process.env.GITHUB_CLIENT_ID });
    bindings.push({ type: "secret_text", name: "GITHUB_CLIENT_SECRET", text: process.env.GITHUB_CLIENT_SECRET });
  }

  const metadata = {
    main_module: "index.js",
    compatibility_date: "2026-09-01",
    compatibility_flags: ["nodejs_compat"],
    bindings,
    // Mirrors wrangler.jsonc's cache.enabled — this raw multipart upload
    // bypasses `wrangler deploy` entirely, so wrangler.jsonc's cache block
    // has no effect here unless duplicated in this metadata (TRD §7.4). The
    // API's field name is `cache_options`, not `cache` — wrangler.jsonc's
    // `cache` key is Wrangler's own config surface, translated internally;
    // it is not what this raw multipart request accepts.
    cache_options: { enabled: true },
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

  // Persist real IDs for reruns / local dev, never the API token itself.
  // authSecret IS persisted here (gitignored) so a rerun reuses it instead
  // of rotating it and invalidating every live session.
  const state: BootstrapResult = { accountId, workerUrl, d1DatabaseId: d1.uuid, kvNamespaceId: kv.id, r2BucketName: r2.name };
  const persisted: PersistedState = { ...state, authSecret };
  await Bun.write(statePath, JSON.stringify(persisted, null, 2));

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
