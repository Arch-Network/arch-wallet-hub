/**
 * Node-globals shim for extension HTML pages (popup, sidepanel).
 *
 * Loaded as a *parser-blocking* `<script src>` (no defer/async/type=module)
 * from popup/index.html and sidepanel/index.html so it executes during
 * HTML parsing -- before any subsequent `type=module` script (which is
 * implicitly deferred) and before the chunks that the bundler hoists
 * from those modules' imports.
 *
 * Why it lives in `public/` instead of inline in the HTML:
 *   The extension's CSP is `script-src 'self' 'wasm-unsafe-eval'` (no
 *   `unsafe-inline`, no nonce, no hash). MV3 blocks inline scripts on
 *   extension pages even when only the default policy applies, so an
 *   inline `<script>` here would silently fail and leave `process` /
 *   `global` undefined. That in turn made `buffer-polyfill.ts` (loaded
 *   from the module graph) blow up with
 *   "Cannot read properties of undefined (reading 'alloc')"
 *   and produced an empty popup window.
 *
 * Scope:
 *   Only shims `global` + `process`. `Buffer` is set up later by
 *   `src/utils/buffer-polyfill.ts` which has access to the `buffer`
 *   npm package via ESM resolution. We keep the `process` field set
 *   minimal so we *surface* (rather than silently swallow) any future
 *   dep that reaches for additional Node API.
 */
(function () {
  if (typeof globalThis.global === "undefined") {
    globalThis.global = globalThis;
  }
  if (typeof globalThis.process === "undefined") {
    globalThis.process = {
      env: {},
      version: "v20.0.0",
      browser: true,
      platform: "browser",
      nextTick: function (cb) {
        var args = Array.prototype.slice.call(arguments, 1);
        queueMicrotask(function () { cb.apply(null, args); });
      },
    };
  }
})();
