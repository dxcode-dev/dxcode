import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";

const THREAD_ID =
  /^thr_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const GUEST_HOME = "/home/user";
const GUEST_WORKSPACE = `${GUEST_HOME}/workspace/repo`;

const within = (root, candidate) => {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
};

export const assertLocalStateRoot = (workspaceRoot, stateRoot) => {
  const expected = resolve(workspaceRoot, ".dx/local");
  if (
    resolve(stateRoot) !== expected ||
    !within(resolve(workspaceRoot), expected)
  ) {
    throw new Error(
      "Local state root must be the current checkout's exact .dx/local path.",
    );
  }
  return expected;
};

export const resetLocalState = (workspaceRoot) => {
  const stateRoot = assertLocalStateRoot(
    workspaceRoot,
    resolve(workspaceRoot, ".dx/local"),
  );
  if (
    basename(stateRoot) !== "local" ||
    basename(dirname(stateRoot)) !== ".dx"
  ) {
    throw new Error("Refusing to reset an unexpected local state path.");
  }
  rmSync(stateRoot, { recursive: true, force: true });
  return stateRoot;
};

export const createLocalRuntimeToken = () =>
  randomBytes(32).toString("base64url");

export const localProcessEnvironment = (inherited, overrides = {}) => {
  const environment = { ...inherited, ...overrides };
  for (const name of Object.keys(environment)) {
    if (
      name.endsWith("_API_KEY") ||
      name === "GH_TOKEN" ||
      name === "GITHUB_TOKEN" ||
      name === "COPILOT_GITHUB_TOKEN" ||
      name === "HF_TOKEN" ||
      name === "AWS_ACCESS_KEY_ID" ||
      name === "AWS_SECRET_ACCESS_KEY" ||
      name === "AWS_SESSION_TOKEN" ||
      name === "GOOGLE_APPLICATION_CREDENTIALS" ||
      name.startsWith("CLOUDFLARE_") ||
      name.startsWith("CF_") ||
      name.startsWith("DX_E2B_") ||
      name === "DX_INTEGRATION_BITBUCKET_OAUTH" ||
      name.startsWith("DX_BITBUCKET_GIT_") ||
      name.startsWith("DX_MODEL_") ||
      name.startsWith("DX_DXD_RELEASE_") ||
      name.startsWith("DX_ALCHEMY_") ||
      name.startsWith("ALCHEMY_") ||
      name.includes("WORKERS_AI") ||
      name.includes("MODEL_API_KEY") ||
      name === "ALCHEMY_STAGE" ||
      name === "STAGE"
    )
      delete environment[name];
  }
  return environment;
};

const safeThread = (value) => {
  if (!THREAD_ID.test(value)) throw new Error("Invalid Thread identity.");
  return value;
};

const localDaemonEndpoint = (value, threadId) => {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== "ws:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    (endpoint.pathname !== `/v1/dxd/${threadId}` &&
      endpoint.pathname !== `/v1/threads/${threadId}/dxd`) ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  )
    throw new Error("Local dxd endpoint is unavailable.");
  return endpoint.toString();
};

const workspacePaths = (stateRoot, threadId) => {
  const root = resolve(stateRoot, "workspaces", safeThread(threadId));
  return {
    root,
    home: join(root, "home"),
    workspace: join(root, "home/workspace/repo"),
    daemon: join(root, "daemon"),
  };
};

export const localWorkloadIdentitySocketPath = (workspaceRoot, threadId) => {
  const identity = createHash("sha256")
    .update(`${resolve(workspaceRoot)}\0${safeThread(threadId)}`)
    .digest("hex")
    .slice(0, 32);
  return join(
    tmpdir(),
    `dx-${process.getuid?.() ?? "user"}-wi`,
    `${identity}.sock`,
  );
};

