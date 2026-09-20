import { describe, it, expect } from "vitest";
import { withQuotaGuard, degradedResponse, QuotaExceededError } from "../src/server/quota";

/**
 * TRD §7.5: on D1 quota exhaustion the app must respond 503 with a
 * structured body, never an opaque 500 (enforcement live since 2026-09-01).
 */
describe("quota guard", () => {
  it("converts a D1 daily-limit error into a typed QuotaExceededError", async () => {
    const quotaError = new Error("D1_ERROR: over daily row read limit");
    await expect(withQuotaGuard(() => Promise.reject(quotaError))).rejects.toBeInstanceOf(QuotaExceededError);
  });

  it("passes through unrelated errors unchanged", async () => {
    const otherError = new Error("network timeout");
    await expect(withQuotaGuard(() => Promise.reject(otherError))).rejects.toBe(otherError);
  });

  it("returns a structured 503 for a write-quota exhaustion", async () => {
    const res = degradedResponse(new QuotaExceededError("d1_write"));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toMatchObject({ error: "quota_exceeded", resource: "d1_write" });
  });
});
