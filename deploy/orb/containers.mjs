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
import { spawn } from "node:child_process";
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
import { setTimeout as sleep } from "node:timers/promises";

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

// Output kept per stream: enough for the retry match, JSON listings, and
// the tail an error reports, without holding a whole image build in memory.
const OUTPUT_LIMIT = 1024 * 1024;

/**
 * Signals a command and everything it started: Wrangler runs Docker, and an
 * interrupted deploy must not leave either running.
 */
const signalCommand = (child, signal) => {
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // Already gone.
  }
};

/**
 * Runs a command without blocking the event loop, so other deploy steps'
 * timers stay accurate while a slow image build runs. Resolves with its exit
 * status and output; with `echo`, its output also streams to stderr. The
 * command runs in its own process group, which `signal` or this process
 * exiting terminates.
 */
const runCommand = (command, args, { cwd, env, echo = false, signal } = {}) =>
  new Promise((resolvePromise, reject) => {
    signal?.throwIfAborted();
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const terminate = () => signalCommand(child, "SIGTERM");
    const abort = () => {
      terminate();
      setTimeout(() => signalCommand(child, "SIGKILL"), 5_000).unref();
    };
    signal?.addEventListener("abort", abort, { once: true });
    process.once("exit", terminate);
    const settle = () => {
      signal?.removeEventListener("abort", abort);
      process.removeListener("exit", terminate);
    };
    const output = { stdout: "", stderr: "" };
    for (const stream of ["stdout", "stderr"]) {
      child[stream].setEncoding("utf8");
      child[stream].on("data", (chunk) => {
        output[stream] = `${output[stream]}${chunk}`.slice(-OUTPUT_LIMIT);
        if (echo) process.stderr.write(chunk);
      });
    }
    child.on("error", (error) => {
      settle();
      reject(error);
    });
    child.on("close", (status, exitSignal) => {
      settle();
      if (signal?.aborted) reject(signal.reason);
      else resolvePromise({ status, signal: exitSignal, ...output });
    });
  });

const wrangler = (
  workspaceRoot,
  args,
  environment,
  { echo = false, reportApiErrors = false, signal } = {},
) =>
  runCommand(
    process.execPath,
    [
      ...(reportApiErrors
        ? ["--import", resolve(import.meta.dirname, "wrangler-api-errors.mjs")]
        : []),
      resolve(
        workspaceRoot,
        "node_modules/wrangler-containers/bin/wrangler.js",
      ),
      ...args,
    ],
    {
      cwd: workspaceRoot,
      env: { ...environment, CI: "1", WRANGLER_SEND_METRICS: "false" },
      echo,
      signal,
    },
  );

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

const dockerSucceeds = (environment, args, signal) =>
  runCommand("docker", args, { env: environment, signal }).then(
    ({ status }) => status === 0,
    (error) => {
      if (signal?.aborted) throw error;
      return false;
    },
  );

const dockerDaemonRunning = (environment, signal) =>
  dockerSucceeds(
    environment,
    ["info", "--format", "{{.ServerVersion}}"],
    signal,
  );

/**
 * Checks, in the environment the build will use, that Docker can build the
 * Orb image: a running engine and Buildx, which `wrangler deploy` needs for
 * `docker build --load`. Run it before anything changes in Cloudflare.
 */
export const assertDockerReady = async (
  environment = process.env,
  { daemon = dockerDaemonRunning, signal } = {},
) => {
  if (!(await daemon(environment, signal)))
    throw new Error(
      "Cloudflare Containers needs a running Docker daemon to build the Orb image. Start Docker and retry.",
    );
  if (!(await dockerSucceeds(environment, ["buildx", "version"], signal)))
    throw new Error(
      "Cloudflare Containers builds the Orb image with Docker Buildx, which this Docker does not have. Docker Desktop and OrbStack include it; otherwise install the docker-buildx plugin (for example `brew install docker-buildx`) and retry.",
    );
};

