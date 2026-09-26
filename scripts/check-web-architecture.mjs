import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "@babel/parser";
import traverse from "@babel/traverse";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultSourceRoot = join(repositoryRoot, "apps/web/src");

const messages = {
  "browser-persistence-ownership":
    "Only accepted validated browser external-store adapters may persist browser preferences or New Thread prompt drafts. Keep other drafts and server data mount-scoped or in their existing authority.",
  "feature-import-boundary":
    "Feature modules may not reach through another feature's implementation. Move shared UI to src/shared, or import server data from the owning *-queries/*-mutations module.",
  "feature-data-imperative-api":
    "Production modules expose declarative query and mutation options only. Do not call or expose fetchQuery/fetchInfiniteQuery or accept Promise-returning request callbacks.",
  "feature-data-raw-api-export":
    "Only feature data modules may import raw dx operations to implement queryFn/mutationFn, and no module may re-export or alias those callable operations.",
  "no-component-dx-api":
    "Components and helpers may not import the shared dx API client directly. Move the request and schema decoding into the owning feature's *-queries or *-mutations module.",
  "no-component-fetch":
    "Production modules may not call fetch directly outside the exact shared dx transport, auth exchange, and Flue fetch adapters. Put dx HTTP work in the owning feature data module.",
  "no-component-browser-storage":
    "Components may not read or write localStorage/sessionStorage directly. Keep ephemeral and sensitive drafts mount-scoped; put demonstrated device preferences in a versioned useSyncExternalStore adapter.",
  "no-component-query-client":
    "Only shared Query infrastructure may create a QueryClient, and only the application root and auth lifecycle may import its singleton. Use Query hooks or feature options elsewhere.",
  "no-component-use-effect":
    "Do not call useEffect directly in a component. Derive during render, handle the originating event, use useSyncExternalStore, or isolate external-system synchronization in a shared hook.",
  "no-global-client-store":
    "Do not add Zustand, TanStack Store, or Effect Atom. Router, Query, Flue, local React state, and the validated browser adapters own the current state lifetimes.",
  "no-use-async-data":
    "Do not add useAsyncData. Define typed query options in the owning feature's *-queries module and consume them with TanStack Query.",
  "query-definition-ownership":
    "Query keys, query functions, and mutation options belong in the owning feature's *-queries or *-mutations module, not in components, routes, shared hooks, or client stores.",
  "query-module-component-dependency":
    "Feature query modules may not depend on components. Keep keys, request functions, and options in the data module and let components depend on it.",
  "server-state-client-store":
    "Do not put dx, Query, or Flue server state in a client store. TanStack Query owns dx HTTP state and Flue owns conversation state.",
  "shared-import-boundary":
    "Shared modules may not import feature implementations. Move the dependency to the application/feature composition boundary.",
};

const walk = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
const normalized = (path) => path.split(sep).join("/");
const isProductionSource = (path) =>
  [".ts", ".tsx"].includes(extname(path)) &&
  !path.includes(".test.") &&
  !path.includes(".spec.") &&
  !path.split(sep).includes("testing") &&
  !path.endsWith("vite-env.d.ts");
