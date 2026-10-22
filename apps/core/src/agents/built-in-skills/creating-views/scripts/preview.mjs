#!/usr/bin/env node
// Previews a dx-view document the way the dx web app frames it: view-frame.mjs and kit/ are the
// same files the web app uses, so the CSP, theme tokens, kit, and bridge match. Screenshots the
// view at the reply width (720px) and at phone width (360px) in light and dark themes, and prints
// page errors. Needs agent-browser (see the using-agent-browser skill).
//
// Usage: node preview.mjs <view.html> [output-dir] [--palette daydream|deadpan]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { viewDocument } from "./view-frame.mjs";

const args = process.argv.slice(2);
const paletteFlag = args.indexOf("--palette");
const palette = paletteFlag === -1 ? "daydream" : args[paletteFlag + 1];
const [input, output] = args.filter(
  (_, index) =>
    paletteFlag === -1 || (index !== paletteFlag && index !== paletteFlag + 1),
);
if (!input) {
  console.error(
    "Usage: node preview.mjs <view.html> [output-dir] [--palette daydream|deadpan]",
  );
  process.exit(2);
}
const html = readFileSync(input, "utf8");
const kitDir = join(dirname(fileURLToPath(import.meta.url)), "kit");
const kit = {
  css: readFileSync(join(kitDir, "kit.css"), "utf8"),
  js: readFileSync(join(kitDir, "kit.js"), "utf8"),
  icons: readFileSync(join(kitDir, "icons.svg"), "utf8"),
};
const outDir = resolve(output ?? `/tmp/dx-view-preview-${Date.now()}`);
mkdirSync(outDir, { recursive: true });

const session = `dx-view-${process.pid}`;
const browser = (...command) =>
  execFileSync("agent-browser", ["--session", session, ...command], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });

const name = basename(input).replace(/\.html?$/i, "");
let failed = false;
try {
  for (const scheme of ["light", "dark"]) {
    const file = join(outDir, `${name}-${scheme}.html`);
    writeFileSync(file, viewDocument(html, { kit, palette, scheme }));
    for (const width of [720, 360]) {
      browser("set", "viewport", String(width), "900", "2");
      browser("open", `file://${file}`);
      browser("wait", "1400");
      const height = browser(
        "eval",
        "Math.ceil(document.documentElement.getBoundingClientRect().height)",
      );
      const shot = join(outDir, `${name}-${scheme}-${width}.png`);
      // Crop to the content, like the inline frame does (up to its 1200px limit).
      browser(
        "set",
        "viewport",
        String(width),
        String(Math.min(1200, Number(height) + 8)),
        "2",
      );
      browser("screenshot", shot);
      const errors = JSON.parse(browser("errors", "--json")).data?.errors ?? [];
      console.log(
        `${scheme} ${width}px: ${shot} (content height ${height.trim()}px)`,
      );
      for (const error of errors) {
        failed = true;
        console.log(`  error: ${error.text} (line ${error.line})`);
      }
      browser("errors", "--clear");
    }
  }
} finally {
  try {
    browser("close");
  } catch {}
}
if (failed) process.exitCode = 1;
