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
  "deploy/orb/dx-orb-open-files.sh",
  "deploy/orb/tmux.conf",
  "deploy/orb/desktop/start",
  "deploy/orb/desktop/stop",
  "deploy/orb/desktop/session",
  "deploy/orb/desktop/chromium",
  "deploy/orb/desktop/resume",
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

const orbWorkerConfig = ({ workerName, workspaceRoot, image }) => ({
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
        [ORB_IMAGE_NAME]:
          image === undefined
            ? {
                dockerfile: resolve(workspaceRoot, "deploy/orb/Dockerfile"),
                build_context: workspaceRoot,
              }
            : { image },
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
const runCommand = (
  command,
  args,
  { cwd, env, echo = false, signal, input } = {},
) =>
  new Promise((resolvePromise, reject) => {
    signal?.throwIfAborted();
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (input !== undefined) child.stdin.end(input);
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

/**
 * The registry repository branch previews share Orb images in. Never named
 * `<Orb Worker name>-…`, so a stage's destroy leaves it alone; Threads'
 * snapshots stored beside an image here expire with Cloudflare's 30-day TTL,
 * and `pruneSharedPreviewOrbImages` removes images no stage pins.
 */
export const PREVIEW_ORB_IMAGE_REPOSITORY = "dx-preview-orb-image";

// `<recipe hash>-<push time in base 36>`
const SHARED_TAG = /^([a-f0-9]{32})-([a-z0-9]+)$/;

/**
 * Every file the Orb image build reads: the Dockerfile (which pins the base
 * image by digest and every download by checksum), its ignore file, and each
 * COPY source. Throws on an instruction whose inputs this cannot see (ADD,
 * ARG, ONBUILD, a second FROM, COPY --from, a wildcard), so a preview never
 * reuses an image such a change would alter; that preview builds its own.
 */
export const orbImageFiles = (workspaceRoot) => {
  const dockerfile = "deploy/orb/Dockerfile";
  const instructions = readFileSync(resolve(workspaceRoot, dockerfile), "utf8")
    .replace(/\\\r?\n/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  const sources = [];
  let froms = 0;
  for (const line of instructions) {
    const [instruction, ...words] = line.split(/\s+/);
    const name = instruction.toUpperCase();
    if (name === "FROM") froms += 1;
    if (["ADD", "ARG", "ONBUILD"].includes(name) || froms > 1)
      throw new Error(`The Orb image recipe cannot hash "${line}".`);
    if (name !== "COPY") continue;
    if (words.some((word) => word.startsWith("--from")))
      throw new Error(`The Orb image recipe cannot hash "${line}".`);
    for (const source of words
      .slice(0, -1)
      .filter((word) => !word.startsWith("--"))) {
      if (/[*?[]/.test(source))
        throw new Error(`The Orb image recipe cannot hash "${line}".`);
      sources.push(source);
    }
  }
  return [dockerfile, "deploy/orb/Dockerfile.dockerignore", ...sources];
};

// How the image is built, beside its files: a change here is a new image.
const ORB_IMAGE_BUILD = ["--platform", "linux/amd64", "--provenance=false"];

/**
 * Changes exactly when the Orb image would. A COPY of a directory fails here
 * (it reads files only), like the other unhashable instructions.
 */
export const orbImageRecipeHash = (workspaceRoot) => {
  const hash = createHash("sha256").update(ORB_IMAGE_BUILD.join(" "));
  for (const file of orbImageFiles(workspaceRoot))
    hash
      .update("\0")
      .update(file)
      .update("\0")
      .update(readFileSync(resolve(workspaceRoot, file)));
  return hash.digest("hex");
};

/**
 * The account's Cloudflare registry through its HTTP API, with credentials
 * Wrangler issues: the shared repository's tags, and a tag's digest.
 */
const previewImageRegistry = async ({
  workspaceRoot,
  environment,
  signal,
  fetch = globalThis.fetch,
}) => {
  const issued = await wrangler(
    workspaceRoot,
    [
      "containers",
      "registries",
      "credentials",
      "registry.cloudflare.com",
      "--push",
      "--pull",
      "--json",
      "--expiration-minutes",
      "60",
    ],
    environment,
    { signal },
  );
  if (issued.status !== 0)
    throw new Error(
      `Registry credentials failed (exit ${issued.status ?? issued.signal}).\n${issued.stderr.slice(-2000)}`,
    );
  const credentials = JSON.parse(issued.stdout);
  const path = `${credentials.account_id}/${PREVIEW_ORB_IMAGE_REPOSITORY}`;
  const request = (suffix, init) =>
    fetch(`https://${credentials.registry_host}/v2/${path}/${suffix}`, {
      ...init,
      signal,
      headers: {
        Authorization: `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`,
        Accept:
          "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json",
      },
    });
  return {
    credentials,
    repository: `${credentials.registry_host}/${path}`,
    /** The shared tags, newest first. */
    tags: async () => {
      const response = await request("tags/list");
      if (response.status === 404) return [];
      if (!response.ok)
        throw new Error(`Listing ${path} failed (${response.status}).`);
      return ((await response.json()).tags ?? [])
        .filter((tag) => SHARED_TAG.test(tag))
        .sort((a, b) => b.localeCompare(a));
    },
    digest: async (tag) => {
      const response = await request(`manifests/${tag}`, { method: "HEAD" });
      if (response.status === 404) return undefined;
      const digest = response.headers.get("docker-content-digest") ?? "";
      if (!response.ok || !/^sha256:[a-f0-9]{64}$/.test(digest))
        throw new Error(`Reading ${path}:${tag} failed (${response.status}).`);
      return digest;
    },
  };
};

/**
 * The digest-pinned Orb image every branch preview with this image recipe
 * shares. The first preview with a new recipe builds and pushes it, tagged
 * `<recipe hash>-<time>` so a concurrent push never untags another's
 * digest; every later stage pins the newest such digest, so it skips the
 * build, the push, and Cloudflare's preparation of a new image (about 4
 * minutes of a new stage's first deploy).
 */
export const sharedPreviewOrbImage = async ({
  workspaceRoot,
  environment,
  signal,
}) => {
  const recipe = orbImageRecipeHash(workspaceRoot).slice(0, 32);
  const registry = await previewImageRegistry({
    workspaceRoot,
    environment,
    signal,
  });
  for (const tag of (await registry.tags()).filter((tag) =>
    tag.startsWith(`${recipe}-`),
  )) {
    const digest = await registry.digest(tag);
    if (digest === undefined) continue;
    process.stderr.write(
      `[OrbContainers] Using the shared preview Orb image ${tag} (${digest}); no build or push.\n`,
    );
    return `${registry.repository}@${digest}`;
  }
  const docker = async (description, args, options = {}) => {
    const result = await runCommand("docker", args, {
      env: environment,
      signal,
      ...options,
    });
    if (result.status !== 0)
      throw new Error(
        `${description} failed (exit ${result.status ?? result.signal}).\n${result.stderr.slice(-2000)}`,
      );
  };
  const { credentials } = registry;
  await docker(
    "Registry login",
    [
      "login",
      "--username",
      credentials.username,
      "--password-stdin",
      credentials.registry_host,
    ],
    { input: credentials.password },
  );
  const started = Date.now();
  const tag = `${recipe}-${started.toString(36)}`;
  const reference = `${registry.repository}:${tag}`;
  process.stderr.write(
    `[OrbContainers] No shared preview Orb image for recipe ${recipe}; building and pushing ${reference}.\n`,
  );
  await docker(
    "Orb image build",
    [
      "build",
      "--load",
      ...ORB_IMAGE_BUILD,
      "-f",
      resolve(workspaceRoot, "deploy/orb/Dockerfile"),
      "-t",
      reference,
      workspaceRoot,
    ],
    { echo: true },
  );
  await docker("Orb image push", ["push", reference], { echo: true });
  const digest = await registry.digest(tag);
  if (digest === undefined)
    throw new Error(`The pushed image ${reference} is not in the registry.`);
  process.stderr.write(
    `[OrbContainers] Built and pushed the shared preview Orb image ${tag} (${digest}) in ${Math.round((Date.now() - started) / 1000)} s.\n`,
  );
  return `${registry.repository}@${digest}`;
};

/**
 * Deletes shared preview Orb images that no Worker's active deployment pins
 * and that were pushed over `minimumAgeDays` ago, so a deploy that just chose
 * one has long since pinned it. Reads every Worker in the account; any failed
 * read deletes nothing.
 */
export const pruneSharedPreviewOrbImages = async ({
  workspaceRoot,
  accountId,
  apiToken,
  environment = process.env,
  dryRun = false,
  minimumAgeDays = 7,
  now = Date.now(),
  fetch = globalThis.fetch,
}) => {
  const api = (path) =>
    cloudflareApi({ accountId, apiToken, fetch }, path, undefined, {
      missing: true,
    });
  const registry = await previewImageRegistry({
    workspaceRoot,
    environment,
    fetch,
  });
  const pinned = new Set();
  const scripts = [...((await api("/workers/scripts")) ?? [])];
  const readScript = async ({ id: script }) => {
    const name = encodeURIComponent(script);
    const deployment = (await api(`/workers/scripts/${name}/deployments`))
      ?.deployments?.[0];
    for (const { version_id: version } of deployment?.versions ?? []) {
      const detail = await api(`/workers/scripts/${name}/versions/${version}`);
      for (const container of detail?.resources?.script_runtime?.containers ??
        [])
        for (const image of Object.values(container.images ?? {}))
          if (typeof image === "string") pinned.add(image);
    }
  };
  // Eight reads at a time; any failure fails the prune before it deletes.
  await Promise.all(
    Array.from({ length: 8 }, async () => {
      for (let script = scripts.shift(); script; script = scripts.shift())
        await readScript(script);
    }),
  );
  const removed = [];
  const kept = [];
  for (const tag of await registry.tags()) {
    const pushed = Number.parseInt(SHARED_TAG.exec(tag)[2], 36);
    const digest = await registry.digest(tag);
    if (digest === undefined) continue;
    if (
      pinned.has(`${registry.repository}@${digest}`) ||
      !(now - pushed > minimumAgeDays * 24 * 60 * 60 * 1000)
    ) {
      kept.push(tag);
      continue;
    }
    removed.push(tag);
    if (dryRun) continue;
    const deleted = await wrangler(
      workspaceRoot,
      [
        "containers",
        "images",
        "delete",
        `${PREVIEW_ORB_IMAGE_REPOSITORY}:${tag}`,
        "-y",
      ],
      environment,
    );
    if (deleted.status !== 0)
      throw new Error(
        `Deleting ${tag} failed (exit ${deleted.status ?? deleted.signal}).\n${deleted.stderr.slice(-2000)}`,
      );
  }
  return { removed, kept };
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
  // A preview whose shared image fails builds its own, as before.
  let image;
  if (environment.DX_DEPLOYMENT_ENVIRONMENT === "preview")
    try {
      image = await sharedPreviewOrbImage({
        workspaceRoot,
        environment: dockerEnvironment,
        signal,
      });
    } catch (error) {
      signal?.throwIfAborted();
      process.stderr.write(
        `[OrbContainers] The shared preview Orb image is unavailable, so Wrangler builds this stage's own: ${error.message}\n`,
      );
    }
  const configPath = resolve(stateDirectory, "wrangler.json");
  writeFileSync(
    configPath,
    `${JSON.stringify(orbWorkerConfig({ workerName, workspaceRoot, image }), null, 2)}\n`,
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
  // Only this Worker's images: the account's whole list (every stage's
  // snapshot tags) outgrows the 1 MB of output a command keeps, and a cut
  // list is not JSON. Wrangler matches the filter against the registry's
  // own name, `<account>/<image>`, before it drops the account.
  const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const listed = await run([
    "containers",
    "images",
    "list",
    "--json",
    "--filter",
    `^(?:${literal(accountId)}/)?${literal(workerName)}-`,
  ]);
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
