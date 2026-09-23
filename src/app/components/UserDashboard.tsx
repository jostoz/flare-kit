export interface UserDashboardData {
  email: string;
  name: string | null;
  neuronsToday: number;
  neuronsBudget: number;
}

/**
 * Pure SSR component for the authenticated, D1-backed dashboard (TRD §7.4
 * "dynamic route with D1" budget target: p75 < 200ms). Unlike the public
 * landing page, this reads real per-user state every request and must
 * never be edge-cached. Styled with the Substrate design system
 * (public/app.css) — see AGENTS.md.
 */
export function UserDashboard({ data }: { data: UserDashboardData }) {
  const overQuota = data.neuronsToday >= data.neuronsBudget;
  return (
    <>
      <nav className="nav">
        <a className="nav-brand" href="/">
          flare-kit
        </a>
        <a href="/">Home</a>
      </nav>
      <div className="wrap" style={{ paddingTop: "var(--space-8)", paddingBottom: "var(--space-8)" }}>
        <h1>Your account</h1>
        <table className="table">
          <tbody>
            <tr>
              <td className="text-muted">Email</td>
              <td>{data.email}</td>
            </tr>
            <tr>
              <td className="text-muted">Name</td>
              <td>{data.name ?? "—"}</td>
            </tr>
            <tr>
              <td className="text-muted">AI Neurons used today</td>
              <td>
                {data.neuronsToday} / {data.neuronsBudget}{" "}
                <span className={`tag ${overQuota ? "tag-accent" : "tag-neutral"}`}>{overQuota ? "at limit" : "ok"}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </>
  );
}
