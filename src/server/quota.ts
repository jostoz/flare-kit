import { PER_REQUEST_BUDGET } from "../../budget.config";

/**
 * Thrown by D1-quota-exceeded errors. Cloudflare returns these once the
 * account crosses the free-tier daily row-read/row-write ceiling
 * (enforced since 2026-09-01 — TRD §3.7).
 */
export class QuotaExceededError extends Error {
  constructor(public readonly resource: "d1_read" | "d1_write" | "ai_neurons") {
    super(`quota_exceeded:${resource}`);
  }
}

const D1_LIMIT_MESSAGE_FRAGMENTS = [
  "row read", "row write", "daily limit", "exceeded", "D1_ERROR",
];

function looksLikeQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return D1_LIMIT_MESSAGE_FRAGMENTS.some((f) => msg.toLowerCase().includes(f.toLowerCase()));
}

/**
 * Wraps every D1 call site. On quota exhaustion, converts the opaque
 * Cloudflare error into a typed `QuotaExceededError` so route handlers can
 * degrade to read-only (503) instead of leaking a generic 500 (TRD §3.7, §7.5).
 */
export async function withQuotaGuard<T>(
  op: () => Promise<T>,
  resource: "d1_read" | "d1_write" = "d1_read",
): Promise<T> {
  try {
    return await op();
  } catch (err) {
    if (looksLikeQuotaError(err)) throw new QuotaExceededError(resource);
    throw err;
  }
}

/** Structured 503 body for degraded mode (TRD §3.7). */
export function degradedResponse(err: QuotaExceededError): Response {
  return new Response(
    JSON.stringify({
      error: "quota_exceeded",
      resource: err.resource,
      message:
        err.resource === "d1_write"
          ? "Writes are temporarily disabled: daily D1 write quota reached. Reads still work."
          : "Service is degraded: daily quota reached. Try again after 00:00 UTC.",
    }),
    { status: 503, headers: { "content-type": "application/json" } },
  );
}

export { PER_REQUEST_BUDGET };
