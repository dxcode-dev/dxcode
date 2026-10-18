// The Cloudflare Containers Orb provider's deployment: the Orb Worker
// (apps/core/src/execution/cloudflare/orb-worker.ts), whose Durable Object
// class owns one container per Thread, bound to a container application with
// the `durable_object` scheduling policy and the standard Orb image built from
// deploy/orb/Dockerfile. Core binds the class across scripts as ORB_CONTAINER.
//
// `wrangler deploy` (pinned as the `wrangler-containers` alias, 4.147 or
// later: earlier releases do not know the `durable_object` policy) builds and
// pushes the image, waits until Cloudflare has prepared it, uploads the Worker
// with its image map, and creates the application. Docker must be running,
// with Buildx.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export const ORB_CONTAINER_CLASS = "OrbContainerObject";
export const ORB_IMAGE_NAME = "orb";
export const ORB_COMPATIBILITY_DATE = "2026-09-29";

/** Everything that changes what the Orb Worker or its image does. */
export const orbRecipeFiles = [
  "apps/core/src/execution/cloudflare/orb-worker.ts",
  "apps/core/src/execution/cloudflare/orb-container-object.ts",
  "apps/core/src/execution/cloudflare/orb-container.ts",
  "apps/core/src/logging.ts",
  "apps/dxd/assets/dx-terminal-stub.sh",
  "deploy/orb/Dockerfile",
  "deploy/orb/Dockerfile.dockerignore",
  "deploy/orb/dx-orb-init",
  "deploy/orb/dx-orb-hostname.sh",
  "deploy/orb/tmux.conf",
  "deploy/orb/desktop/start",
  "deploy/orb/desktop/stop",
  "deploy/orb/desktop/session",
  "deploy/orb/desktop/chromium",
  "deploy/orb/desktop/bin/ffmpeg",
  "deploy/orb/desktop/labwc/autostart",
  "deploy/orb/desktop/labwc/rc.xml",
  "deploy/orb/desktop/labwc/menu.xml",
  "deploy/orb/containers.mjs",
];

const wranglerVersion = (workspaceRoot) =>
  JSON.parse(
    readFileSync(
      resolve(workspaceRoot, "node_modules/wrangler-containers/package.json"),
      "utf8",
    ),
  ).version;

/** Redeploy the Orb Worker only when this changes. */
export const orbRecipeHash = (workspaceRoot) => {
  const hash = createHash("sha256");
  for (const file of orbRecipeFiles)
    hash
      .update(file)
      .update("\0")
      .update(readFileSync(resolve(workspaceRoot, file)))
      .update("\0");
  return hash.update(wranglerVersion(workspaceRoot)).digest("hex");
};

const orbWorkerConfig = ({ workerName, workspaceRoot }) => ({
  name: workerName,
  main: resolve(
    workspaceRoot,
    "apps/core/src/execution/cloudflare/orb-worker.ts",
  ),
  compatibility_date: ORB_COMPATIBILITY_DATE,
  compatibility_flags: ["nodejs_compat"],
  // The Orb Worker serves no HTTP; Core calls its objects by RPC.
  workers_dev: false,
  preview_urls: false,
  observability: { enabled: true, logs: { invocation_logs: true } },
  containers: [
    {
      class_name: ORB_CONTAINER_CLASS,
      scheduling_policy: "durable_object",
      images: {
        [ORB_IMAGE_NAME]: {
          dockerfile: resolve(workspaceRoot, "deploy/orb/Dockerfile"),
          build_context: workspaceRoot,
        },
      },
    },
  ],
  durable_objects: {
    bindings: [{ name: "ORB_CONTAINER", class_name: ORB_CONTAINER_CLASS }],
  },
  migrations: [
    { tag: "v1-orb-container", new_sqlite_classes: [ORB_CONTAINER_CLASS] },
  ],
});

