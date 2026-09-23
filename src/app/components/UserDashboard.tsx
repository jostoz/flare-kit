export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface UserDashboardData {
  email: string;
  name: string | null;
  neuronsToday: number;
  neuronsBudget: number;
  recentMessages: ChatMessage[];
}

/**
 * Pure SSR component for the authenticated, D1-backed dashboard (TRD §7.4
 * "dynamic route with D1" budget target: p75 < 200ms). Unlike the public
 * landing page, this reads real per-user state every request and must
 * never be edge-cached. Styled with the Substrate design system
 * (public/app.css) — see AGENTS.md.
 *
 * The chat panel server-renders the last AI_HISTORY_WINDOW turns (the same
 * window /api/ai/chat itself reads — see src/server/ai.ts) so a page
 * reload shows real continuity, not an empty box; the progressive-
 * enhancement handler in public/app.client.js appends new turns after
 * that without a full reload.
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

        <hr className="rule2" style={{ margin: "var(--space-8) 0 var(--space-6)" }} />

        <span className="kicker">Assistant</span>
        <div className="card" id="chat-card" style={{ maxWidth: "40rem" }}>
          <div id="chat-log" className="chat-log">
            {data.recentMessages.length === 0 ? (
              <p className="text-muted" data-chat-empty>
                No messages yet — say something below.
              </p>
            ) : (
              data.recentMessages.map((m, i) => (
                <div className={`chat-msg chat-msg-${m.role}`} key={i}>
                  <span className="mono chat-role">{m.role}</span>
                  <p>{m.content}</p>
                </div>
              ))
            )}
          </div>

          <form id="chat-form" className="chat-form">
            <textarea className="input" name="prompt" placeholder="Ask anything…" rows={2} required />
            <div className="chat-form-row">
              <label className="btn btn-ghost chat-attach">
                Attach image
                <input type="file" name="image" accept="image/png,image/jpeg,image/webp,image/gif" hidden />
              </label>
              <span className="mono text-muted" data-chat-filename></span>
              <button type="submit" className="btn btn-primary">
                Send
              </button>
            </div>
            <p className="auth-error" data-chat-error hidden />
          </form>
        </div>
      </div>
    </>
  );
}
