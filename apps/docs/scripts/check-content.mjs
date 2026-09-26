import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const built = process.argv.includes("--built");
const rootArgument = process.argv.indexOf("--root");
const scanRoot =
  rootArgument === -1
    ? resolve(root, built ? "dist" : "src/content/docs")
    : resolve(process.argv[rootArgument + 1] ?? "");
const scannedExtensions = new Set(
  built ? [".css", ".html", ".js", ".json", ".svg"] : [".md", ".mdx"],
);
const forbiddenAssistantName = ["a", "m", "p"].join("");
const forbiddenJourneyCommand = ["journey", ":"].join("");
const forbiddenPrivateNames = [
  ["first", "3", ".live"],
  ["wheel", "ocity", ".com"],
  ["on", "a", "m", "p", ".dev"],
  ["p8n", "-ai"],
  ["pi", "-remembers"],
].map((parts) => parts.join(""));
const prohibited = [
  ...forbiddenPrivateNames.map((name) => ({
    label: "private product or domain",
    pattern: new RegExp(name.replace(".", "\\."), "gi"),
  })),
  { label: "private documentation path", pattern: /(?:^|[/(])wiki\//gim },
  { label: "private task path", pattern: /(?:^|[/(])tasks\//gim },
  {
    label: "protected journey command",
    pattern: new RegExp(forbiddenJourneyCommand, "gi"),
  },
  {
    label: "internal assistant name",
    pattern: new RegExp(`(?<!&)\\b${forbiddenAssistantName}\\b(?!;)`, "gi"),
  },
  { label: "private commit SHA", pattern: /\b[0-9a-f]{40}\b/gi },
  {
    label: "unfinished content marker",
    pattern: /\b(?:TODO|TBD|Track [A-D]|not implemented)\b/gi,
  },
  {
    label: "obsolete release language",
    pattern: /\b(?:pre-release|prerelease|rehearsal|clean-room)\b/gi,
  },
];

const walk = async (directory) => {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...(await walk(path)));
    else if (scannedExtensions.has(extname(entry.name))) paths.push(path);
  }
  return paths;
};

if (!existsSync(scanRoot)) {
  throw new Error(`${relative(root, scanRoot)} does not exist`);
}

const files = await walk(scanRoot);
const failures = [];
const contentsByPath = new Map();

const read = async (path) => {
  if (!contentsByPath.has(path)) {
    contentsByPath.set(path, await readFile(path, "utf8"));
  }
  return contentsByPath.get(path);
};

const builtLinkTarget = (sourcePath, href) => {
  const sourceRoute = `/${relative(scanRoot, sourcePath).replace(/index[.]html$/, "")}`;
  const url = new URL(href, `https://docs.invalid${sourceRoute}`);
  if (url.origin !== "https://docs.invalid") return undefined;
  const pathname = decodeURIComponent(url.pathname).replace(
    /^\/docs(?=\/|$)/,
    "",
  );
  const direct = resolve(scanRoot, pathname.replace(/^\//, ""));
  const candidates = pathname.endsWith("/")
    ? [resolve(direct, "index.html")]
    : [direct, resolve(direct, "index.html"), `${direct}.html`];
  return { candidates, hash: decodeURIComponent(url.hash.slice(1)) };
};

for (const path of files) {
  const contents = await read(path);
  for (const rule of prohibited) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(contents)) {
      failures.push(`${relative(root, path)} contains ${rule.label}`);
    }
  }

  if (built) {
    if (extname(path) !== ".html") continue;
    const hrefPattern = /href=["']([^"']+)["']/g;
    for (const match of contents.matchAll(hrefPattern)) {
      if (/^(?:data:|mailto:|tel:|javascript:)/.test(match[1])) continue;
      const target = builtLinkTarget(path, match[1]);
      if (!target) continue;
      const targetPath = target.candidates.find(existsSync);
      if (!targetPath) {
        failures.push(
          `${relative(root, path)} links to missing built target ${match[1]}`,
        );
        continue;
      }
      if (
        target.hash &&
        !(await read(targetPath)).includes(`id="${target.hash}"`)
      ) {
        failures.push(
          `${relative(root, path)} links to missing fragment ${match[1]}`,
        );
      }
    }
    continue;
  }
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;
  for (const match of contents.matchAll(linkPattern)) {
    const href = match[1].split("#", 1)[0];
    if (!href || href.startsWith("https://") || href.startsWith("mailto:")) {
      continue;
    }
    if (!href.startsWith("/")) {
      failures.push(
        `${relative(root, path)} uses non-root internal link ${href}`,
      );
      continue;
    }
    const slug = href
      .replace(/^\/docs(?=\/|$)/, "")
      .replace(/^\//, "")
      .replace(/\/$/, "");
    const candidates = slug
      ? [
          resolve(scanRoot, `${slug}.md`),
          resolve(scanRoot, `${slug}.mdx`),
          resolve(scanRoot, slug, "index.md"),
          resolve(scanRoot, slug, "index.mdx"),
        ]
      : [resolve(scanRoot, "index.md"), resolve(scanRoot, "index.mdx")];
    if (!candidates.some(existsSync)) {
      failures.push(`${relative(root, path)} links to missing page ${href}`);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join("\n"));
  process.exitCode = 1;
} else {
  const scope = built ? "built docs" : "docs source and internal links";
  console.log(`Checked ${files.length} files: ${scope} passed.`);
}
