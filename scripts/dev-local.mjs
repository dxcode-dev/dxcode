import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { LOCAL_DEV_HOST, selectLocalDevPorts } from "./local-dev-ports.mjs";
import {
  localDevVarValue,
  localRunnerProfileCatalog,
} from "./local-runner-profile.mjs";
import {
  createLocalRuntimeServer,
  createLocalRuntimeToken,
  localProcessEnvironment,
} from "./local-runtime.mjs";
import {
  loadMigrationManifest,
  sourceControlSchemaVersion,
} from "./migration-manifest.mjs";
import {
  setupLocalEnvironment,
  synchronizeLocalGitHubAppOrigin,
} from "./setup-local-env.mjs";

const workspaceRoot = resolve(import.meta.dirname, "..");
const devVarsPath = resolve(workspaceRoot, "apps/core/.dev.vars");
const localStateRoot = resolve(workspaceRoot, ".dx/local");
const pnpmCli = process.env.npm_execpath;
const modelPreview = process.argv.includes("--model-preview");
const uiOnly = process.argv.includes("--ui-only");
if (uiOnly && modelPreview) {
  throw new Error("--ui-only cannot be combined with --model-preview.");
}

const migrationManifest = await loadMigrationManifest();
setupLocalEnvironment(workspaceRoot);

if (!existsSync(devVarsPath)) {
  console.error(
    "Missing apps/core/.dev.vars. Copy apps/core/.dev.vars.example and add your local credentials.",
  );
  process.exit(1);
}
if (pnpmCli === undefined) {
  console.error("Run this command through pnpm: pnpm dev");
  process.exit(1);
}

process.loadEnvFile(devVarsPath);

const required = [
  "BETTER_AUTH_SECRET",
  "DX_LOCAL_AUTH_NAME",
  "DX_LOCAL_AUTH_EMAIL",
  "DX_LOCAL_AUTH_PASSWORD",
];
const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error(
    `Missing local development configuration: ${missing.join(", ")}`,
  );
  process.exit(1);
}

const isMainWorktree = () => {
  const commonDirectory = execFileSync(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    { cwd: workspaceRoot, encoding: "utf8" },
  ).trim();
  return resolve(commonDirectory, "..") === workspaceRoot;
};

const ports = await selectLocalDevPorts(workspaceRoot, isMainWorktree());
const webOrigin = `http://${LOCAL_DEV_HOST}:${ports.web}`;
const coreOrigin = `http://${LOCAL_DEV_HOST}:${ports.core}`;
const localRuntimeOrigin = `http://${LOCAL_DEV_HOST}:${ports.localRuntime}`;
process.env.DX_INTEGRATION_GITHUB_APP = synchronizeLocalGitHubAppOrigin(
  workspaceRoot,
  webOrigin,
);

if (process.argv.includes("--print-config")) {
  console.log(`Web:  ${webOrigin}`);
  console.log(`Core: ${coreOrigin}`);
  console.log(`Local login: ${process.env.DX_LOCAL_AUTH_EMAIL}`);
  process.exit(0);
}

console.log(
  `${modelPreview ? "Local model preview" : "Local dx"} starting at ${webOrigin} (Core: ${coreOrigin})`,
);

let localRuntimeServer;
const runtimeToken = modelPreview
  ? "model-preview-no-workspace"
  : createLocalRuntimeToken();
mkdirSync(localStateRoot, { recursive: true, mode: 0o700 });
if (!modelPreview && !uiOnly) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    console.error("Local dxd requires a Linux x64 host.");
    process.exit(1);
  }
  const manifest = resolve(workspaceRoot, "apps/dxd/Cargo.toml");
  const build = spawnSync(
    "cargo",
    ["build", "--locked", "--manifest-path", manifest],
    {
      cwd: workspaceRoot,
      stdio: "inherit",
    },
  );
  if (build.status !== 0) process.exit(build.status ?? 1);
  const dxdBinary = resolve(workspaceRoot, "apps/dxd/target/debug/dxd");
  localRuntimeServer = createLocalRuntimeServer({
    workspaceRoot,
    stateRoot: localStateRoot,
    token: runtimeToken,
    dxdBinary,
  });
  await new Promise((resolveListening, reject) => {
    localRuntimeServer.once("error", reject);
    localRuntimeServer.listen(
      ports.localRuntime,
      "127.0.0.1",
      resolveListening,
    );
  });
  console.log("Checkout-owned local workspace runtime and dxd are ready.");
} else if (modelPreview) {
  console.log("Workers AI enabled; sandbox and workspace tools disabled.");
} else {
  console.log(
    "Local UI and auth enabled; dxd and workspace tools unavailable.",
  );
}

