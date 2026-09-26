import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { loadMigrationManifest } from "./migration-manifest.mjs";

export const productionManifestFilename = "production-manifest.json";
const workspaceRoot = resolve(import.meta.dirname, "..");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const entrypoints = [
  { kind: "worker", path: "worker/index.js" },
  { kind: "web", path: "assets/index.html" },
];
const dxdReleaseMetadata = () => {
  const cargoManifest = readFileSync(
    resolve(workspaceRoot, "apps/dxd/Cargo.toml"),
    "utf8",
  );
  const packageSection = cargoManifest.match(
    /^\[package\]\nname = "dxd"\nversion = "([0-9]+\.[0-9]+\.[0-9]+)"\n/m,
  );
  if (packageSection?.[1] === undefined)
    throw new Error("dxd package metadata is invalid.");
  return {
    release: packageSection[1],
    target: "linux-x64",
    cargoLockSha256: sha256(
      readFileSync(resolve(workspaceRoot, "apps/dxd/Cargo.lock")),
    ),
  };
};
const inheritedEnvironmentNames = ["PATH"];
const generatedEnvironmentNames = [
  "CI",
  "HOME",
  "TZ",
  "CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH",
];
const packageIdentityGeneratorPath = "scripts/production-package.mjs";
const forbiddenPath =
  /(^|\/)(?:__fixtures__?|fixtures?|recordings?|certification|testing|tests?|private)(?:\/|$)|(?:^|\/)[^/]+\.(?:test|spec)\.[^/]+$|(?:^|\/)\.dev\.vars(?:\.|$)|\.har$|\.map$/i;
const forbiddenSignatures = [
  "/__fixtures/",
  "dx-local-model-fixture-v1",
  "transcript-parity-fixture",
  "fixture-capability-preview",
  "resident-terminal-preview-certification",
];