const wrangler = (workspaceRoot, args, environment) => {
  const result = spawnSync(
    process.execPath,
    [
      resolve(
        workspaceRoot,
        "node_modules/wrangler-containers/bin/wrangler.js",
      ),
      ...args,
    ],
    {
      cwd: workspaceRoot,
      env: { ...environment, CI: "1", WRANGLER_SEND_METRICS: "false" },
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  return result;
};

/** The operator's own Docker configuration directory, before the deploy's. */
const operatorDockerDirectory = (environment) => {
  const home = environment.DX_OPERATOR_HOME ?? environment.HOME;
  return (
    environment.DX_OPERATOR_DOCKER_CONFIG ??
    environment.DOCKER_CONFIG ??
    (home === undefined ? undefined : join(home, ".docker"))
  );
};

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
};

/**
 * The environment Docker runs in to build and push the Orb image. With an
 * API token the deploy points HOME at a private directory so Cloudflare
 * credentials stay out of the operator's configuration, and Docker reads its
 * plugins, engine, and credential store from HOME. So Docker gets a
 * configuration of its own under `stateDirectory`:
 *
 * - Registry logins are stored in that file, never the OS keychain. Docker
 *   picks the platform credential helper only for a configuration without
 *   any `auths`, and a keychain under another HOME fails or asks to reset.
 * - The operator's CLI plugin directory stays visible, so Buildx (which
 *   Docker Desktop and OrbStack install there) builds the image.
 * - The operator's selected engine stays selected: their contexts and
 *   current context, unless DOCKER_HOST or DOCKER_CONTEXT already chooses.
 *
 * The operator's own configuration is only read.
 */
export const orbDockerEnvironment = ({
  environment = process.env,
  stateDirectory,
}) => {
  const operatorDocker = operatorDockerDirectory(environment);
  const operatorConfig =
    operatorDocker === undefined
      ? undefined
      : readJson(join(operatorDocker, "config.json"));
  const directory = resolve(stateDirectory, "docker");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const plugins =
    operatorDocker === undefined
      ? undefined
      : join(operatorDocker, "cli-plugins");
  const contexts =
    operatorDocker === undefined ? undefined : join(operatorDocker, "contexts");
  const ownContexts = join(directory, "contexts");
  rmSync(ownContexts, { recursive: true, force: true });
  const sharesContexts = contexts !== undefined && existsSync(contexts);
  if (sharesContexts) symlinkSync(contexts, ownContexts, "dir");
  const currentContext =
    typeof operatorConfig?.currentContext === "string" &&
    operatorConfig.currentContext !== "" &&
    sharesContexts
      ? operatorConfig.currentContext
      : undefined;
  const configPath = join(directory, "config.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(
      {
        // Any entry makes Docker store logins here instead of a helper.
        auths: { "registry.cloudflare.com": {} },
        ...(plugins !== undefined && existsSync(plugins)
          ? { cliPluginsExtraDirs: [plugins] }
          : {}),
        ...(currentContext === undefined ? {} : { currentContext }),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  chmodSync(configPath, 0o600);
  return {
    ...environment,
    DOCKER_CONFIG: directory,
    ...(operatorDocker === undefined
      ? {}
      : { DX_OPERATOR_DOCKER_CONFIG: operatorDocker }),
  };
};

const dockerDaemonRunning = (environment) => {
  const result = spawnSync(
    "docker",
    ["info", "--format", "{{.ServerVersion}}"],
    { env: environment, encoding: "utf8" },
  );
  return !result.error && result.status === 0;
};

/**
 * Checks, in the environment the build will use, that Docker can build the
 * Orb image: a running engine and Buildx, which `wrangler deploy` needs for
 * `docker build --load`. Run it before anything changes in Cloudflare.
 */
export const assertDockerReady = (
  environment = process.env,
  { daemon = dockerDaemonRunning } = {},
) => {
  if (!daemon(environment))
    throw new Error(
      "Cloudflare Containers needs a running Docker daemon to build the Orb image. Start Docker and retry.",
    );
  const buildx = spawnSync("docker", ["buildx", "version"], {
    env: environment,
    encoding: "utf8",
  });
  if (buildx.error || buildx.status !== 0)
    throw new Error(
      "Cloudflare Containers builds the Orb image with Docker Buildx, which this Docker does not have. Docker Desktop and OrbStack include it; otherwise install the docker-buildx plugin (for example `brew install docker-buildx`) and retry.",
    );
};

/** Builds the image and deploys the Orb Worker; idempotent. */
export const deployOrbWorker = ({
  workerName,
  workspaceRoot,
  stateDirectory,
  environment = process.env,
}) => {
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const dockerEnvironment = orbDockerEnvironment({
    environment,
    stateDirectory,
  });
  assertDockerReady(dockerEnvironment);
  const configPath = resolve(stateDirectory, "wrangler.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(orbWorkerConfig({ workerName, workspaceRoot }), null, 2)}\n`,
    { mode: 0o600 },
  );
  const result = wrangler(
    workspaceRoot,
    ["deploy", "--config", configPath],
    dockerEnvironment,
  );
  if (result.status !== 0)
    throw new Error(
      `Orb Worker deployment failed (wrangler exit ${result.status}).\n${result.stderr.slice(-4000)}`,
    );
  return { workerName };
};

const cloudflareApi = async ({ accountId, apiToken, fetch }, path, init) => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,
    {
      ...init,
      headers: { Authorization: `Bearer ${apiToken}`, ...init?.headers },
    },
  );
  if (init?.method === "DELETE" && response.status === 404) return undefined;
  const body = await response.json();
  if (!response.ok || body.success !== true)
    throw new Error(
      `Cloudflare request ${init?.method ?? "GET"} ${path} failed (${response.status}).`,
    );
  return body.result;
};

/**
 * Removes the Orb Worker: its container application (which stops every
 * container), the Worker script and its Durable Object namespace, and the
 * image repository with the snapshots stored beside the image.
 */
export const destroyOrbWorker = async ({
  workerName,
  accountId,
  apiToken,
  workspaceRoot,
  environment = process.env,
  fetch = globalThis.fetch,
  run = (args) => wrangler(workspaceRoot, args, environment),
}) => {
  const api = (path, init) =>
    cloudflareApi({ accountId, apiToken, fetch }, path, init);
  const namespaces =
    (await api("/workers/durable_objects/namespaces?per_page=1000")) ?? [];
  const namespace = namespaces.find(
    (candidate) =>
      candidate.script === workerName &&
      candidate.class === ORB_CONTAINER_CLASS,
  );
  if (namespace !== undefined) {
    const applications = (await api("/containers/applications")) ?? [];
    for (const application of applications.filter(
      (candidate) => candidate.durable_objects?.namespace_id === namespace.id,
    ))
      await api(`/containers/applications/${application.id}`, {
        method: "DELETE",
      });
  }
  await api(`/workers/scripts/${workerName}?force=true`, { method: "DELETE" });
  const listed = run(["containers", "images", "list", "--json"]);
  if (listed.status !== 0) return;
  const images = JSON.parse(listed.stdout || "[]");
  for (const image of images.filter(({ name }) =>
    name.startsWith(`${workerName}-`),
  ))
    for (const tag of image.tags ?? [])
      run(["containers", "images", "delete", `${image.name}:${tag}`, "-y"]);
};
