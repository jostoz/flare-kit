import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";

/**
 * Coarse regression trip-wire, not the authoritative CPU gate. Vitest's
 * own runtime overhead (~4x vs bare `bun`/`node` on this environment,
 * measured directly) makes precise millisecond assertions here flaky and
 * environment-dependent. The authoritative TRD §7.1 gate reads the real
 * `cpuTime` reported by workerd under `wrangler dev --remote` (see
 * scripts/budget-check.ts and the CI workflow). This test only catches
 * gross regressions (e.g. an accidentally-heavy dependency or an
 * unbounded loop) before they reach that gate.
 *
 * A local fixture, not a real page component: this test's job is to
 * exercise "render a list-bounded (TRD §3.1.2, ≤100 rows) SSR table" cost
 * in general, not any specific route's markup.
 */
interface Row {
  id: string;
  label: string;
  status: "active" | "idle";
}

function BoundedListFixture({ rows }: { rows: Row[] }) {
  return (
    <table>
      <tbody>
        {rows.map((row) => (
          <tr key={row.id}>
            <td>{row.label}</td>
            <td>{row.status}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

describe("SSR CPU smoke test", () => {
  it("renders a realistic 100-row page without a gross performance regression", () => {
    const rows: Row[] = Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      label: `Item ${i}`,
      status: i % 3 === 0 ? "active" : "idle",
    }));

    for (let i = 0; i < 20; i++) renderToString(<BoundedListFixture rows={rows} />); // warmup

    const samples: number[] = [];
    for (let i = 0; i < 100; i++) {
      const start = performance.now();
      renderToString(<BoundedListFixture rows={rows} />);
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