export const localSourceWorkspaceConfiguration = (
  workspaceRoot,
  stateRoot,
  threadId,
  fixtureRemote = resolve(stateRoot, "source-fixture.git"),
) => {
  const paths = workspacePaths(
    assertLocalStateRoot(workspaceRoot, stateRoot),
    threadId,
  );
  const sourceState = join(paths.home, ".local/state/dx");
  return {
    root: paths.workspace,
    state: join(sourceState, "source-control-v1.json"),
    claim: join(sourceState, "source-control-claim-v1.json"),
    logDirectory: join(paths.home, ".cache/dx/logs"),
    helper: join(paths.home, ".local/libexec/dx-git-credential"),
    templateDirectory: join(sourceState, "empty-git-template"),
    home: paths.home,
    workspaceParent: join(paths.home, "workspace"),
    gitHome: join(sourceState, "git-home"),
    fixtureRemote,
  };
};

const LOCAL_SOURCE_FIXTURE_README = `# dx local source fixture

This repository exists only inside the checkout-owned local runtime.
`;

export const ensureLocalSourceFixture = (workspaceRoot, stateRoot) => {
  const exactStateRoot = assertLocalStateRoot(workspaceRoot, stateRoot);
  const fixture = resolve(exactStateRoot, "source-fixture.git");
  mkdirSync(exactStateRoot, { recursive: true, mode: 0o700 });
  const git = (args, input) => {
    const result = spawnSync("git", args, {
      cwd: workspaceRoot,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        HOME: exactStateRoot,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        GIT_AUTHOR_NAME: "dx local fixture",
        GIT_AUTHOR_EMAIL: "local-fixture@dx.invalid",
        GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
        GIT_COMMITTER_NAME: "dx local fixture",
        GIT_COMMITTER_EMAIL: "local-fixture@dx.invalid",
        GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
      },
      encoding: "utf8",
      input,
    });
    if (result.status !== 0)
      throw new Error("Local source fixture repository is unavailable.");
    return result.stdout.trim();
  };
  if (!existsSync(fixture)) {
    git(["init", "--bare", "--initial-branch=main", fixture]);
    const blob = git(
      ["--git-dir", fixture, "hash-object", "-w", "--stdin"],
      LOCAL_SOURCE_FIXTURE_README,
    );
    const tree = git(
      ["--git-dir", fixture, "mktree"],
      `100644 blob ${blob}\tREADME.md\n`,
    );
    const commit = git(
      ["--git-dir", fixture, "commit-tree", tree],
      "Initialize the dx local source fixture.\n",
    );
    git(["--git-dir", fixture, "update-ref", "refs/heads/main", commit]);
  }
  const info = lstatSync(fixture);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Local source fixture repository is unavailable.");
  if (
    git(["--git-dir", fixture, "symbolic-ref", "HEAD"]) !== "refs/heads/main" ||
    git(["--git-dir", fixture, "show", "HEAD:README.md"]) !==
      LOCAL_SOURCE_FIXTURE_README.trimEnd()
  )
    throw new Error("Local source fixture repository is unavailable.");
  return fixture;
};

const ensureWorkspace = (
  paths,
  existingOnly,
  prepareSourceWorkspace = false,
) => {
  if (existingOnly && !existsSync(paths.workspace)) {
    throw Object.assign(new Error("Local Thread workspace does not exist."), {
      status: 404,
    });
  }
  mkdirSync(prepareSourceWorkspace ? paths.home : paths.workspace, {
    recursive: true,
    mode: 0o700,
  });
  chmodSync(paths.root, 0o700);
  chmodSync(paths.home, 0o700);
  return paths;
};

const removeDaemonConfig = (paths) => {
  if (!existsSync(paths.daemon)) return;
  const daemon = lstatSync(paths.daemon);
  if (!daemon.isDirectory() || daemon.isSymbolicLink())
    throw new Error("Invalid local daemon state directory.");
  const configPath = join(paths.daemon, "config.json");
  if (!existsSync(configPath)) return;
  const config = lstatSync(configPath);
  if (!config.isFile() || config.isSymbolicLink())
    throw new Error("Invalid local daemon configuration.");
  rmSync(configPath);
};

