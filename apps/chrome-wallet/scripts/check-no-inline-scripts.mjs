#!/usr/bin/env node
/**
 * Post-build guard: fail if any built HTML file ships an inline
 * `<script>` body.
 *
 * Background: the extension's CSP is
 *   `script-src 'self' 'wasm-unsafe-eval'`
 * which silently blocks inline `<script>` blocks on extension pages.
 * In v0.2.0 an inline shim in `popup/index.html` slipped through and
 * the popup rendered as a blank window in users' browsers (the shim
 * never ran, so `process` stayed undefined and `Buffer` initialisation
 * later threw). This guard catches that class of regression at build
 * time, before the zip is even produced.
 *
 * Allowed:   <script src="..."></script>      (empty body, external)
 * Rejected:  <script>...code...</script>     (non-whitespace inline)
 *
 * Self-contained: pure Node `fs`/`path`, no deps.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = fileURLToPath(new URL(".", import.meta.url));
const OUTPUT_ROOT = join(SCRIPT_DIR, "..", ".output");

/** Recursively yield every `.html` file under `dir`. */
function* walkHtml(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (err) {
    if (err.code === "ENOENT") return;
    throw err;
  }
  for (const name of entries) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walkHtml(full);
    } else if (stat.isFile() && full.endsWith(".html")) {
      yield full;
    }
  }
}

/**
 * Replace every `<!-- ... -->` block with newlines of equal length so
 * line numbers stay stable. Comments commonly contain literal
 * `<script>` text (explaining *why* we avoid inline scripts), and the
 * naive regex below would otherwise treat that as a real tag.
 */
function stripHtmlComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
}

/**
 * Return the list of inline `<script>` snippets (with line numbers)
 * found in `html`. A "<script src=..." block counts as inline only if
 * its body is non-whitespace -- which would be a CSP violation either
 * way under our policy, and is almost certainly a bug.
 */
function findInlineScripts(html) {
  const sanitized = stripHtmlComments(html);
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  const offenders = [];
  let m;
  while ((m = pattern.exec(sanitized)) !== null) {
    const body = m[2];
    if (body.trim().length === 0) continue;
    const line = sanitized.slice(0, m.index).split("\n").length;
    const preview = body.trim().slice(0, 80).replace(/\s+/g, " ");
    offenders.push({ line, preview });
  }
  return offenders;
}

function main() {
  const violations = [];
  let scanned = 0;
  for (const file of walkHtml(OUTPUT_ROOT)) {
    scanned += 1;
    const html = readFileSync(file, "utf8");
    const offenders = findInlineScripts(html);
    for (const o of offenders) {
      violations.push({ file, ...o });
    }
  }

  if (scanned === 0) {
    console.error(
      `[check-no-inline-scripts] no built HTML files found under ${relative(process.cwd(), OUTPUT_ROOT)} -- did the build run?`,
    );
    process.exit(1);
  }

  if (violations.length > 0) {
    console.error(
      `[check-no-inline-scripts] FAIL: ${violations.length} inline <script> block(s) found in build output.`,
    );
    console.error(
      `  The extension CSP forbids inline scripts; they will be silently blocked at runtime.`,
    );
    console.error(
      `  Move the code into a file under apps/chrome-wallet/public/ and load it via <script src="...">.`,
    );
    for (const v of violations) {
      const rel = relative(process.cwd(), v.file);
      console.error(`  - ${rel}:${v.line}: ${v.preview}`);
    }
    process.exit(1);
  }

  console.log(
    `[check-no-inline-scripts] OK: scanned ${scanned} HTML file(s), no inline <script> bodies found.`,
  );
}

main();
