export interface Feature {
  title: string;
  description: string;
}

export const LANDING_FEATURES: Feature[] = [
  { title: "Smart routing", description: "Simple prompts stay on free Workers AI; complex ones escalate to Gemini, DeepSeek, or OpenRouter — only when it's worth the cost." },
  { title: "Vision", description: "Attach an image to any chat turn — routed automatically to a vision-capable model." },
  { title: "Web search + tools", description: "Function-calling loop backed by a free search API, with results woven into the model's answer." },
  { title: "MCP support", description: "Point at any remote MCP server and its tools show up in the same tool-calling loop, no code changes." },
  { title: "Scheduled reconciliation", description: "A daily Cron Trigger checks real AI usage against Cloudflare's own analytics — no hidden drift." },
  { title: "Telegram channel", description: "The same conversation memory, quota, and tool-calling core — reachable from a Telegram bot, not just the API." },
];

/**
 * Pure SSR component — no client-only APIs (TRD §3.1). Safe to edge-cache:
 * same markup for every visitor, no per-user data. The sign-up/sign-in
 * form below posts via the minimal progressive-enhancement handler in
 * public/app.client.js; without JS it's inert (no server-rendered
 * fallback action — this is a boilerplate demo, not a production auth UI).
 */
export function Landing() {
  return (
    <main>
      <section className="hero">
        <h1>flare-kit</h1>
        <p className="tagline">A full-stack AI assistant, running entirely on Cloudflare's $0/month Free Tier.</p>
        <div className="cta-row">
          <a className="button button-primary" href="#auth">
            Get started
          </a>
          <a className="button button-secondary" href="https://github.com/jostoz/flare-kit">
            View on GitHub
          </a>
        </div>
      </section>

      <section className="features">
        {LANDING_FEATURES.map((f) => (
          <article className="feature-card" key={f.title}>
            <h3>{f.title}</h3>
            <p>{f.description}</p>
          </article>
        ))}
      </section>

      <section className="auth" id="auth">
        <div className="auth-card">
          <div className="auth-tabs">
            <button type="button" className="auth-tab active" data-auth-tab="sign-up">
              Sign up
            </button>
            <button type="button" className="auth-tab" data-auth-tab="sign-in">
              Sign in
            </button>
          </div>

          <form data-auth-form="sign-up" className="auth-form">
            <label>
              Name
              <input type="text" name="name" autoComplete="name" required />
            </label>
            <label>
              Email
              <input type="email" name="email" autoComplete="email" required />
            </label>
            <label>
              Password
              <input type="password" name="password" autoComplete="new-password" minLength={8} required />
            </label>
            <button type="submit" className="button button-primary">
              Create account
            </button>
            <p className="auth-error" data-auth-error hidden />
          </form>

          <form data-auth-form="sign-in" className="auth-form" hidden>
            <label>
              Email
              <input type="email" name="email" autoComplete="email" required />
            </label>
            <label>
              Password
              <input type="password" name="password" autoComplete="current-password" required />
            </label>
            <button type="submit" className="button button-primary">
              Sign in
            </button>
            <p className="auth-error" data-auth-error hidden />
          </form>
        </div>
      </section>
    </main>
  );
}
