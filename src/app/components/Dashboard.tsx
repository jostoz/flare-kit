export interface DashboardRow {
  id: string;
  label: string;
  status: "active" | "idle";
}

/**
 * Pure SSR component — no client-only APIs. Kept list-bounded (see
 * TRD §3.1.2 "listas sin paginar"): callers must page at 100 rows.
 */
export function Dashboard({ rows }: { rows: DashboardRow[] }) {
  return (
    <main>
      <h1>flare-kit</h1>
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
    </main>
  );
}