let devVars = readFileSync(devVarsPath, "utf8");
process.env.DX_LOCAL_MODEL_PREVIEW = modelPreview ? "1" : "0";
const generatedBindings = {
  DX_ENV: "local",
  DX_RUNTIME_MODE: "local",
  DX_AUTH_URL: webOrigin,
  DX_AUTH_TRUSTED_ORIGINS: webOrigin,
  DX_RUNNER_PROFILE_CATALOG: localRunnerProfileCatalog(),
  DX_SOURCE_CONTROL_SCHEMA_VERSION:
    sourceControlSchemaVersion(migrationManifest),
  DX_DXD_PUBLIC_URL: coreOrigin,
  DX_LOCAL_RUNTIME_URL: localRuntimeOrigin,
  DX_LOCAL_RUNTIME_TOKEN: runtimeToken,
  DX_WORKLOAD_IDENTITY_ISSUER: `${coreOrigin}/api/workload-identity`,
};
for (const [name, value] of Object.entries(generatedBindings)) {
  const line = `${name}=${localDevVarValue(value)}`;
  const pattern = new RegExp(`^${name}=.*$`, "m");
  devVars = pattern.test(devVars)
    ? devVars.replace(pattern, line)
    : `${devVars.trimEnd()}\n${line}\n`;
  process.env[name] = value;
}
for (const name of [
  "E2B_API_KEY",
  "DX_INTEGRATION_BITBUCKET_OAUTH",
  "DX_BITBUCKET_GIT_TOKEN",
  "DX_BITBUCKET_GIT_ORIGIN",
  "DX_BITBUCKET_GIT_PATH",
  "DX_E2B_TEMPLATE",
  "DX_E2B_TIMEOUT_MS",
  "DX_DXD_RELEASE_URL",
  "DX_DXD_RELEASE_SHA256",
  "DX_MODEL_ENDPOINT_ALLOWLIST",
  "DX_MODEL_DEPLOYMENT_PROVIDERS",
]) {
  devVars = devVars.replace(new RegExp(`^${name}=.*\n?`, "m"), "");
}
writeFileSync(devVarsPath, devVars, { mode: 0o600 });
const coreEnvironment = localProcessEnvironment(process.env, {
  DX_AUTH_URL: webOrigin,
  DX_AUTH_TRUSTED_ORIGINS: webOrigin,
  X_LOCAL_OBSERVABILITY: "false",
  ...generatedBindings,
});
for (const name of [
  "DX_LOCAL_AUTH_NAME",
  "DX_LOCAL_AUTH_EMAIL",
  "DX_LOCAL_AUTH_PASSWORD",
]) {
  delete coreEnvironment[name];
}

const pnpm = (...args) => [process.execPath, [pnpmCli, ...args]];
const [migrationCommand, migrationArgs] = pnpm(
  "--filter",
  "@dx/core",
  "exec",
  "wrangler",
  "d1",
  "migrations",
  "apply",
  "DB",
  "--local",
  "--persist-to",
  resolve(localStateRoot, "cloudflare"),
);
const migration = spawnSync(migrationCommand, migrationArgs, {
  cwd: workspaceRoot,
  env: { ...coreEnvironment, CI: "1" },
  stdio: "inherit",
});
if (migration.status !== 0) process.exit(migration.status ?? 1);

const webEnvironment = localProcessEnvironment(process.env, {
  DX_ENV: "local",
  DX_DEV_REQUEST_ORIGIN: webOrigin,
  DX_WEB_API_TARGET: coreOrigin,
});
for (const name of [
  ...required,
  "DX_CONFIG_ENCRYPTION_KEYS",
  "DX_INTEGRATION_GITHUB_APP",
])
  delete webEnvironment[name];

const workspaces = [
  {
    name: "@dx/core",
    environment: coreEnvironment,
    args: ["--host", "127.0.0.1", "--port", String(ports.core), "--strictPort"],
  },
  {
    name: "@dx/web",
    environment: webEnvironment,
    args: [
      "--host",
      LOCAL_DEV_HOST,
      "--port",
      String(ports.web),
      "--strictPort",
    ],
  },
];
const children = workspaces.map(({ name, environment, args = [] }) => {
  const [command, pnpmArgs] = pnpm("--filter", name, "dev", ...args);
  return spawn(command, pnpmArgs, {
    cwd: workspaceRoot,
    env: environment,
    stdio: "inherit",
  });
});

let shuttingDown = false;
let childFailure;
const stop = (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill(signal);
  localRuntimeServer?.close();
  localRuntimeServer?.closeAllConnections();
};

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

for (const child of children) {
  child.on("exit", (code, signal) => {
    if (!shuttingDown && code !== 0) {
      childFailure = new Error(
        `A local development server exited before startup completed (${code ?? signal ?? "unknown"}).`,
      );
    }
    stop(signal ?? "SIGTERM");
    process.exitCode = code ?? (signal === null ? 1 : 0);
  });
}

const authRequest = (path) =>
  fetch(`${coreOrigin}/api/auth/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: webOrigin },
    body: JSON.stringify({
      name: process.env.DX_LOCAL_AUTH_NAME,
      email: process.env.DX_LOCAL_AUTH_EMAIL,
      password: process.env.DX_LOCAL_AUTH_PASSWORD,
    }),
  });

const ensureLocalAccount = async () => {
  let lastFailure;
  for (let attempt = 0; attempt < 480; attempt += 1) {
    if (childFailure !== undefined) throw childFailure;
    try {
      const signUp = await authRequest("sign-up/email");
      if (signUp.ok) return "created";
      if (signUp.status === 429) {
        lastFailure = new Error("Local account setup is rate limited.");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
        continue;
      }
      if (signUp.status !== 400 && signUp.status !== 422) {
        throw new Error(`Local account setup was rejected (${signUp.status}).`);
      }
      const signIn = await authRequest("sign-in/email");
      if (signIn.ok) return "ready";
      if (signIn.status === 429) {
        lastFailure = new Error("Local account verification is rate limited.");
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
        continue;
      }
      throw new Error(
        `The configured local account could not sign in (${signIn.status}).`,
      );
    } catch (cause) {
      if (cause instanceof Error && !cause.message.includes("fetch failed")) {
        throw cause;
      }
      lastFailure = cause;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw lastFailure ?? new Error("Local account setup failed.");
};

try {
  const accountStatus = await ensureLocalAccount();
  console.log(`\nLocal dx is available at ${webOrigin}`);
  console.log(
    `Local login ${process.env.DX_LOCAL_AUTH_EMAIL} is ${accountStatus}; its stable password is in apps/core/.dev.vars.\n`,
  );
} catch (cause) {
  stop("SIGTERM");
  throw cause;
}