const featureOwner = (path) =>
  normalized(path).match(/\/features\/([^/]+)\//)?.[1];
const isFeatureDataModule = (path) =>
  /-(queries|mutations)\.(ts|tsx)$/.test(path);
const directFetchOwners = new Set([
  "apps/web/src/shared/api/client.ts",
  "apps/web/src/shared/auth/auth-client.ts",
  "apps/web/src/shared/same-origin-fetch.ts",
]);
const queryClientConsumers = new Set([
  "apps/web/src/main.tsx",
  "apps/web/src/shared/auth/auth-gate.tsx",
]);
const queryClientOwner = "apps/web/src/shared/query/query-client.ts";
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const indices = (source, pattern) =>
  [...source.matchAll(pattern)].map((match) => ({
    index: match.index,
    text: match[0],
  }));
const exportedConstParameters = (source) =>
  indices(source, /\bexport\s+const\s+\w+\s*=\s*\(/g).flatMap(
    ({ index, text }) => {
      const start = index + text.lastIndexOf("(");
      let depth = 0;
      for (let cursor = start; cursor < source.length; cursor += 1) {
        if (source[cursor] === "(") depth += 1;
        else if (source[cursor] === ")") {
          depth -= 1;
          if (depth === 0)
            return [{ index: start, text: source.slice(start + 1, cursor) }];
        }
      }
      return [];
    },
  );

const resolveLocalImport = (sourcePath, specifier) => {
  if (!specifier.startsWith(".")) return undefined;
  const raw = resolve(dirname(sourcePath), specifier);
  const withoutJs = raw.replace(/\.js$/, "");
  return [raw, `${withoutJs}.ts`, `${withoutJs}.tsx`].find(existsSync);
};
const resolvedSourcePath = (sourceRoot, sourcePath, specifier) => {
  const target = resolveLocalImport(sourcePath, specifier);
  return target === undefined
    ? undefined
    : normalized(relative(sourceRoot, target));
};
const isRawApiClient = (sourceRoot, sourcePath, specifier) =>
  resolvedSourcePath(sourceRoot, sourcePath, specifier) ===
    "shared/api/client.ts" || specifier.endsWith("/shared/api/client.js");
const isSharedQueryClient = (sourceRoot, sourcePath, specifier) =>
  resolvedSourcePath(sourceRoot, sourcePath, specifier) ===
    "shared/query/query-client.ts" ||
  specifier.endsWith("/shared/query/query-client.js");

const parseImports = (source) =>
  [
    ...source.matchAll(/\bimport\s+([\s\S]*?)\s+from\s+["']([^"']+)["'];?/g),
  ].map((match) => {
    const clause = match[1].trim();
    const values = [];
    const names = clause.match(/\{([\s\S]*?)\}/)?.[1];
    if (!clause.startsWith("type ") && names !== undefined) {
      for (const rawName of names.split(",")) {
        const name = rawName.trim();
        if (name === "" || name.startsWith("type ")) continue;
        const [imported, local = imported] = name.split(/\s+as\s+/);
        values.push({ imported, local });
      }
    } else if (!clause.startsWith("type ")) {
      const namespace = clause.match(/\*\s+as\s+(\w+)/)?.[1];
      if (namespace !== undefined)
        values.push({ imported: "*", local: namespace });
    }
    return {
      clause,
      specifier: match[2],
      values,
      index: match.index,
      specifierIndex: match.index + match[0].lastIndexOf(match[2]),
    };
  });
const parseReexports = (source) =>
  [
    ...source.matchAll(
      /\bexport\s+(?:\*|\{[\s\S]*?\})\s+from\s+["']([^"']+)["'];?/g,
    ),
  ].map((match) => ({
    specifier: match[1],
    index: match.index,
  }));

const aliases = (imports, specifier, importedName) =>
  imports
    .filter((entry) => entry.specifier === specifier)
    .flatMap((entry) => entry.values)
    .filter((entry) => entry.imported === importedName)
    .map((entry) => entry.local);
const namespaces = (imports, specifier) =>
  imports
    .filter((entry) => entry.specifier === specifier)
    .flatMap((entry) => entry.values)
    .filter((entry) => entry.imported === "*")
    .map((entry) => entry.local);

const directFetchCalls = (source, path) => {
  const calls = [];
  const ast = parse(source, {
    sourceType: "module",
    sourceFilename: path,
    plugins: ["typescript", ...(path.endsWith(".tsx") ? ["jsx"] : [])],
  });
  const globalName = (expression, name) =>
    expression.isIdentifier({ name }) &&
    expression.scope.getBinding(name) === undefined;
  const fetchReference = (expression, seen = new Set()) => {
    if (expression.isIdentifier()) {
      const name = expression.node.name;
      const binding = expression.scope.getBinding(name);
      if (name === "fetch" && binding === undefined) return true;
      if (
        binding === undefined ||
        !binding.constant ||
        !binding.path.isVariableDeclarator() ||
        binding.path.parentPath.node.kind !== "const" ||
        seen.has(binding)
      )
        return false;
      const initializer = binding.path.get("init");
      if (!initializer.isExpression()) return false;
      seen.add(binding);
      return fetchReference(initializer, seen);
    }
    if (!expression.isMemberExpression()) return false;
    const object = expression.get("object");
    const property = expression.get("property");
    const fetchProperty = expression.node.computed
      ? property.isStringLiteral({ value: "fetch" })
      : property.isIdentifier({ name: "fetch" });
    return (
      fetchProperty &&
      (globalName(object, "globalThis") || globalName(object, "window"))
    );
  };
  traverse(ast, {
    CallExpression(call) {
      const callee = call.get("callee");
      if (!callee.isExpression() || !fetchReference(callee)) return;
      calls.push({
        index: callee.node.start,
        evidence:
          callee.isIdentifier() && callee.node.name !== "fetch"
            ? `call global fetch alias ${callee.node.name}`
            : "call global fetch",
      });
    },
  });
  return calls;
};

const violationId = ({ rule, path, evidence, occurrence }) =>
  JSON.stringify([rule, path, evidence, occurrence]);

export const inspectWebArchitecture = ({
  sourceRoot = defaultSourceRoot,
  displayRoot = repositoryRoot,
  sourceFiles,
} = {}) => {
  const violations = [];
  for (const path of (sourceFiles ?? walk(sourceRoot)).filter(
    isProductionSource,
  )) {
    const source = readFileSync(path, "utf8");
    const imports = parseImports(source);
    const reexports = parseReexports(source);
    const owner = featureOwner(path);
    const component = path.endsWith(".tsx");
    const dataModule = owner !== undefined && isFeatureDataModule(path);
    const sharedModule = normalized(path).includes("/shared/");
    const displayPath = normalized(relative(displayRoot, path));
    const occurrences = new Map();
    const add = (rule, index, evidence) => {
      const before = source.slice(0, index);
      const lineStart = before.lastIndexOf("\n");
      const occurrenceKey = `${rule}\0${evidence}`;
      const occurrence = (occurrences.get(occurrenceKey) ?? 0) + 1;
      occurrences.set(occurrenceKey, occurrence);
      violations.push({
        rule,
        path: displayPath,
        evidence,
        occurrence,
        line: before.split("\n").length,
        column: index - lineStart,
        message: messages[rule],
      });
    };
    const addCalls = (rule, names) => {
      for (const name of names)
        for (const { index } of indices(
          source,
          new RegExp(`\\b${escapePattern(name)}\\s*\\(`, "g"),
        ))
          add(rule, index, `call ${name}`);
    };

    let importsClientStore = false;
    let importsServerState = false;
    let storeImportIndex;
    for (const imported of imports) {
      const { specifier, values } = imported;
      const importsRawApiClient = isRawApiClient(sourceRoot, path, specifier);
      const importsSharedQueryClient = isSharedQueryClient(
        sourceRoot,
        path,
        specifier,
      );
      if (
        specifier === "@tanstack/react-store" ||
        specifier === "zustand" ||
        specifier.startsWith("zustand/") ||
        specifier.includes("effect-atom")
      ) {
        importsClientStore ||= values.length > 0;
        storeImportIndex ??= imported.index;
        if (values.length > 0)
          add("no-global-client-store", imported.index, `import ${specifier}`);
      }
      if (
        specifier === "@tanstack/react-query" ||
        specifier === "@flue/react" ||
        specifier === "@flue/sdk" ||
        importsRawApiClient
      )
        importsServerState ||= values.length > 0;

      if (!dataModule && importsRawApiClient && values.length > 0) {
        const operations = values.filter(
          (value) =>
            component ||
            value.imported === "*" ||
            /^\p{Ll}/u.test(value.imported),
        );
        for (const value of operations) {
          const valueIndex = source.indexOf(value.local, imported.index);
          add(
            "no-component-dx-api",
            valueIndex,
            `import ${value.imported}${value.local === value.imported ? "" : ` as ${value.local}`} from ${specifier}`,
          );
        }
      }
      if (
        !queryClientConsumers.has(displayPath) &&
        importsSharedQueryClient &&
        values.length > 0
      )
        add("no-component-query-client", imported.index, `import ${specifier}`);
      if (importsSharedQueryClient)
        for (const value of values) {
          const patterns = [
            new RegExp(
              `\\bexport\\s*\\{[^}]*\\b${escapePattern(value.local)}\\b[^}]*\\}`,
              "g",
            ),
            new RegExp(
              `\\bexport\\s+const\\s+\\w+\\s*=\\s*${escapePattern(value.local)}\\b`,
              "g",
            ),
          ];
          for (const pattern of patterns)
            for (const { index } of indices(source, pattern))
              add(
                "no-component-query-client",
                index,
                "re-export shared QueryClient singleton",
              );
        }

      const target = resolveLocalImport(path, specifier);
      const targetOwner =
        target === undefined ? undefined : featureOwner(target);
      if (
        owner !== undefined &&
        targetOwner !== undefined &&
        owner !== targetOwner &&
        !isFeatureDataModule(target)
      )
        add(
          "feature-import-boundary",
          imported.specifierIndex,
          `import ${specifier}`,
        );
      if (sharedModule && targetOwner !== undefined)
        add(
          "shared-import-boundary",
          imported.specifierIndex,
          `import ${specifier}`,
        );
      if (dataModule && target?.endsWith(".tsx"))
        add(
          "query-module-component-dependency",
          imported.specifierIndex,
          `import ${specifier}`,
        );
    }

    for (const { index, text } of indices(
      source,
      /\b(?:fetchQuery|fetchInfiniteQuery)\s*\(/g,
    ))
      add("feature-data-imperative-api", index, `call ${text.trim()}`);

    for (const { index, text } of exportedConstParameters(source))
      if (/=>\s*Promise\s*</.test(text))
        add(
          "feature-data-imperative-api",
          index,
          "Promise-returning mutation option parameter",
        );

    for (const reexported of reexports) {
      if (isRawApiClient(sourceRoot, path, reexported.specifier))
        add(
          "feature-data-raw-api-export",
          reexported.index,
          "direct export from the raw API client",
        );
      if (isSharedQueryClient(sourceRoot, path, reexported.specifier))
        add(
          "no-component-query-client",
          reexported.index,
          "direct export from the shared QueryClient singleton",
        );
    }

    for (const imported of imports.filter((entry) =>
      isRawApiClient(sourceRoot, path, entry.specifier),
    )) {
      for (const value of imported.values) {
        if (value.imported !== "*" && !/^\p{Ll}/u.test(value.imported))
          continue;
        const patterns = [
          new RegExp(
            `\\bexport\\s*\\{[^}]*\\b${escapePattern(value.local)}\\b[^}]*\\}`,
            "g",
          ),
          new RegExp(
            `\\bexport\\s+const\\s+\\w+\\s*=\\s*${escapePattern(value.local)}\\b`,
            "g",
          ),
        ];
        for (const pattern of patterns)
          for (const { index } of indices(source, pattern))
            add(
              "feature-data-raw-api-export",
              index,
              `export raw operation ${value.imported}`,
            );
      }
    }

    if (
      importsClientStore &&
      importsServerState &&
      storeImportIndex !== undefined
    )
      add(
        "server-state-client-store",
        storeImportIndex,
        "client store and server-state dependencies coexist",
      );

    addCalls(
      "no-use-async-data",
      imports
        .filter((entry) =>
          entry.specifier.endsWith("/shared/hooks/use-async-data.js"),
        )
        .flatMap((entry) => entry.values.map((value) => value.local)),
    );
    if (!directFetchOwners.has(displayPath))
      for (const call of directFetchCalls(source, path))
        add("no-component-fetch", call.index, call.evidence);
    if (component) {
      for (const { index, text } of indices(
        source,
        /\b(?:window\.)?(?:localStorage|sessionStorage)\b/g,
      ))
        add("no-component-browser-storage", index, text);
      addCalls(
        "no-component-use-effect",
        aliases(imports, "react", "useEffect"),
      );
      for (const namespace of namespaces(imports, "react"))
        addCalls("no-component-use-effect", [`${namespace}.useEffect`]);
    }
    if (displayPath !== queryClientOwner) {
      for (const name of aliases(
        imports,
        "@tanstack/react-query",
        "QueryClient",
      ))
        for (const { index } of indices(
          source,
          new RegExp(`\\bnew\\s+${escapePattern(name)}\\s*\\(`, "g"),
        ))
          add("no-component-query-client", index, "new QueryClient");
      for (const namespace of namespaces(imports, "@tanstack/react-query"))
        for (const { index } of indices(
          source,
          new RegExp(
            `\\bnew\\s+${escapePattern(namespace)}\\.QueryClient\\s*\\(`,
            "g",
          ),
        ))
          add("no-component-query-client", index, "new QueryClient");
    }
    const persistenceOwner =
      displayPath.endsWith("/shared/theme/theme-store.ts") ||
      displayPath.endsWith("/shared/commands/command-registry.ts") ||
      displayPath.endsWith("/features/threads/new-thread-draft-store.ts");
    if (!persistenceOwner)
      for (const { index, text } of indices(
        source,
        /\b(?:window\.)?(?:localStorage|sessionStorage)\b/g,
      ))
        add("browser-persistence-ownership", index, text);
    if (!dataModule) {
      addCalls("query-definition-ownership", [
        ...aliases(imports, "@tanstack/react-query", "queryOptions"),
        ...aliases(imports, "@tanstack/react-query", "infiniteQueryOptions"),
        ...aliases(imports, "@tanstack/react-query", "mutationOptions"),
      ]);
      for (const namespace of namespaces(imports, "@tanstack/react-query"))
        addCalls("query-definition-ownership", [
          `${namespace}.queryOptions`,
          `${namespace}.infiniteQueryOptions`,
          `${namespace}.mutationOptions`,
        ]);
      for (const { index, text } of indices(
        source,
        /\b(?:queryKey|queryFn)\s*:/g,
      ))
        add(
          "query-definition-ownership",
          index,
          `property ${text.replace(/\s+/g, "")}`,
        );
    }
  }
  return violations.sort((left, right) =>
    violationId(left).localeCompare(violationId(right)),
  );
};

const main = () => {
  const selectedPaths = process.argv.slice(2);
  const violations = inspectWebArchitecture({
    sourceFiles:
      selectedPaths.length === 0
        ? undefined
        : selectedPaths.map((path) => resolve(repositoryRoot, path)),
  });
  for (const violation of violations)
    console.error(
      `${violation.path}:${violation.line}:${violation.column} architecture/${violation.rule} ERROR ${violation.message}`,
    );
  if (violations.length > 0) {
    console.error(
      `Frontend architecture check failed: ${violations.length} violation(s).`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("Frontend architecture check passed with zero violations.");
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
