import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  assertProductionPackageOutput,
  createProductionPackage,
  productionBuildEnvironment,
  validateProductionBindingConfiguration,
  validateProductionPackage,
} from "./production-package.mjs";
import { smokeProductionPackage } from "./smoke-production-package.mjs";

const workspaceRoot = resolve(import.meta.dirname, "..");
const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith("--") || value === undefined)
    throw new Error("Production package arguments must be --name value pairs.");
  values.set(name.slice(2), value);
}
const required = (name) => {
  const value = values.get(name)?.trim();
  if (!value) throw new Error(`--${name} is required.`);
  return value;
};
const outputRoot = assertProductionPackageOutput({
  repositoryRoot: workspaceRoot,
  outputRoot: resolve(workspaceRoot, required("output")),
});
for (const application of ["core", "docs", "web"]) {
  for (const filename of [
    ".env",
    ".env.local",
    ".env.dx-production",
    ".env.dx-production.local",
  ]) {
    if (existsSync(resolve(workspaceRoot, "apps", application, filename)))
      throw new Error(
        `Production builds forbid apps/${application}/${filename}.`,
      );
  }
}
const productionConfigRoot = mkdtempSync(
  resolve(tmpdir(), "dx-production-wrangler-"),
);
const cleanEnvironment = {
  ...productionBuildEnvironment(process.env),
  HOME: productionConfigRoot,
};
const run = (filter, environment = cleanEnvironment) =>
  execFileSync(
    "pnpm",
    ["--filter", filter, "exec", "vite", "build", "--mode", "dx-production"],
    { cwd: workspaceRoot, env: environment, stdio: "inherit" },
  );

try {
  const authoredConfig = JSON.parse(
    readFileSync(resolve(workspaceRoot, "apps/core/wrangler.jsonc"), "utf8"),
  );
  for (const database of authoredConfig.d1_databases ?? []) {
    if (database.migrations_dir !== undefined)
      database.migrations_dir = resolve(
        workspaceRoot,
        "apps/core",
        database.migrations_dir,
      );
  }
  const productionConfigPath = resolve(productionConfigRoot, "wrangler.json");
  writeFileSync(productionConfigPath, JSON.stringify(authoredConfig));

  run("@dx/web");
  execFileSync("pnpm", ["--filter", "@dx/docs", "exec", "astro", "build"], {
    cwd: workspaceRoot,
    env: cleanEnvironment,
    stdio: "inherit",
  });
  run("@dx/core", {
    ...cleanEnvironment,
    CLOUDFLARE_VITE_WRANGLER_CONFIG_PATH: productionConfigPath,
  });
  execFileSync(
    process.execPath,
    [resolve(workspaceRoot, "apps/core/scripts/validate-cloudflare-build.mjs")],
    {
      cwd: resolve(workspaceRoot, "apps/core"),
      env: cleanEnvironment,
      stdio: "inherit",
    },
  );
  validateProductionBindingConfiguration({
    authoredConfig: JSON.parse(
      readFileSync(resolve(workspaceRoot, "apps/core/wrangler.jsonc"), "utf8"),
    ),
    generatedConfig: JSON.parse(
      readFileSync(
        resolve(workspaceRoot, "apps/core/dist/dx_core/wrangler.json"),
        "utf8",
      ),
    ),
  });
  rmSync(outputRoot, { recursive: true, force: true });
  const manifest = await createProductionPackage({
    coreBuildRoot: resolve(workspaceRoot, "apps/core/dist/dx_core"),
    docsBuildRoot: resolve(workspaceRoot, "apps/docs/dist"),
    deploymentLabel: required("deployment-label"),
    dxdBinary: values.get("dxd-binary"),
    dxdSha256: required("dxd-sha256"),
    outputRoot,
    revision: required("revision"),
    stage: required("stage"),
    target: required("target"),
    webBuildRoot: resolve(workspaceRoot, "apps/web/dist"),
  });
  await validateProductionPackage(outputRoot);
  await smokeProductionPackage(outputRoot);
  console.log(
    `Production package validated: ${manifest.artifact.sha256} (${manifest.files.length} files).`,
  );
} finally {
  rmSync(productionConfigRoot, { recursive: true, force: true });
}