const guestPath = (paths, value, fallback = GUEST_WORKSPACE) => {
  const source = value ?? fallback;
  if (
    typeof source !== "string" ||
    (source !== GUEST_HOME && !source.startsWith(`${GUEST_HOME}/`))
  ) {
    throw new Error("Local workspace paths must be rooted at /home/user.");
  }
  const suffix = normalize(source.slice(GUEST_HOME.length)).replace(/^\/+/, "");
  const path = resolve(paths.home, suffix);
  if (!within(paths.home, path))
    throw new Error("Local workspace path escapes its Thread root.");
  let current = paths.home;
  for (const component of relative(paths.home, path)
    .split(sep)
    .filter(Boolean)) {
    current = join(current, component);
    if (!existsSync(current)) break;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("Local workspace paths cannot traverse symbolic links.");
    }
  }
  return path;
};

const translateCommand = (paths, command) => {
  if (
    typeof command !== "string" ||
    command.length === 0 ||
    command.length > 2 * 1024 * 1024
  ) {
    throw new Error("Invalid local workspace command.");
  }
  return command.replaceAll(GUEST_HOME, paths.home);
};

// Commands in the local workspace see the daemon binary on PATH, as the guest
// does, so `dxd changes-capture` and the Git helpers resolve identically.
let daemonBinaryDirectory;

const commandEnvironment = (paths, supplied = {}) => {
  const inheritedPath = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const environment = {
    HOME: paths.home,
    USER: process.env.USER ?? "user",
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? "user",
    SHELL: "/bin/bash",
    LANG: process.env.LANG ?? "C.UTF-8",
    PATH:
      daemonBinaryDirectory === undefined
        ? inheritedPath
        : `${daemonBinaryDirectory}:${inheritedPath}`,
    TERM: "xterm-256color",
  };
  for (const [name, value] of Object.entries(supplied)) {
    if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(name) || typeof value !== "string") {
      throw new Error("Invalid local workspace environment.");
    }
    environment[name] = value;
  }
  return environment;
};

const signalProcessGroup = (child, signal) => {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (cause) {
    if (cause?.code !== "ESRCH") throw cause;
  }
};

const runCommand = (paths, input, signal) =>
  new Promise((resolveCommand, rejectCommand) => {
    const timeoutMs = Math.min(
      Math.max(input.timeoutMs ?? 120_000, 1),
      600_000,
    );
    const child = spawn(
      "/bin/bash",
      ["-lc", translateCommand(paths, input.command)],
      {
        cwd: guestPath(paths, input.cwd),
        env: commandEnvironment(paths, input.env),
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    const output = { stdout: [], stderr: [] };
    let bytes = 0;
    let termination;
    let forceKill;
    let settled = false;
    const settle = (complete, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(forceKill);
      signal?.removeEventListener("abort", abort);
      complete(value);
    };
    const terminate = (cause) => {
      if (termination !== undefined) return;
      termination = cause;
      signalProcessGroup(child, "SIGTERM");
      forceKill = setTimeout(() => signalProcessGroup(child, "SIGKILL"), 250);
    };
    const abort = () =>
      terminate(
        signal?.reason instanceof Error
          ? signal.reason
          : new Error("Local command aborted."),
      );
    const collect = (kind) => (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > 8 * 1024 * 1024)
        terminate(new Error("Local command output exceeded its bound."));
      else output[kind].push(chunk);
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));
    const timer = setTimeout(
      () => terminate(new Error("Local command timed out.")),
      timeoutMs,
    );
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.once("error", (cause) => settle(rejectCommand, cause));
    child.once("exit", (code, signal) => {
      if (termination !== undefined) {
        signalProcessGroup(child, "SIGKILL");
        settle(rejectCommand, termination);
      } else
        settle(resolveCommand, {
          stdout: Buffer.concat(output.stdout).toString("utf8"),
          stderr: Buffer.concat(output.stderr).toString("utf8"),
          exitCode: code ?? (signal === null ? 1 : 137),
        });
    });
  });

const readBody = async (request) => {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES)
      throw Object.assign(new Error("Request too large."), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
};

const json = (response, status, body) => {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(encoded),
    "cache-control": "no-store",
  });
  response.end(encoded);
};

