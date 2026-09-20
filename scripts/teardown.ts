#!/usr/bin/env bun
/** Idempotent rollback for scripts/bootstrap.ts (TRD §5.3). Deletes only resources this kit created. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { CloudflareClient } from "../src/lib/cf/client";

interface StateFile {
  accountId: string;
  d1DatabaseId: string;
  kvNamespaceId: string;
  r2BucketName: string;
}

export async function teardown(opts: { apiToken: string; workerName?: string }): Promise<void> {
  const statePath = join(import.meta.dir, "..", ".flare-kit.state.json");
  if (!existsSync(statePath)) {
    console.log("No .flare-kit.state.json found — nothing to tear down.");
    return;
  }
  const state = JSON.parse(await Bun.file(statePath).text()) as StateFile;
  const cf = new CloudflareClient(opts.apiToken);
  const workerName = opts.workerName ?? "flare-kit-app";

  await Promise.allSettled([
    cf.deleteWorker(state.accountId, workerName),
    cf.deleteD1(state.accountId, state.d1DatabaseId),
    cf.deleteKv(state.accountId, state.kvNamespaceId),
    cf.deleteR2(state.accountId, state.r2BucketName),
  ]);
}

if (import.meta.main) {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) {
    console.error("Missing CLOUDFLARE_API_TOKEN environment variable.");
    process.exit(1);
  }
  await teardown({ apiToken });
  console.log("Teardown complete.");
}
