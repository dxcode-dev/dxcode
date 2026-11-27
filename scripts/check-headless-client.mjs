// Keeps dx headless (wiki/headless-client.md). Fails when:
// - a Web production file holds more `/v1` path literals than the baseline
//   allows. New calls go through `dxClient.call(<Endpoint>)` with an endpoint
//   defined in @dx/api, so a UI never repeats a path by hand. When a file
//   holds fewer, the baseline must shrink with it: run with --update.
// - packages/client imports a UI framework or reads a browser global, since
//   every UI (web, native shells, a CLI) must be able to run it.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const baselinePath = join(
  repositoryRoot,
  "scripts/headless-client-baseline.json",
);
const exportConfigPath = join(
  repositoryRoot,
  "internal/release/public-release/export.json",
);
const update = process.argv.includes("--update");

/** export.json's `private` globs; the public tree has neither them nor such files. */
const privateGlobs = existsSync(exportConfigPath)
  ? JSON.parse(readFileSync(exportConfigPath, "utf8")).private.map(
      (glob) =>
        new RegExp(
          `^${glob
            .split("**")
            .map((part) =>
              part
                .split("*")
                .map((piece) => piece.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
                .join("[^/]*"),
            )
            .join(".*")}$`,
        ),
    )
  : [];
const isPrivate = (path) => privateGlobs.some((glob) => glob.test(path));
const readBaseline = (path) => JSON.parse(readFileSync(path, "utf8"));

const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
const isProductionSource = (path) =>
  [".ts", ".tsx"].includes(extname(path)) &&
  !path.includes(".test.") &&
  !path.includes(".spec.") &&
  !path.includes(".stories.") &&
  !path.split(sep).includes("testing") &&
  !path.endsWith(".d.ts");
const repositoryPath = (path) =>
  relative(repositoryRoot, path).split(sep).join("/");
const parsed = (path) => {
  const source = readFileSync(path, "utf8");
  return parse(source, {
    sourceType: "module",
    sourceFilename: path,
    plugins: ["typescript", ...(path.endsWith(".tsx") ? ["jsx"] : [])],
  });
};

/**
 * Whether a literal's text holds a dx API path. A `/v1` right after a
 * scheme and host in the same literal, such as `https://${host}/v1` for a
 * provider's own API, is another service's URL. A template's expressions
 * read as `EXPRESSION`, text that is not a slash, so `${host}` can be that host while
 * `${origin}/v1/…`, with no scheme, stays a dx path.
 */
/** Stands for a template's expression: a private-use character. */
const EXPRESSION = "\uE000";
const holdsDxPath = (text) =>
  [...text.matchAll(/(^|[^A-Za-z0-9])\/v1(?=\/|$|\?|\uE000)/g)].some(
    (match) =>
      !/[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/\s]+$/.test(
        text.slice(0, match.index + match[1].length),
      ),
  );

/** String and template literals that hold a dx API path, outside comments. */
const pathLiteralCount = (path) => {
  let count = 0;
  traverse(parsed(path), {
    StringLiteral(node) {
      if (holdsDxPath(node.node.value)) count += 1;
    },
    TemplateLiteral(node) {
      const text = node.node.quasis
        .map((quasi) => quasi.value.raw)
        .join(EXPRESSION);
      if (holdsDxPath(text)) count += 1;
    },
  });
  return count;
};

const counts = Object.fromEntries(
  walk(join(repositoryRoot, "apps/web/src"))
    .filter(isProductionSource)
    .map((path) => [repositoryPath(path), pathLiteralCount(path)])
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => left.localeCompare(right)),
);
// Files the public export leaves out keep their counts in another
// headless-client-baseline.json inside a private Web folder, so the public
// tree names none of them.
const privateBaselinePaths = walk(join(repositoryRoot, "apps/web/src")).filter(
  (path) => path.endsWith(`${sep}headless-client-baseline.json`),
);
const baseline = Object.assign(
  readBaseline(baselinePath),
  ...privateBaselinePaths.map(readBaseline),
);
const failures = [];

const grown = Object.entries(counts).filter(
  ([path, count]) => count > (baseline[path] ?? 0),
);
for (const [path, count] of grown)
  failures.push(
    `${path}: ${count} /v1 path literals, baseline allows ${baseline[path] ?? 0}. Define the endpoint with defineEndpoint in @dx/api (add it to packages/api/src/endpoints.ts) and call it with dxClient.call from shared/api/client.ts instead of writing the path.`,
  );
// The public export leaves some files out (export.json's private globs and
// each source's excludes, such as prototypes) and ships without export.json.
// There, a baseline entry for a file the tree lacks is not a shrunk file.
const exportedTree = privateGlobs.length === 0;
const shrunk = Object.entries(baseline).filter(
  ([path, allowed]) =>
    (counts[path] ?? 0) < allowed &&
    !(exportedTree && !existsSync(join(repositoryRoot, path))),
);
if (update) {
  if (grown.length > 0) {
    console.error("The baseline only shrinks. Fix these first:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }
  const write = (path, entries) => {
    writeFileSync(path, `${JSON.stringify(entries, undefined, 2)}\n`);
    console.log(`Wrote ${repositoryPath(path)}.`);
  };
  const split = (keep) =>
    Object.fromEntries(
      Object.entries(counts).filter(([path]) => isPrivate(path) === keep),
    );
  const privateCounts = split(true);
  if (
    Object.keys(privateCounts).length > 0 &&
    privateBaselinePaths.length !== 1
  ) {
    console.error(
      "Private files hold /v1 literals: keep exactly one headless-client-baseline.json in a private apps/web/src folder.",
    );
    process.exit(1);
  }
  write(baselinePath, split(false));
  for (const path of privateBaselinePaths) write(path, privateCounts);
  process.exit(0);
}
for (const [path, allowed] of shrunk)
  failures.push(
    `${path}: ${counts[path] ?? 0} /v1 path literals, baseline still allows ${allowed}. Run node scripts/check-headless-client.mjs --update to lower it.`,
  );

const forbiddenImport =
  /^(react|react-dom|@tanstack\/|@base-ui\/|@flue\/react|@dx\/web|@dx\/core)(\/|$)/;
const browserGlobals = new Set([
  "window",
  "document",
  "localStorage",
  "sessionStorage",
  "navigator",
  "location",
]);
for (const path of walk(join(repositoryRoot, "packages/client/src")).filter(
  isProductionSource,
)) {
  traverse(parsed(path), {
    ImportDeclaration(node) {
      const source = node.node.source.value;
      if (forbiddenImport.test(source) || source.startsWith("../../"))
        failures.push(
          `${repositoryPath(path)}: imports ${source}. @dx/client runs under every UI, so it imports only @dx/api, @dx/domain, effect, and @flue/sdk (not @flue/react).`,
        );
    },
    Identifier(node) {
      const name = node.node.name;
      if (
        browserGlobals.has(name) &&
        node.isReferencedIdentifier() &&
        node.scope.getBinding(name) === undefined
      )
        failures.push(
          `${repositoryPath(path)}: reads the browser global ${name}. Take it from the DxTransport or another argument the UI passes in.`,
        );
    },
  });
}

if (failures.length > 0) {
  console.error("dx headless client check failed (wiki/headless-client.md):");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("dx headless client rules hold.");
}
