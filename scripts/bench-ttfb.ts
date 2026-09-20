#!/usr/bin/env bun
/**
 * Multi-region TTFB benchmark (TRD §7.4) against a live deployment, using
 * check-host.net's free public HTTP-check API (no auth, no account) to get
 * real geographic diversity instead of a single vantage point.
 *
 * Usage: bun run scripts/bench-ttfb.ts [url]
 *   url defaults to the workerUrl recorded in .flare-kit.state.json.
 *
 * Known gap (documented, not silently papered over): GET "/" satisfies
 * neither TRD §7.4 budget today. It has no Cache-Control header, so it is
 * not the "static/edge-cached, p75 < 50ms" case; it also builds a Db client
 * per request but never queries D1, so it is not the "dynamic-with-D1,
 * p75 < 200ms" case either. This script reports the raw p75 across regions
 * without asserting pass/fail against either budget — add a Cache-Control
 * policy or a real D1-backed GET route before wiring a budget gate here.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CHECK_HOST_API = "https://check-host.net";

// One node per inhabited continent reachable from check-host.net's free
// pool, chosen for geographic spread rather than proximity to any single
// Cloudflare PoP. Fewer than TRD's "≥5" would under-sample; five is the
// minimum that satisfies it while keeping the free API's rate limits happy.
const NODES = [
  "us1.node.check-host.net", // North America
  "br1.node.check-host.net", // South America
  "de4.node.check-host.net", // Europe
  "jp1.node.check-host.net", // Asia
  "hk1.node.check-host.net", // Asia (secondary, diversifies transit path)
] as const;

interface CheckHostInitResponse {
  ok: number;
  request_id: string;
  nodes: Record<string, [country: string, countryName: string, city: string, ip: string, asn: string]>;
}

// [success, time_seconds, status_text, http_code, ip] per node, or null while pending.
type CheckHostResultRow = [number, number, string, string, string];
type CheckHostResultResponse = Record<string, CheckHostResultRow[] | null>;

async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

function resolveTargetUrl(argUrl: string | undefined): string {
  if (argUrl) return argUrl;
  const statePath = join(import.meta.dir, "..", ".flare-kit.state.json");
  if (!existsSync(statePath)) {
    throw new Error(
      "No URL given and .flare-kit.state.json not found. Run `bun run scripts/bootstrap.ts` first, or pass a URL: bun run scripts/bench-ttfb.ts https://your-worker.workers.dev",
    );
  }
  const state = JSON.parse(readFileSync(statePath, "utf-8")) as { workerUrl?: string };
  if (!state.workerUrl) throw new Error(".flare-kit.state.json has no workerUrl field.");
  return state.workerUrl;
}

async function initCheck(url: string): Promise<CheckHostInitResponse> {
  const params = new URLSearchParams({ host: url, max_nodes: String(NODES.length) });
  for (const node of NODES) params.append("node", node);
  const res = await fetch(`${CHECK_HOST_API}/check-http?${params}`, { headers: { Accept: "application/json" } });
  const body = (await res.json()) as CheckHostInitResponse;
  if (!body.ok) throw new Error(`check-host.net rejected the check request: ${JSON.stringify(body)}`);
  const missing = NODES.filter((n) => !(n in body.nodes));
  if (missing.length > 0) {
    console.error(`Warning: check-host.net did not schedule these nodes (may be temporarily offline): ${missing.join(", ")}`);
  }
  return body;
}

async function pollResult(requestId: string, expectedNodes: number, timeoutMs = 20_000): Promise<CheckHostResultResponse> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${CHECK_HOST_API}/check-result/${requestId}`, { headers: { Accept: "application/json" } });
    const body = (await res.json()) as CheckHostResultResponse;
    const settled = Object.values(body).filter((v) => v !== null).length;
    if (settled >= expectedNodes) return body;
    await sleep(1000);
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for check-host.net results.`);
}

function percentile(sortedMs: number[], p: number): number {
  const idx = Math.min(sortedMs.length - 1, Math.floor((p / 100) * sortedMs.length));
  return sortedMs[idx];
}

async function main() {
  const targetUrl = resolveTargetUrl(process.argv[2]);
  console.log(`Benchmarking TTFB for ${targetUrl} from ${NODES.length} regions via check-host.net...\n`);

  const init = await initCheck(targetUrl);
  const results = await pollResult(init.request_id, Object.keys(init.nodes).length);

  const rows: Array<{ node: string; country: string; city: string; ttfbMs: number | null; httpCode: string | null; error: string | null }> = [];

  for (const [node, meta] of Object.entries(init.nodes)) {
    const [countryCode, countryName, city] = meta;
    const nodeResult = results[node]?.[0];
    if (!nodeResult) {
      rows.push({ node, country: `${countryName} (${countryCode})`, city, ttfbMs: null, httpCode: null, error: "no result" });
      continue;
    }
    const [success, timeSeconds, statusText, httpCode] = nodeResult;
    if (!success) {
      rows.push({ node, country: `${countryName} (${countryCode})`, city, ttfbMs: null, httpCode, error: statusText });
      continue;
    }
    rows.push({ node, country: `${countryName} (${countryCode})`, city, ttfbMs: Math.round(timeSeconds * 1000), httpCode, error: null });
  }

  console.log("Region             City            TTFB (ms)  HTTP  Note");
  console.log("-".repeat(70));
  for (const row of rows) {
    const region = row.country.padEnd(19);
    const city = row.city.padEnd(15);
    const ttfb = row.ttfbMs !== null ? String(row.ttfbMs).padStart(9) : "      n/a";
    const http = (row.httpCode ?? "-").padEnd(5);
    const note = row.error ?? "";
    console.log(`${region}${city}${ttfb}  ${http} ${note}`);
  }

  const successfulMs = rows.filter((r) => r.ttfbMs !== null).map((r) => r.ttfbMs as number).sort((a, b) => a - b);
  if (successfulMs.length === 0) {
    console.error("\nAll regions failed; cannot compute p75.");
    process.exit(1);
  }

  const p75 = percentile(successfulMs, 75);
  console.log(`\np75 TTFB: ${p75}ms across ${successfulMs.length}/${NODES.length} regions`);
  if (successfulMs.length < NODES.length) {
    console.log("Note: fewer than the requested region count responded; p75 above is based on a smaller sample.");
  }

  // Neither TRD §7.4 budget cleanly applies to GET "/" today: it has no
  // Cache-Control (so it's not the "static/edge-cached, p75 < 50ms" case),
  // and it never queries D1 despite constructing a Db client per request
  // (so it's not the "dynamic with D1, p75 < 200ms" case either). Report
  // the measurement without asserting a pass/fail against a budget this
  // route doesn't qualify for — a real dynamic-with-D1 route is needed
  // before that assertion is meaningful.
  console.log(
    "\nNeither TRD §7.4 budget applies cleanly: \"/\" has no Cache-Control (not edge-cached) and never queries D1 (not the dynamic-with-D1 case).",
  );
  console.log(
    `For reference — static/cached budget: p75 < 50ms | dynamic-with-D1 budget: p75 < 200ms | measured: ${p75}ms (includes check-host.net VPS-to-edge network transit, not just server-side time; TRD §3.1.1 measured server-side SSR render alone at 1.57ms p50 / 2.84ms p99).`,
  );
  console.log("\nNo pass/fail assertion made — add a real Cache-Control policy or a D1-backed route before wiring this into a budget gate.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
