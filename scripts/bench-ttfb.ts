#!/usr/bin/env bun
/**
 * Multi-region TTFB benchmark (TRD §7.4) against a live deployment, using
 * check-host.net's free public HTTP-check API (no auth, no account) to get
 * real geographic diversity instead of a single vantage point.
 *
 * Usage: bun run scripts/bench-ttfb.ts [url]
 *   url defaults to the workerUrl recorded in .flare-kit.state.json.
 *
 * `Cache-Control` is checked dynamically against a live request (never a
 * hardcoded claim). No pass/fail is ever asserted: TRD §7.4's budgets
 * measure Cloudflare's own edge-compute/cache-serve time, and
 * check-host.net's nodes are budget VPS instances whose own transit
 * latency to whichever Cloudflare PoP they reach regularly exceeds the
 * 50ms static-route budget on its own, regardless of how fast the edge
 * responds — a pass/fail gate on this number would produce false failures
 * on a correctly configured, warm-cached route.
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

  // Check the route's actual Cache-Control instead of asserting a fixed
  // claim — this script was wrong once already (claimed "no Cache-Control"
  // after a Cache-Control header had already shipped) because the message
  // was hardcoded rather than derived from a live check.
  const headerCheck = await fetch(targetUrl, { method: "HEAD" });
  const cacheControl = headerCheck.headers.get("cache-control");
  const isPubliclyCached = cacheControl?.includes("public") && cacheControl.includes("max-age");

  // Reference only, never pass/fail: TRD §7.4's budgets are about
  // Cloudflare's own edge-compute/cache-serve time, not full client-to-edge
  // network RTT. check-host.net's nodes are budget VPS instances with their
  // own transit latency to whichever Cloudflare PoP they reach — that
  // latency alone regularly exceeds 50ms from some regions regardless of
  // how fast the edge itself responds, so asserting pass/fail against it
  // produces false failures on a correctly configured, warm-cached route.
  const budgetLabel = isPubliclyCached
    ? `static/cached budget applies: p75 < 50ms (TRD §7.4) — reference only, see note below`
    : `neither TRD §7.4 budget applies to this response shape`;
  console.log(`\nCache-Control: ${cacheControl ?? "(none)"} — ${budgetLabel}`);
  console.log(`p75 TTFB: ${p75}ms`);
  console.log(
    "\nNo pass/fail assertion made: this measures full check-host.net-VPS-to-edge network transit, not server-side compute time, and TRD's budgets are about the latter. TRD §3.1.1 measured server-side SSR render alone at 1.57ms p50 / 2.84ms p99 — the number above is dominated by network path, not Worker execution.",
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
