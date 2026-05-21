import type { FastifyPluginAsync } from "fastify";

/**
 * Extension connector page.
 *
 * Why this exists: external Bitcoin wallets (Xverse, UniSat)
 * inject their providers into regular http(s) pages, NOT into
 * `chrome-extension://` URLs. The Arch Wallet extension needs a stable,
 * scriptable origin to host its sats-connect bridge so that wallet
 * linking does not depend on whichever tab the user happens to have
 * open.
 *
 * This route returns a tiny static HTML page that the extension opens
 * as a popup window. The Arch Wallet content/injected scripts attach
 * automatically (host_permissions: <all_urls>) and drive the connect
 * + signMessage round trip from there.
 *
 * No auth required: the page itself contains nothing sensitive, and
 * everything interesting happens via the extension's content scripts.
 */
const CONNECTOR_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>Arch Wallet · Connect</title>
    <style>
      :root { color-scheme: dark; }
      html, body { margin: 0; padding: 0; height: 100%; }
      body {
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
        background: #0c0c0c;
        color: #e5e5e5;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .card {
        max-width: 320px;
        padding: 32px 24px;
        text-align: center;
      }
      h1 { font-size: 18px; margin: 0 0 12px; letter-spacing: 0.02em; }
      p { font-size: 14px; line-height: 1.5; margin: 8px 0; color: #c9c9c9; }
      .hint { font-size: 12px; color: #8a8a8a; margin-top: 16px; }
      .spinner {
        width: 28px;
        height: 28px;
        margin: 0 auto 20px;
        border: 2px solid #2a2a2a;
        border-top-color: #d4af37;
        border-radius: 50%;
        animation: spin 0.9s linear infinite;
      }
      @keyframes spin { to { transform: rotate(360deg); } }
    </style>
  </head>
  <body>
    <main class="card">
      <div class="spinner" aria-hidden="true"></div>
      <h1>Arch Wallet</h1>
      <p>Approve the request in your wallet to continue.</p>
      <p class="hint">This window closes automatically when done.</p>
    </main>
  </body>
</html>`;

export const registerExtensionRoutes: FastifyPluginAsync = async (server) => {
  server.get(
    "/extension/connect",
    {
      // Hide from generated OpenAPI: not a real API surface.
      schema: { hide: true } as any,
    },
    async (_req, reply) => {
      reply
        .header("content-type", "text/html; charset=utf-8")
        .header("cache-control", "no-store")
        // The connector page is loaded as a top-level document by the
        // Arch Wallet extension. It must not be framed by anything.
        .header("x-frame-options", "DENY")
        .send(CONNECTOR_HTML);
    }
  );
};