// Wrangler's wording when the Worker version is live but the container
// application settings were not applied; it asks for the same deploy again.
const containerSettingsInterrupted =
  "could not finish applying its Durable Object-managed Container application settings";

// What the API-error hook (wrangler-api-errors.mjs) prints for each failed
// Cloudflare API call.
const apiAnswer = /Cloudflare API [A-Z]+ \S+ answered (\d{3})/g;

/**
 * Why a failed `wrangler deploy` of the Orb Worker is worth running again,
 * or undefined when another run would fail the same way. Cloudflare
 * refusing a request (a 4xx other than a timeout or rate limit, such as a
 * name with two consecutive dashes) is never retried, whatever else the run
 * printed. Retried: a 5xx, 408, or 429 answer; Cloudflare's internal error
 * 10500; a push to Cloudflare's registry that timed out or lost its
 * connection; and Wrangler asking for the same deploy again.
 */
export const transientDeployFailure = (output) => {
  const statuses = [...output.matchAll(apiAnswer)].map(([, status]) =>
    Number(status),
  );
  if (
    statuses.some(
      (status) =>
        status >= 400 && status < 500 && ![404, 408, 429].includes(status),
    )
  )
    return undefined;
  const transientStatus = statuses.find(
    (status) => status >= 500 || status === 408 || status === 429,
  );
  if (transientStatus !== undefined)
    return `Cloudflare answered ${transientStatus}`;
  if (/\[code: 10500\]|"code":\s*10500\b/.test(output))
    return "Cloudflare internal error 10500";
  if (
    output
      .split("\n")
      .some(
        (line) =>
          line.includes("registry.cloudflare.com") &&
          /timeout|connection reset|broken pipe|EOF|unexpected HTTP status: 5\d\d/i.test(
            line,
          ),
      )
  )
    return "the push to Cloudflare's registry timed out or lost its connection";
  if (output.includes(containerSettingsInterrupted))
    return "Wrangler did not finish the Orb Worker's container settings";
  return undefined;
};

/**
 * Runs `deploy` again, up to three runs in all, waiting longer before each,
 * while its failure is one `transientDeployFailure` recognizes. Any other
 * result returns. `wrangler deploy` is idempotent: a run after a failure
 * rebuilds from Docker's cache and finishes what the last one began.
 */
export const retryOrbWorkerDeploy = async ({
  deploy,
  wait = sleep,
  runs = 3,
  delayMilliseconds = 20_000,
}) => {
  for (let run = 1; ; run += 1) {
    const started = Date.now();
    const result = await deploy();
    process.stderr.write(
      `[OrbContainers] wrangler deploy run ${run} of ${runs} exited ${result.status ?? result.signal} after ${Math.round((Date.now() - started) / 1000)} s.\n`,
    );
    if (result.status === 0 || run === runs) return result;
    const reason = transientDeployFailure(`${result.stdout}${result.stderr}`);
    if (reason === undefined) return result;
    process.stderr.write(
      `[OrbContainers] Transient failure: ${reason}. Running the same deploy again in ${(delayMilliseconds * run) / 1000} s (${run + 1} of ${runs}).\n`,
    );
    await wait(delayMilliseconds * run);
  }
};

/**
 * The recorded failures DX_ORB_DEPLOY_FAULTS names (comma-separated), one
 * per run, replayed in place of that run's `wrangler deploy`. Only a preview
 * deploy accepts them.
 */
