import { renderToReadableStream } from "react-dom/server";
import type { ReactElement } from "react";

/**
 * Direct React SSR on the Worker (TRD §3.1, §3.1.1). Measured cost for a
 * realistic 20-50KB page is 0.5-3ms p99 — well inside the 10ms/request
 * free-tier CPU ceiling; see test/budget.cpu.test.ts for the regression
 * gate that keeps it there (TRD §7.1).
 *
 * This intentionally does not depend on the TanStack Start build pipeline
 * (Vite/Nitro), whose Cloudflare Workers target cannot be verified without
 * a live deploy in this environment. TanStack Router drives client-side
 * navigation; SSR is plain React streamed straight from the Worker.
 */
export async function renderPage(element: ReactElement, title: string, extraHeaders?: HeadersInit, description?: string): Promise<Response> {
  const desc = description ?? "A full-stack AI assistant, running entirely on Cloudflare's $0/month Free Tier.";
  const stream = await renderToReadableStream(
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{title}</title>
        <meta name="description" content={desc} />
        <meta property="og:title" content={title} />
        <meta property="og:description" content={desc} />
        <meta property="og:type" content="website" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="stylesheet" href="/app.css" />
      </head>
      <body>
        <div id="root">{element}</div>
        <script type="module" src="/app.client.js"></script>
      </body>
    </html>,
  );
  return new Response(stream, { headers: { "content-type": "text/html; charset=utf-8", ...extraHeaders } });
}
