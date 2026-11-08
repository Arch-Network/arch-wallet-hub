import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// An undefined `var(--x)` fails silently in the browser: the declaration
// falls back (or drops) and the element renders unstyled. Every custom
// property read anywhere in src/ must be declared in a stylesheet, or set
// at runtime from TS (`"--x": v` in a style object, `setProperty("--x")`).

const SRC = fileURLToPath(new URL("../..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.(css|tsx?)$/.test(entry.name) && path !== SELF ? [path] : [];
  });
}

const files = walk(SRC).map((path) => ({
  rel: relative(SRC, path),
  text: readFileSync(path, "utf8"),
}));

function definedProperties(): Set<string> {
  const defined = new Set<string>();
  for (const { rel, text } of files) {
    const patterns = rel.endsWith(".css")
      ? [/(?:^|[\s{;])(--[\w-]+)\s*:/g]
      : [/["'](--[\w-]+)["']\s*:/g, /setProperty\(\s*["'](--[\w-]+)["']/g];
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) defined.add(match[1]);
    }
  }
  return defined;
}

interface Use {
  file: string;
  line: number;
  name: string;
}

function uses(): Use[] {
  const found: Use[] = [];
  for (const { rel, text } of files) {
    for (const match of text.matchAll(/var\(\s*(--[\w-]+)/g)) {
      const line = text.slice(0, match.index).split("\n").length;
      found.push({ file: rel, line, name: match[1] });
    }
  }
  return found;
}

describe("CSS custom properties", () => {
  it("every var(--x) in src/ is defined", () => {
    const defined = definedProperties();
    const offenders = uses()
      .filter((use) => !defined.has(use.name))
      .map((use) => `${use.file}:${use.line} ${use.name}`);
    expect(offenders).toEqual([]);
  });
});
