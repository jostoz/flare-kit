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
 * never be edge-cached.
 */
export function UserDashboard({ data }: { data: UserDashboardData }) {
  return (
    <main>
      <h1>Your account</h1>
      <table>
        <tbody>
          <tr>
            <td>Email</td>
            <td>{data.email}</td>
          </tr>
          <tr>
            <td>Name</td>
            <td>{data.name ?? "—"}</td>
          </tr>
          <tr>
            <td>AI Neurons used today</td>
            <td>
              {data.neuronsToday} / {data.neuronsBudget}
            </td>
          </tr>
        </tbody>
      </table>
    </main>
  );
}