const snapshot = (paths) => {
  const read = (path) => {
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.size > 64 * 1024) return undefined;
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  };
  const instructionFiles = {};
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const content = read(join(paths.workspace, name));
    if (content !== undefined) instructionFiles[name] = content;
  }
  const skillFiles = [];
  const skills = join(paths.workspace, ".agents/skills");
  if (existsSync(skills) && !lstatSync(skills).isSymbolicLink()) {
    for (const directoryName of readdirSync(skills).slice(0, 256)) {
      const content = read(join(skills, directoryName, "SKILL.md"));
      if (content !== undefined)
        skillFiles.push({ kind: "file", directoryName, content });
    }
  }
  return {
    instructionFiles,
    skillFiles,
    directoryListing: readdirSync(paths.workspace).slice(0, 256),
  };
};

export const createLocalRuntimeServer = ({
  workspaceRoot,
  stateRoot,
  token,
  dxdBinary,
}) => {
  const exactStateRoot = assertLocalStateRoot(workspaceRoot, stateRoot);
  mkdirSync(exactStateRoot, { recursive: true, mode: 0o700 });
  daemonBinaryDirectory = dirname(dxdBinary);
  const sourceFixtureRemote = ensureLocalSourceFixture(
    workspaceRoot,
    exactStateRoot,
  );
  const daemons = new Map();
  const launchDaemon = (threadId, paths, configPath) => {
    const workloadIdentitySocket = localWorkloadIdentitySocketPath(
      workspaceRoot,
      threadId,
    );
    for (const socketDirectory of [dirname(workloadIdentitySocket)]) {
      try {
        mkdirSync(socketDirectory, { mode: 0o700 });
      } catch (cause) {
        if (cause?.code !== "EEXIST") throw cause;
      }
      const info = lstatSync(socketDirectory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        (process.getuid !== undefined && info.uid !== process.getuid())
      )
        throw new Error("Local daemon socket directory is unsafe.");
      chmodSync(socketDirectory, 0o700);
    }
    const daemonProcess = spawn(dxdBinary, ["--config", configPath], {
      cwd: paths.workspace,
      env: {
        PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        USER: process.env.USER ?? "user",
        DX_WORKLOAD_IDENTITY_SOCKET: workloadIdentitySocket,
      },
      stdio: ["ignore", "ignore", "inherit"],
    });
    const daemon = { process: daemonProcess };
    daemons.set(threadId, daemon);
    daemonProcess.once("error", () => {
      if (daemons.get(threadId) === daemon) daemons.delete(threadId);
    });
    daemonProcess.once("exit", () => {
      if (daemons.get(threadId) === daemon) daemons.delete(threadId);
    });
  };
  const workspacesRoot = join(exactStateRoot, "workspaces");
  if (
    existsSync(workspacesRoot) &&
    !lstatSync(workspacesRoot).isSymbolicLink()
  ) {
    for (const threadId of readdirSync(workspacesRoot).slice(0, 1_024)) {
      try {
        safeThread(threadId);
        const paths = workspacePaths(exactStateRoot, threadId);
        const configPath = join(paths.daemon, "config.json");
        const info = lstatSync(configPath);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024)
          continue;
        const config = JSON.parse(readFileSync(configPath, "utf8"));
        if (
          config.version !== 2 ||
          config.threadId !== threadId ||
          localDaemonEndpoint(config.endpoint, threadId) !== config.endpoint ||
          config.workspaceRoot !== paths.workspace ||
          config.localRuntime?.homeDirectory !== paths.home ||
          config.localRuntime?.stateDirectory !== join(paths.root, "runtime")
        )
          continue;
        launchDaemon(threadId, paths, configPath);
      } catch {
        // Stale or invalid local daemon state fails closed and is not restored.
      }
    }
  }
  const server = createServer(async (request, response) => {
    const requestAbort = new AbortController();
    request.once("aborted", () => requestAbort.abort());
    response.once("close", () => {
      if (!response.writableEnded) requestAbort.abort();
    });
    try {
      if (request.headers.authorization !== `Bearer ${token}`)
        return json(response, 401, { error: "unauthorized" });
      const match =
        /^\/v1\/workspaces\/(thr_[^/]+)\/(ensure|source|exec|read|write|stat|readdir|mkdir|rm|snapshot|daemon|pause)$/.exec(
          request.url ?? "",
        );
      if (request.method !== "POST" || match === null)
        return json(response, 404, { error: "not-found" });
      const input = await readBody(request);
      const paths = workspacePaths(exactStateRoot, match[1]);
      const operation = match[2];
      const existingOnly = input.existingOnly === true;
      if (operation === "pause") {
        daemons.get(match[1])?.process.kill("SIGTERM");
        daemons.delete(match[1]);
        removeDaemonConfig(paths);
        return json(response, 200, {});
      }
      const usesWorkspace = (value) =>
        typeof value === "string" &&
        (value === GUEST_WORKSPACE || value.startsWith(`${GUEST_WORKSPACE}/`));
      const prepareSourceWorkspace =
        operation === "source" ||
        (operation === "ensure" && input.prepareSourceWorkspace === true) ||
        (operation === "exec" &&
          input.cwd !== undefined &&
          !usesWorkspace(input.cwd)) ||
        (input.path !== undefined && !usesWorkspace(input.path));
      ensureWorkspace(paths, existingOnly, prepareSourceWorkspace);
      let result;
      switch (operation) {
        case "ensure":
          result = { cwd: GUEST_WORKSPACE };
          break;
        case "source":
          result = localSourceWorkspaceConfiguration(
            workspaceRoot,
            exactStateRoot,
            match[1],
            sourceFixtureRemote,
          );
          break;
        case "exec":
          result = await runCommand(paths, input, requestAbort.signal);
          break;
        case "read": {
          const contents = readFileSync(guestPath(paths, input.path));
          result = { contents: contents.toString("base64") };
          break;
        }
        case "write": {
          const path = guestPath(paths, input.path);
          mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
          writeFileSync(path, Buffer.from(input.contents, "base64"));
          result = {};
          break;
        }
        case "stat": {
          const info = lstatSync(guestPath(paths, input.path));
          result = {
            file: info.isFile(),
            directory: info.isDirectory(),
            symlink: info.isSymbolicLink(),
          };
          break;
        }
        case "readdir":
          result = { entries: readdirSync(guestPath(paths, input.path)) };
          break;
        case "mkdir":
          mkdirSync(guestPath(paths, input.path), {
            recursive: input.recursive === true,
          });
          result = {};
          break;
        case "rm":
          rmSync(guestPath(paths, input.path), {
            recursive: input.recursive === true,
            force: input.force === true,
          });
          result = {};
          break;
        case "snapshot":
          result = snapshot(paths);
          break;
        case "daemon": {
          if (!existsSync(dxdBinary))
            throw new Error("Local dxd binary is unavailable.");
          mkdirSync(paths.daemon, { recursive: true, mode: 0o700 });
          const configPath = join(paths.daemon, "config.json");
          const endpoint = localDaemonEndpoint(input.endpoint, match[1]);
          let existing;
          try {
            existing = JSON.parse(readFileSync(configPath, "utf8"));
          } catch {
            existing = undefined;
          }
          const usable =
            existing?.version === 2 &&
            existing.threadId === match[1] &&
            existing.endpoint === endpoint &&
            existing.workspaceRoot === paths.workspace;
          if (typeof input.apiKey !== "string" && !usable) {
            // The configuration is static and holds the Thread's one key;
            // without it Core must mint one before the daemon can start.
            result = { status: "credential-required" };
            break;
          }
          if (typeof input.apiKey === "string") {
            const config = {
              version: 2,
              endpoint,
              threadId: match[1],
              apiKey: input.apiKey,
              workspaceRoot: paths.workspace,
              localRuntime: {
                homeDirectory: paths.home,
                stateDirectory: join(paths.root, "runtime"),
              },
            };
            writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
            chmodSync(configPath, 0o600);
          }
          const current = daemons.get(match[1]);
          const configChanged = typeof input.apiKey === "string" && !usable;
          if (
            current === undefined ||
            current.process.exitCode !== null ||
            configChanged
          ) {
            current?.process.kill("SIGTERM");
            launchDaemon(match[1], paths, configPath);
          }
          result = { status: "running" };
          break;
        }
        default:
          throw new Error("Unsupported local runtime operation.");
      }
      json(response, 200, result);
    } catch (cause) {
      json(response, cause?.status ?? 400, {
        error: "local-runtime-unavailable",
      });
    }
  });
  server.once("close", () => {
    for (const daemon of daemons.values()) daemon.process.kill("SIGTERM");
  });
  return server;
};
