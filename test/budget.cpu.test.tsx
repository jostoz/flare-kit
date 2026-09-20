import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { Dashboard } from "../src/app/components/Dashboard";

/**
 * Coarse regression trip-wire, not the authoritative CPU gate. Vitest's
 * own runtime overhead (~4x vs bare `bun`/`node` on this environment,
 * measured directly) makes precise millisecond assertions here flaky and
 * environment-dependent. The authoritative TRD §7.1 gate reads the real
 * `cpuTime` reported by workerd under `wrangler dev --remote` (see
 * scripts/budget-check.ts and the CI workflow). This test only catches
 * gross regressions (e.g. an accidentally-heavy dependency or an
 * unbounded loop) before they reach that gate.
 */
describe("SSR CPU smoke test", () => {
  it("renders a realistic 100-row page without a gross performance regression", () => {
    const rows: Array<{ id: string; label: string; status: "active" | "idle" }> = Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      label: `Item ${i}`,
      status: i % 3 === 0 ? "active" : "idle",
    }));

    for (let i = 0; i < 20; i++) renderToString(<Dashboard rows={rows} />); // warmup

    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      renderToString(<Dashboard rows={rows} />);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p99 = samples[98];

    // 30ms is a generous smoke ceiling covering CI-runner and vitest-transform
    // noise; a real free-tier-CPU regression (bcrypt, an OpenNext-style
    // adapter, an unpaginated list) blows past this by an order of magnitude.
    expect(p99).toBeLessThan(30);
  });
});
