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
 * same markup for every visitor, no per-user data. Styled with the
 * Substrate design system (public/app.css) — see AGENTS.md.
 *
 * The sign-up/sign-in form posts via the minimal progressive-enhancement
 * handler in public/app.client.js; without JS it's inert (no
 * server-rendered fallback action — this is a boilerplate demo, not a
 * production auth UI).
 */
export function Landing() {
  return (
    <>
      <nav className="nav">
        <a className="nav-brand" href="/">
          flare-kit
        </a>
        <a href="#product">Product</a>
        <a href="#start">Start</a>
        <a href="https://github.com/jostoz/flare-kit">Source</a>
        <a className="btn btn-primary" href="#start">
          Get started
        </a>
      </nav>

      <div className="wrap">
        <section className="hero">
          <h1 className="display">
            <span className="line">Ship an AI assistant</span>
            <span className="line">for $0 a month.</span>
          </h1>
          <p className="sub">
            flare-kit is a full-stack boilerplate that runs entirely on Cloudflare's Free Tier — Workers, D1, KV, R2, and a multi-provider AI
            assistant with vision, tool-calling, and memory. No server to pay for, no build pipeline to babysit.
          </p>
          <div className="row">
            <a className="btn btn-primary" href="#start">
              Create an account
            </a>
            <a className="btn btn-ghost" href="https://github.com/jostoz/flare-kit">
              View source
            </a>
          </div>
        </section>

        <hr className="rule2" />

        <section className="stats" aria-label="flare-kit, by the numbers">
          <div className="grid">
            <div>
              <p className="stat-num">$0</p>
              <p className="stat-label">Monthly cost, Cloudflare Free Tier</p>
            </div>
            <div>
              <p className="stat-num">3</p>
              <p className="stat-label">AI providers in cascading fallback</p>
            </div>
            <div>
              <p className="stat-num">6</p>
              <p className="stat-label">Assistant capabilities, verified live</p>
            </div>
            <div>
              <p className="stat-num">0</p>
              <p className="stat-label">Servers to operate</p>
            </div>
          </div>
        </section>

        <hr className="rule2" />

        <section className="features" id="product">
          <span className="kicker">What's built in</span>
          {LANDING_FEATURES.map((f, i) => (
            <div className="feature" key={f.title}>
              <p className="f-num">{String(i + 1).padStart(2, "0")}</p>
              <h2 className="f-title">{f.title}</h2>
              <p className="f-copy">{f.description}</p>
            </div>
          ))}
        </section>
      </div>

      <section className="auth-section" id="start">
        <div className="auth-card card">
          <span className="card-kicker">Get started</span>
          <div className="seg" role="tablist" aria-label="Sign up or sign in">
            <button type="button" className="seg-opt active" data-auth-tab="sign-up" role="tab" aria-selected="true">
              Sign up
            </button>
            <button type="button" className="seg-opt" data-auth-tab="sign-in" role="tab" aria-selected="false">
              Sign in
            </button>
          </div>

          <form data-auth-form="sign-up" className="auth-form">
            <div className="field">
              <label>Name</label>
              <input className="input" type="text" name="name" autoComplete="name" required />
            </div>
            <div className="field">
              <label>Email</label>
              <input className="input" type="email" name="email" autoComplete="email" required />
            </div>
            <div className="field">
              <label>Password</label>
              <input className="input" type="password" name="password" autoComplete="new-password" minLength={8} required />
            </div>
            <button type="submit" className="btn btn-primary btn-block">
              Create account
            </button>
            <p className="auth-error" data-auth-error hidden />
          </form>

          <form data-auth-form="sign-in" className="auth-form" hidden>
            <div className="field">
              <label>Email</label>
              <input className="input" type="email" name="email" autoComplete="email" required />
            </div>
            <div className="field">
              <label>Password</label>
              <input className="input" type="password" name="password" autoComplete="current-password" required />
            </div>
            <button type="submit" className="btn btn-primary btn-block">
              Sign in
            </button>
            <p className="auth-error" data-auth-error hidden />
          </form>
        </div>
      </section>

      <div className="wrap">
        <footer className="site-footer">flare-kit — $0/month on the Cloudflare Free Tier. See the README for what's verified live.</footer>
      </div>
    </>
  );
}