const injectedFaults = async (environment) => {
  const names = (environment.DX_ORB_DEPLOY_FAULTS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  if (names.length === 0) return [];
  if (environment.DX_DEPLOYMENT_ENVIRONMENT !== "preview")
    throw new Error(
      "DX_ORB_DEPLOY_FAULTS replays recorded failures only on a preview deploy.",
    );
  const { permanentDeployFailures, transientDeployFailures } = await import(
    "./recorded-deploy-failures.mjs"
  );
  const recorded = { ...transientDeployFailures, ...permanentDeployFailures };
  return names.map((name) => {
    if (!Object.hasOwn(recorded, name))
      throw new Error(
        `DX_ORB_DEPLOY_FAULTS: no recorded failure ${name}. Known: ${Object.keys(recorded).join(", ")}.`,
      );
    return { name, stderr: recorded[name] };
  });
};

/** Builds the image and deploys the Orb Worker; idempotent. */
export const deployOrbWorker = async ({
  workerName,
  workspaceRoot,
  stateDirectory,
  environment = process.env,
  signal,
  retryDelayMilliseconds,
}) => {
  const faults = await injectedFaults(environment);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
  const dockerEnvironment = orbDockerEnvironment({
    environment,
    stateDirectory,
  });
  await assertDockerReady(dockerEnvironment, { signal });
  const configPath = resolve(stateDirectory, "wrangler.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(orbWorkerConfig({ workerName, workspaceRoot }), null, 2)}\n`,
    { mode: 0o600 },
  );
  const result = await retryOrbWorkerDeploy({
    deploy: () => {
      const fault = faults.shift();
      if (fault === undefined)
        return wrangler(
          workspaceRoot,
          ["deploy", "--config", configPath],
          dockerEnvironment,
          { echo: true, reportApiErrors: true, signal },
        );
      process.stderr.write(
        `[OrbContainers] Replaying the recorded failure ${fault.name} (DX_ORB_DEPLOY_FAULTS) instead of running wrangler deploy:\n${fault.stderr}\n`,
      );
      return { status: 1, stdout: "", stderr: fault.stderr };
    },
    wait: (milliseconds) => sleep(milliseconds, undefined, { signal }),
    ...(retryDelayMilliseconds === undefined
      ? {}
      : { delayMilliseconds: retryDelayMilliseconds }),
  });
  if (result.status !== 0)
    throw new Error(
      `Orb Worker deployment failed (wrangler exit ${result.status ?? result.signal}).\n${result.stderr.slice(-4000)}`,
    );
  return { workerName };
};

const cloudflareApi = async (
  { accountId, apiToken, fetch },
  path,
  init,
  { missing = init?.method === "DELETE" } = {},
) => {
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${accountId}${path}`,
    {
      ...init,
      headers: { Authorization: `Bearer ${apiToken}`, ...init?.headers },
    },
  );
  if (missing && response.status === 404) return undefined;
  const body = await response.json();
  if (!response.ok || body.success !== true)
    throw new Error(
      `Cloudflare request ${init?.method ?? "GET"} ${path} failed (${response.status}).`,
    );
  return body.result;
};

/**
 * Whether the Orb Worker script exists. A create that Wrangler interrupted
 * after uploading the Worker leaves it without recorded attributes; this lets
 * a destroy still find and remove it.
 */
export const orbWorkerExists = async ({
  workerName,
  accountId,
  apiToken,
  fetch = globalThis.fetch,
}) =>
  (await cloudflareApi(
    { accountId, apiToken, fetch },
    `/workers/scripts/${workerName}/settings`,
    undefined,
    { missing: true },
  )) !== undefined;

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
  signal,
  run = (args) => wrangler(workspaceRoot, args, environment, { signal }),
}) => {
  const api = (path, init) =>
    cloudflareApi({ accountId, apiToken, fetch }, path, { ...init, signal });
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
  const listed = await run(["containers", "images", "list", "--json"]);
  if (listed.status !== 0) return;
  const images = JSON.parse(listed.stdout || "[]");
  for (const image of images.filter(({ name }) =>
    name.startsWith(`${workerName}-`),
  ))
    for (const tag of image.tags ?? [])
      await run([
        "containers",
        "images",
        "delete",
        `${image.name}:${tag}`,
        "-y",
      ]);
};