const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const slash = (path) => path.split(sep).join("/");
const isStrictDescendant = (root, candidate) => {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`);
};

export const assertProductionPackageOutput = ({
  repositoryRoot,
  outputRoot,
}) => {
  const packageArea = resolve(repositoryRoot, ".dx");
  const output = resolve(outputRoot);
  if (!isStrictDescendant(packageArea, output))
    throw new Error(
      "--output must be a strict descendant of the checkout's .dx package area.",
    );

  let current = packageArea;
  for (const part of relative(packageArea, output).split(sep)) {
    if (existsSync(current)) {
      const info = lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error(
          "--output must not traverse a symlink or non-directory in the checkout's .dx package area.",
        );
    }
    current = resolve(current, part);
  }
  if (existsSync(current)) {
    const info = lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(
        "--output must not be a symlink or non-directory in the checkout's .dx package area.",
      );
  }
  return output;
};

const isPackagePath = (path) =>
  typeof path === "string" &&
  path.length > 0 &&
  slash(path) === path &&
  !path.startsWith("/") &&
  path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
const canonicalArtifactHash = (files) =>
  sha256(
    files
      .map(({ path, sha256: hash, size }) => `${path}\0${size}\0${hash}\n`)
      .join(""),
  );
const packageIdentityGenerator = () => ({
  script: packageIdentityGeneratorPath,
  sha256: sha256(
    readFileSync(resolve(workspaceRoot, packageIdentityGeneratorPath)),
  ),
});

export const loadProductionBindingContract = () => {
  const contract = readJson(
    resolve(workspaceRoot, "apps/core/production-bindings.json"),
  );
  const allowedTypes = new Set([
    "text",
    "secret",
    "d1",
    "r2",
    "durable-object",
    "send-email",
    "workers-ai",
  ]);
  const allowedProvenance = new Set([
    "authored-wrangler",
    "generated-flue",
    "alchemy",
  ]);
  const names = contract.bindings?.map(({ name }) => name) ?? [];
  const generatedBindings =
    contract.bindings?.filter(
      ({ provenance }) => provenance === "generated-flue",
    ) ?? [];
  if (
    contract.version !== 1 ||
    !Array.isArray(contract.bindings) ||
    contract.bindings.length === 0 ||
    new Set(names).size !== names.length ||
    JSON.stringify(names) !== JSON.stringify([...names].sort()) ||
    contract.bindings.some(
      ({ name, type, provenance }) =>
        typeof name !== "string" ||
        !allowedTypes.has(type) ||
        !allowedProvenance.has(provenance) ||
        (provenance === "alchemy" &&
          type !== "text" &&
          type !== "secret" &&
          type !== "send-email"),
    ) ||
    generatedBindings.length !== 1 ||
    generatedBindings[0].type !== "durable-object"
  )
    throw new Error("Production binding contract is invalid.");
  return contract;
};

const bindingsFromWrangler = (config, authoredNames) => {
  const bindings = [
    ...Object.keys(config.vars ?? {}).map((name) => ({ name, type: "text" })),
    ...(config.secrets?.required ?? []).map((name) => ({
      name,
      type: "secret",
    })),
    ...(config.d1_databases ?? []).map(({ binding: name }) => ({
      name,
      type: "d1",
    })),
    ...(config.r2_buckets ?? []).map(({ binding: name }) => ({
      name,
      type: "r2",
    })),
    ...(config.durable_objects?.bindings ?? []).map(({ name }) => ({
      name,
      type: "durable-object",
    })),
    ...(config.ai?.binding
      ? [{ name: config.ai.binding, type: "workers-ai" }]
      : []),
  ];
  return bindings
    .map(({ name, type }) => {
      const provenance =
        authoredNames !== undefined && !authoredNames.has(name)
          ? "generated-flue"
          : "authored-wrangler";
      return { name, type, provenance };
    })
    .sort((left, right) => left.name.localeCompare(right.name));
};

export const validateProductionBindingConfiguration = ({
  authoredConfig,
  generatedConfig,
}) => {
  const contract = loadProductionBindingContract();
  const authoredExpected = contract.bindings.filter(
    ({ provenance }) => provenance === "authored-wrangler",
  );
  const generatedExpected = contract.bindings.filter(
    ({ provenance }) => provenance !== "alchemy",
  );
  const authoredNames = new Set(authoredExpected.map(({ name }) => name));
  if (
    JSON.stringify(bindingsFromWrangler(authoredConfig)) !==
      JSON.stringify(authoredExpected) ||
    JSON.stringify(bindingsFromWrangler(generatedConfig, authoredNames)) !==
      JSON.stringify(generatedExpected)
  )
    throw new Error(
      "Authored/generated Wrangler bindings drifted from the production binding contract.",
    );
  return contract.bindings;
};

export const deriveDurableObjectBindings = ({
  authoredConfig,
  bindingContract,
  migrationManifest,
}) => {
  const contractBindings = bindingContract.bindings.filter(
    ({ type }) => type === "durable-object",
  );
  const authoredBindings = authoredConfig.durable_objects?.bindings ?? [];
  const authoredContractNames = contractBindings
    .filter(({ provenance }) => provenance === "authored-wrangler")
    .map(({ name }) => name)
    .sort();
  const authoredNames = authoredBindings.map(({ name }) => name).sort();
  const authoredClasses = authoredBindings.map(({ class_name }) => class_name);
  const canonicalClasses = migrationManifest.durableObjects.flatMap(
    ({ newSqliteClasses }) => newSqliteClasses,
  );
  const generatedBindings = contractBindings.filter(
    ({ provenance }) => provenance === "generated-flue",
  );
  const generatedClasses = canonicalClasses.filter(
    (className) => !authoredClasses.includes(className),
  );

  if (
    JSON.stringify(authoredNames) !== JSON.stringify(authoredContractNames) ||
    new Set(authoredNames).size !== authoredNames.length ||
    new Set(authoredClasses).size !== authoredClasses.length ||
    new Set(canonicalClasses).size !== canonicalClasses.length ||
    authoredClasses.some(
      (className) => !canonicalClasses.includes(className),
    ) ||
    generatedBindings.length !== 1 ||
    generatedClasses.length !== 1
  )
    throw new Error(
      "Production Durable Object bindings do not match Wrangler and migration authorities.",
    );

  const classesByBinding = new Map(
    authoredBindings.map(({ name, class_name }) => [name, class_name]),
  );
  classesByBinding.set(generatedBindings[0].name, generatedClasses[0]);
  return contractBindings.map(({ name }) => ({
    name,
    className: classesByBinding.get(name),
  }));
};

export const deriveGeneratorPackageProvenance = ({
  astroPackage,
  cloudflarePackage,
  corePackage,
  coreVitePackage,
  docsPackage,
  webPackage,
  webVitePackage,
}) => {
  const astroPin = docsPackage.dependencies?.astro;
  const cloudflarePin =
    corePackage.devDependencies?.["@cloudflare/vite-plugin"];
  const coreVitePin = corePackage.devDependencies?.vite;
  const webVitePin = webPackage.devDependencies?.vite;
  if (
    astroPackage.name !== "astro" ||
    cloudflarePackage.name !== "@cloudflare/vite-plugin" ||
    coreVitePackage.name !== "vite" ||
    webVitePackage.name !== "vite" ||
    astroPin !== astroPackage.version ||
    cloudflarePin !== cloudflarePackage.version ||
    coreVitePin !== coreVitePackage.version ||
    webVitePin !== webVitePackage.version ||
    coreVitePackage.version !== webVitePackage.version
  )
    throw new Error(
      "Resolved production generators drifted from pinned package metadata.",
    );
  return {
    docs: { package: astroPackage.name, version: astroPackage.version },
    worker: {
      package: cloudflarePackage.name,
      version: cloudflarePackage.version,
    },
    web: { package: webVitePackage.name, version: webVitePackage.version },
  };
};

const loadGeneratorPackageProvenance = () =>
  deriveGeneratorPackageProvenance({
    corePackage: readJson(resolve(workspaceRoot, "apps/core/package.json")),
    docsPackage: readJson(resolve(workspaceRoot, "apps/docs/package.json")),
    webPackage: readJson(resolve(workspaceRoot, "apps/web/package.json")),
    astroPackage: readJson(
      resolve(workspaceRoot, "apps/docs/node_modules/astro/package.json"),
    ),
    cloudflarePackage: readJson(
      resolve(
        workspaceRoot,
        "apps/core/node_modules/@cloudflare/vite-plugin/package.json",
      ),
    ),
    coreVitePackage: readJson(
      resolve(workspaceRoot, "apps/core/node_modules/vite/package.json"),
    ),
    webVitePackage: readJson(
      resolve(workspaceRoot, "apps/web/node_modules/vite/package.json"),
    ),
  });

export const productionBuildEnvironment = (environment) => ({
  CI: "1",
  PATH: environment.PATH ?? "",
  TZ: "UTC",
});

const filesUnder = (directory, root = directory) =>
  readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error("Production packages may not contain symbolic links.");
      return entry.isDirectory()
        ? filesUnder(path, root)
        : [slash(relative(root, path))];
    });

const readGraph = (
  root,
  { file: expectedFile, nonGraphFiles, source: expectedSource },
) => {
  const manifestPath = resolve(root, ".vite/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    manifest === null ||
    typeof manifest !== "object" ||
    Array.isArray(manifest)
  )
    throw new Error("Production import manifest is invalid.");

  const roots = Object.entries(manifest).filter(
    ([, value]) => value?.isEntry === true,
  );
  if (
    roots.length !== 1 ||
    roots[0][0] !== expectedSource ||
    (expectedFile !== undefined && roots[0][1]?.file !== expectedFile)
  ) {
    throw new Error("Production import manifest has an unknown entrypoint.");
  }

  const reachable = new Set();
  const visit = (key) => {
    if (reachable.has(key)) return;
    const value = manifest[key];
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("Production import manifest has an unknown graph entry.");
    reachable.add(key);
    for (const field of ["imports", "dynamicImports"]) {
      const dependencies = value[field] ?? [];
      if (
        !Array.isArray(dependencies) ||
        dependencies.some((dependency) => typeof dependency !== "string")
      )
        throw new Error("Production import manifest is invalid.");
      for (const dependency of dependencies) visit(dependency);
    }
  };
  visit(roots[0][0]);
  for (const [source, value] of Object.entries(manifest)) {
    if (
      !reachable.has(source) &&
      typeof value?.file === "string" &&
      !value.file.endsWith(".js")
    )
      visit(source);
  }
  if (reachable.size !== Object.keys(manifest).length)
    throw new Error(
      "Production import manifest contains an unreachable entry.",
    );

  const outputs = new Set();
  const graph = [...reachable].sort().map((source) => {
    const value = manifest[source];
    if (
      typeof value.file !== "string" ||
      forbiddenPath.test(source) ||
      forbiddenPath.test(value.src ?? "")
    )
      throw new Error("Production graph contains a forbidden module.");
    const entryOutputs = [
      value.file,
      ...(value.css ?? []),
      ...(value.assets ?? []),
    ].sort();
    for (const path of entryOutputs) {
      if (!isPackagePath(path) || forbiddenPath.test(path))
        throw new Error("Production graph contains a forbidden output.");
      if (!existsSync(resolve(root, path)))
        throw new Error("Production graph references a missing output.");
      if (!lstatSync(resolve(root, path)).isFile())
        throw new Error("Production graph output is not a file.");
      outputs.add(path);
    }
    return {
      source,
      file: value.file,
      isEntry: value.isEntry === true,
      outputs: entryOutputs,
      imports: [...(value.imports ?? [])].sort(),
      dynamicImports: [...(value.dynamicImports ?? [])].sort(),
    };
  });
  const expectedFiles = new Set([
    ".vite/manifest.json",
    ...outputs,
    ...nonGraphFiles,
  ]);
  const actualFiles = filesUnder(root);
  if (
    actualFiles.some((path) => !expectedFiles.has(path)) ||
    [...expectedFiles].some((path) => !actualFiles.includes(path))
  )
    throw new Error("Production build contains an unknown or missing file.");
  return {
    graph,
    outputs: [...outputs].sort(),
    manifestSha256: sha256(readFileSync(manifestPath)),
  };
};

const copyOutputs = (sourceRoot, destinationRoot, outputs) => {
  for (const path of outputs) {
    const destination = resolve(destinationRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(resolve(sourceRoot, path), destination);
  }
};

const readDocsOutputs = (root) => {
  const outputs = filesUnder(root);
  if (
    !outputs.includes("index.html") ||
    !outputs.some((path) => path.startsWith("_astro/")) ||
    !outputs.includes("pagefind/pagefind.js") ||
    outputs.some(
      (path) =>
        !isPackagePath(path) ||
        forbiddenPath.test(path) ||
        path.endsWith(".map"),
    )
  )
    throw new Error(
      "Production docs build is incomplete or contains a forbidden file.",
    );
  return {
    outputs,
    manifestSha256: canonicalArtifactHash(
      outputs.map((path) => {
        const content = readFileSync(resolve(root, path));
        return { path, size: content.byteLength, sha256: sha256(content) };
      }),
    ),
  };
};

const packageFiles = (root) =>
  filesUnder(root)
    .filter((path) => path !== productionManifestFilename)
    .map((path) => {
      if (forbiddenPath.test(path))
        throw new Error(
          `Production package contains a forbidden file: ${path}`,
        );
      const content = readFileSync(resolve(root, path));
      if (
        forbiddenSignatures.some((signature) =>
          content.includes(Buffer.from(signature)),
        )
      )
        throw new Error(
          `Production package contains fixture or private code: ${path}`,
        );
      return { path, size: content.byteLength, sha256: sha256(content) };
    });

export const createProductionPackage = async ({
  coreBuildRoot,
  docsBuildRoot,
  dxdBinary,
  dxdSha256,
  outputRoot,
  revision,
  stage,
  target,
  deploymentLabel = `Branch preview · ${stage} · ${revision.slice(0, 12)}`,
  webBuildRoot,
}) => {
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error("Production package revision must be a full Git SHA.");
  if (!/^[a-f0-9]{64}$/.test(dxdSha256))
    throw new Error(
      "Production package dxd checksum must be a lowercase SHA-256.",
    );
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(stage))
    throw new Error("Production package stage is invalid.");
  if (!new Set(["branch", "staging", "selfhost"]).has(target))
    throw new Error("Production package target is invalid.");
  if (typeof dxdBinary !== "string")
    throw new Error("Production package dxd source is invalid.");
  if (
    !(
      /^Branch preview · [^·]+ · [a-f0-9]{12}$/.test(deploymentLabel) ||
      /^Staging · [a-f0-9]{12}$/.test(deploymentLabel) ||
      /^Self-host · [a-z0-9-]+ · [a-f0-9]{12}$/.test(deploymentLabel)
    )
  )
    throw new Error("Production package deployment identity is invalid.");

  const worker = readGraph(coreBuildRoot, {
    source: "virtual:cloudflare/worker-entry",
    file: "index.js",
    nonGraphFiles: ["wrangler.json"],
  });
  const webStaticFiles = [
    "deployment-bootstrap.json",
    "favicon.svg",
    "index.html",
    "robots.txt",
    "social-card.png",
  ];
  const web = readGraph(webBuildRoot, {
    source: "index.html",
    nonGraphFiles: webStaticFiles,
  });
  const webOutputs = [...new Set([...web.outputs, ...webStaticFiles])].sort();
  const docs = readDocsOutputs(docsBuildRoot);
  const migrations = await loadMigrationManifest();
  const bindings = loadProductionBindingContract().bindings;
  const generators = loadGeneratorPackageProvenance();
  for (const path of webStaticFiles) {
    if (!lstatSync(resolve(webBuildRoot, path)).isFile())
      throw new Error(`Approved static asset is missing: ${path}`);
  }

  mkdirSync(resolve(outputRoot, "worker"), { recursive: true });
  mkdirSync(resolve(outputRoot, "assets"), { recursive: true });
  copyOutputs(coreBuildRoot, resolve(outputRoot, "worker"), worker.outputs);
  copyOutputs(webBuildRoot, resolve(outputRoot, "assets"), webOutputs);
  copyOutputs(docsBuildRoot, resolve(outputRoot, "assets/docs"), docs.outputs);
  const releaseMetadata = dxdReleaseMetadata();
  const binaryMetadata = lstatSync(dxdBinary);
  if (
    !binaryMetadata.isFile() ||
    binaryMetadata.isSymbolicLink() ||
    binaryMetadata.size < 1 ||
    binaryMetadata.size > 32 * 1_024 * 1_024
  )
    throw new Error("Packaged dxd binary is invalid.");
  const binary = readFileSync(dxdBinary);
  if (
    binary.length < 20 ||
    !binary.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    binary[4] !== 2 ||
    binary[5] !== 1 ||
    binary[18] !== 0x3e ||
    binary[19] !== 0
  )
    throw new Error("Packaged dxd binary must be Linux x64 ELF.");
  if (sha256(binary) !== dxdSha256)
    throw new Error("Packaged dxd checksum does not match.");
  const dxdPath = "assets/dxd";
  writeFileSync(resolve(outputRoot, dxdPath), binary, { mode: 0o644 });
  const dxd = {
    source: "packaged-revision",
    release: releaseMetadata.release,
    target: releaseMetadata.target,
    path: dxdPath,
    size: binary.byteLength,
    sha256: dxdSha256,
    build: {
      command:
        "cargo build --release --locked --manifest-path apps/dxd/Cargo.toml",
      cargoLockSha256: releaseMetadata.cargoLockSha256,
    },
  };
  const workerEntry = readFileSync(
    resolve(outputRoot, "worker/index.js"),
    "utf8",
  );
  for (const className of migrations.durableObjects.flatMap(
    ({ newSqliteClasses }) => newSqliteClasses,
  )) {
    if (!workerEntry.includes(className))
      throw new Error(
        `Production Worker is missing Durable Object class ${className}.`,
      );
  }
  writeFileSync(
    resolve(outputRoot, "assets/deployment-bootstrap.json"),
    `${JSON.stringify({ label: deploymentLabel })}\n`,
  );

  const files = packageFiles(outputRoot);
  const manifest = {
    schemaVersion: 1,
    artifactKind: "dx-production-package",
    identity: { stage, revision, label: deploymentLabel },
    environment: {
      policy: "positive-allowlist",
      inheritedNames: inheritedEnvironmentNames,
      generatedNames: generatedEnvironmentNames,
    },
    entrypoints,
    graph: { docs: docs.outputs, worker: worker.graph, web: web.graph },
    files,
    migrations: {
      manifestVersion: migrations.version,
      d1Directory: migrations.d1Directory,
      d1: migrations.d1.map(({ filename, sha256: hash, classification }) => ({
        filename,
        sha256: hash,
        classification,
      })),
      durableObjects: migrations.durableObjects,
    },
    durableObjects: {
      classes: migrations.durableObjects.flatMap(
        ({ newSqliteClasses }) => newSqliteClasses,
      ),
    },
    bindings,
    generatedCode: [
      {
        path: "worker/",
        generator: generators.worker,
        importManifestSha256: worker.manifestSha256,
      },
      {
        path: "assets/docs/",
        generator: generators.docs,
        importManifestSha256: docs.manifestSha256,
      },
      {
        path: "assets/",
        generator: generators.web,
        importManifestSha256: web.manifestSha256,
      },
      {
        path: "assets/deployment-bootstrap.json",
        generator: packageIdentityGenerator(),
      },
    ],
    dxd,
    sourceMaps: { policy: "forbidden", files: [] },
    artifact: {
      algorithm: "sha256",
      sha256: canonicalArtifactHash(files),
    },
    evidence: {
      classification: "package",
      proves: ["package-loading", "routing", "manifest-agreement"],
      doesNotProve: ["cloudflare", "e2b", "resident-dxd", "model-provider"],
    },
  };
  writeFileSync(
    resolve(outputRoot, productionManifestFilename),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
};

export const validateProductionPackage = async (root) => {
  const manifest = JSON.parse(
    readFileSync(resolve(root, productionManifestFilename), "utf8"),
  );
  const bindingContract = loadProductionBindingContract();
  const generators = loadGeneratorPackageProvenance();
  const releaseMetadata = dxdReleaseMetadata();
  const expectedGeneratedCode = [
    { path: "worker/", generator: generators.worker },
    { path: "assets/docs/", generator: generators.docs },
    { path: "assets/", generator: generators.web },
    {
      path: "assets/deployment-bootstrap.json",
      generator: packageIdentityGenerator(),
    },
  ];
  if (
    manifest.schemaVersion !== 1 ||
    manifest.artifactKind !== "dx-production-package" ||
    JSON.stringify(Object.keys(manifest.identity ?? {}).sort()) !==
      JSON.stringify(["label", "revision", "stage"]) ||
    !/^[a-z0-9][a-z0-9-]{0,127}$/.test(manifest.identity?.stage ?? "") ||
    !/^[a-f0-9]{40}$/.test(manifest.identity?.revision ?? "") ||
    JSON.stringify(manifest.entrypoints) !== JSON.stringify(entrypoints) ||
    manifest.environment?.policy !== "positive-allowlist" ||
    JSON.stringify(manifest.environment.inheritedNames) !==
      JSON.stringify(inheritedEnvironmentNames) ||
    JSON.stringify(manifest.environment.generatedNames) !==
      JSON.stringify(generatedEnvironmentNames) ||
    JSON.stringify(manifest.bindings) !==
      JSON.stringify(bindingContract.bindings) ||
    !/^[a-f0-9]{64}$/.test(manifest.dxd?.sha256 ?? "") ||
    manifest.dxd?.release !== releaseMetadata.release ||
    manifest.dxd?.target !== releaseMetadata.target ||
    manifest.dxd?.source !== "packaged-revision" ||
    !Array.isArray(manifest.generatedCode) ||
    manifest.generatedCode.length !== 4 ||
    manifest.generatedCode.some(
      ({ path, generator, importManifestSha256 }, index) =>
        path !== expectedGeneratedCode[index].path ||
        JSON.stringify(generator) !==
          JSON.stringify(expectedGeneratedCode[index].generator) ||
        (index < 3 && !/^[a-f0-9]{64}$/.test(importManifestSha256 ?? "")) ||
        (index === 3 && importManifestSha256 !== undefined),
    ) ||
    manifest.sourceMaps?.policy !== "forbidden" ||
    manifest.sourceMaps.files?.length !== 0 ||
    manifest.artifact?.algorithm !== "sha256" ||
    JSON.stringify(manifest.evidence) !==
      JSON.stringify({
        classification: "package",
        proves: ["package-loading", "routing", "manifest-agreement"],
        doesNotProve: ["cloudflare", "e2b", "resident-dxd", "model-provider"],
      })
  )
    throw new Error("Production package manifest has an unapproved contract.");

  const publicBootstrap = JSON.parse(
    readFileSync(resolve(root, "assets/deployment-bootstrap.json"), "utf8"),
  );
  if (
    !(
      /^Branch preview · [^·]+ · [a-f0-9]{12}$/.test(
        manifest.identity?.label ?? "",
      ) ||
      /^Staging · [a-f0-9]{12}$/.test(manifest.identity?.label ?? "") ||
      /^Self-host · [a-z0-9-]+ · [a-f0-9]{12}$/.test(
        manifest.identity?.label ?? "",
      )
    ) ||
    !manifest.identity.label.endsWith(
      manifest.identity.revision.slice(0, 12),
    ) ||
    JSON.stringify(publicBootstrap) !==
      JSON.stringify({ label: manifest.identity.label })
  )
    throw new Error("Public deployment identity does not match its manifest.");

  const files = packageFiles(root);
  if (JSON.stringify(files) !== JSON.stringify(manifest.files))
    throw new Error(
      "Production package files do not exactly match the manifest.",
    );
  if (canonicalArtifactHash(files) !== manifest.artifact?.sha256)
    throw new Error("Production package artifact hash does not match.");

  const dxdFile = files.find(({ path }) => path === "assets/dxd");
  if (manifest.dxd.source === "packaged-revision") {
    if (
      JSON.stringify(Object.keys(manifest.dxd).sort()) !==
        JSON.stringify(
          [
            "build",
            "path",
            "release",
            "sha256",
            "size",
            "source",
            "target",
          ].sort(),
        ) ||
      manifest.dxd.path !== "assets/dxd" ||
      manifest.dxd.size !== dxdFile?.size ||
      manifest.dxd.sha256 !== dxdFile?.sha256 ||
      JSON.stringify(manifest.dxd.build) !==
        JSON.stringify({
          command:
            "cargo build --release --locked --manifest-path apps/dxd/Cargo.toml",
          cargoLockSha256: releaseMetadata.cargoLockSha256,
        })
    )
      throw new Error("Packaged dxd does not match its manifest.");
  }

  const validateGraph = (graph, expectedSource, prefix) => {
    if (!Array.isArray(graph))
      throw new Error("Production package graph is invalid.");
    const entries = new Map(graph.map((entry) => [entry.source, entry]));
    const roots = graph.filter(({ isEntry }) => isEntry === true);
    if (roots.length !== 1 || roots[0].source !== expectedSource)
      throw new Error("Production package graph entrypoint drifted.");
    const reachable = new Set();
    const visit = (source) => {
      if (reachable.has(source)) return;
      const entry = entries.get(source);
      if (entry === undefined || forbiddenPath.test(source))
        throw new Error("Production package graph contains an unknown entry.");
      reachable.add(source);
      for (const dependency of [
        ...(entry.imports ?? []),
        ...(entry.dynamicImports ?? []),
      ])
        visit(dependency);
    };
    visit(expectedSource);
    for (const entry of graph) {
      if (!reachable.has(entry.source) && !entry.file?.endsWith(".js"))
        visit(entry.source);
    }
    if (reachable.size !== graph.length)
      throw new Error(
        "Production package graph contains an unreachable entry.",
      );
    return new Set(
      graph.flatMap(({ outputs }) =>
        outputs.map((path) => `${prefix}/${path}`),
      ),
    );
  };
  const graphFiles = new Set([
    ...validateGraph(
      manifest.graph?.worker,
      "virtual:cloudflare/worker-entry",
      "worker",
    ),
    ...validateGraph(manifest.graph?.web, "index.html", "assets"),
    ...(manifest.graph?.docs ?? []).map((path) => `assets/docs/${path}`),
    "assets/deployment-bootstrap.json",
    "assets/favicon.svg",
    "assets/index.html",
    "assets/robots.txt",
    "assets/social-card.png",
    "assets/dxd",
  ]);
  const docsFiles = (manifest.graph?.docs ?? []).map((path) => {
    const file = files.find(
      ({ path: candidate }) => candidate === `assets/docs/${path}`,
    );
    return file === undefined
      ? undefined
      : { path, size: file.size, sha256: file.sha256 };
  });
  if (
    !Array.isArray(manifest.graph?.docs) ||
    manifest.graph.docs.length === 0 ||
    manifest.graph.docs.some(
      (path) =>
        !isPackagePath(path) ||
        forbiddenPath.test(path) ||
        path.endsWith(".map"),
    ) ||
    docsFiles.some((file) => file === undefined) ||
    canonicalArtifactHash(docsFiles) !==
      manifest.generatedCode[1].importManifestSha256 ||
    files.some(({ path }) => !graphFiles.has(path)) ||
    [...graphFiles].some((path) => !files.some((file) => file.path === path))
  )
    throw new Error(
      "Production package graph does not exactly cover its files.",
    );

  const migrations = await loadMigrationManifest();
  const expectedD1 = migrations.d1.map(
    ({ filename, sha256: hash, classification }) => ({
      filename,
      sha256: hash,
      classification,
    }),
  );
  if (
    manifest.migrations?.manifestVersion !== migrations.version ||
    manifest.migrations?.d1Directory !== migrations.d1Directory ||
    JSON.stringify(manifest.migrations?.d1) !== JSON.stringify(expectedD1) ||
    JSON.stringify(manifest.migrations?.durableObjects) !==
      JSON.stringify(migrations.durableObjects) ||
    JSON.stringify(manifest.durableObjects?.classes) !==
      JSON.stringify(
        migrations.durableObjects.flatMap(
          ({ newSqliteClasses }) => newSqliteClasses,
        ),
      )
  )
    throw new Error(
      "Production package migrations drifted from their authority.",
    );
  return manifest;
};
