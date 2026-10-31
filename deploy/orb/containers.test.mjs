import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertDockerReady,
  deployOrbWorker,
  destroyOrbWorker,
  orbDockerEnvironment,
  orbWorkerExists,
  retryOrbWorkerDeploy,
  transientDeployFailure,
} from "./containers.mjs";
import {
  permanentDeployFailures,
  transientDeployFailures,
} from "./recorded-deploy-failures.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("Cloudflare Containers Orb Worker deployment", () => {
  it("removes the application, the Worker, and the image repository with its snapshots", async () => {
    const calls = [];
    const fetch = vi.fn(async (url, init) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
      const path = new URL(url).pathname;
      const result = path.endsWith("/workers/durable_objects/namespaces")
        ? [
            { id: "ns-other", script: "dx-app", class: "RealtimeHub" },
            {
              id: "ns-orb",
              script: "dx-orb-test",
              class: "OrbContainerObject",
            },
          ]
        : path.endsWith("/containers/applications")
          ? [
              { id: "app-orb", durable_objects: { namespace_id: "ns-orb" } },
              { id: "app-other", durable_objects: { namespace_id: "ns-x" } },
            ]
          : null;
      return Response.json({ success: true, result });
    });
    const run = vi.fn((args) =>
      args[2] === "list"
        ? {
            status: 0,
            stdout: JSON.stringify([
              {
                name: "dx-orb-test-orb-orbcontainerobject",
                tags: ["a", "rootfs-snapshot-b"],
              },
              { name: "dx-app-other", tags: ["c"] },
            ]),
          }
        : { status: 0, stdout: "" },
    );
    await destroyOrbWorker({
      workerName: "dx-orb-test",
      accountId: "a".repeat(32),
      apiToken: "token",
      workspaceRoot,
      fetch,
      run,
    });
    expect(calls).toEqual([
      `GET /client/v4/accounts/${"a".repeat(32)}/workers/durable_objects/namespaces`,
      `GET /client/v4/accounts/${"a".repeat(32)}/containers/applications`,
      `DELETE /client/v4/accounts/${"a".repeat(32)}/containers/applications/app-orb`,
      `DELETE /client/v4/accounts/${"a".repeat(32)}/workers/scripts/dx-orb-test`,
    ]);
    expect(run.mock.calls.slice(1).map(([args]) => args[3])).toEqual([
      "dx-orb-test-orb-orbcontainerobject:a",
      "dx-orb-test-orb-orbcontainerobject:rootfs-snapshot-b",
    ]);
  });
});

describe("Orb Worker lookup after an interrupted create", () => {
  const lookup = (response) => {
    const fetch = vi.fn(async () => response);
    return {
      fetch,
      exists: () =>
        orbWorkerExists({
          workerName: "dx-orb-test",
          accountId: "a".repeat(32),
          apiToken: "token",
          fetch,
        }),
    };
  };

  it("finds the script by name, and reports a missing one as absent", async () => {
    const found = lookup(Response.json({ success: true, result: {} }));
    await expect(found.exists()).resolves.toBe(true);
    const [url, init] = found.fetch.mock.calls[0];
    expect(new URL(url).pathname).toBe(
      `/client/v4/accounts/${"a".repeat(32)}/workers/scripts/dx-orb-test/settings`,
    );
    expect(init.headers.Authorization).toBe("Bearer token");
    await expect(
      lookup(
        Response.json(
          { success: false, errors: [{ code: 10007 }] },
          { status: 404 },
        ),
      ).exists(),
    ).resolves.toBe(false);
  });

  it("fails on any other Cloudflare error instead of guessing", async () => {
    for (const response of [
      Response.json({ success: false }, { status: 403 }),
      Response.json({ success: false }, { status: 500 }),
      Response.json({ success: false, result: null }),
    ])
      await expect(lookup(response).exists()).rejects.toThrow(
        "Cloudflare request GET /workers/scripts/dx-orb-test/settings failed",
      );
  });
});

describe("Retrying a failed Orb Worker deploy", () => {
  const failed = (stderr) => ({ status: 1, stdout: "", stderr });
  const succeeded = { status: 0, stdout: "", stderr: "" };
  const run = (...results) => {
    const deploy = vi.fn(() => results.shift());
    const wait = vi.fn();
    return { deploy, wait };
  };
  const quietly = async (body) => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      return await body();
    } finally {
      write.mockRestore();
    }
  };

  for (const [name, stderr] of Object.entries(transientDeployFailures))
    it(`runs the same deploy again after ${name}`, () =>
      quietly(async () => {
        const { deploy, wait } = run(failed(stderr), succeeded);
        expect(await retryOrbWorkerDeploy({ deploy, wait })).toBe(succeeded);
        expect(deploy).toHaveBeenCalledTimes(2);
        expect(wait).toHaveBeenCalledTimes(1);
      }));

  it("waits longer before each run and stops after three, returning the last failure", () =>
    quietly(async () => {
      const last = failed(transientDeployFailures["registry-push-timeout"]);
      const { deploy, wait } = run(
        failed(transientDeployFailures["cloudflare-10500"]),
        failed(transientDeployFailures["image-preparation-500"]),
        last,
        succeeded,
      );
      expect(await retryOrbWorkerDeploy({ deploy, wait })).toBe(last);
      expect(deploy).toHaveBeenCalledTimes(3);
      expect(wait.mock.calls).toEqual([[20_000], [40_000]]);
    }));

  for (const [name, stderr] of Object.entries(permanentDeployFailures))
    it(`never repeats ${name}`, () =>
      quietly(async () => {
        const result = failed(stderr);
        const { deploy, wait } = run(result, succeeded);
        expect(await retryOrbWorkerDeploy({ deploy, wait })).toBe(result);
        expect(deploy).toHaveBeenCalledTimes(1);
        expect(wait).not.toHaveBeenCalled();
      }));

  it("never repeats a successful deploy or a failure it does not recognize", () =>
    quietly(async () => {
      for (const result of [succeeded, failed("image build failed")]) {
        const { deploy, wait } = run(result, succeeded);
        expect(await retryOrbWorkerDeploy({ deploy, wait })).toBe(result);
        expect(deploy).toHaveBeenCalledTimes(1);
        expect(wait).not.toHaveBeenCalled();
      }
    }));

  it("says why it runs the deploy again", () => {
    expect(
      transientDeployFailure(transientDeployFailures["registry-push-timeout"]),
    ).toMatch(/registry/i);
    expect(
      transientDeployFailure(transientDeployFailures["cloudflare-10500"]),
    ).toMatch(/10500/);
    for (const stderr of Object.values(permanentDeployFailures))
      expect(transientDeployFailure(stderr)).toBeUndefined();
  });
});

/**
 * A Cloudflare API that has no container application yet, and refuses every
 * other request the way the Containers API refuses an application over the
 * account's limits.
 */
const refusingCloudflareApi = async (run) => {
  const server = createServer((request, response) => {
    const lookup =
      request.method === "GET" &&
      /\/containers\/applications\/[^/]+$/.test(request.url);
    response.writeHead(lookup ? 404 : 400, {
      "content-type": "application/json",
    });
    response.end(
      JSON.stringify({
        success: false,
        errors: [
          lookup
            ? { code: 1001, message: "application not found" }
            : { code: 1000, message: "account container limit reached" },
        ],
        result: null,
        messages: [],
      }),
    );
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    return await run(`http://127.0.0.1:${server.address().port}/client/v4`);
  } finally {
    server.close();
  }
};

/**
 * A workspace whose Wrangler takes `seconds` to deploy, printing a line at
 * the start, and a PATH whose Docker has a running engine and Buildx. With
 * an `api`, Wrangler first calls it as its container settings step does:
 * it looks the application up, then creates it. Like the real one starting
 * Docker, Wrangler starts a long-lived child; `pids` records both.
 */
const slowWranglerWorkspace = ({ seconds, exitCode = 0, api }) => {
  const root = mkdtempSync(join(tmpdir(), "dx-orb-slow-"));
  const bin = join(root, "bin");
  const wranglerBin = join(root, "node_modules/wrangler-containers/bin");
  const pids = join(root, "pids");
  mkdirSync(bin, { recursive: true });
  mkdirSync(wranglerBin, { recursive: true });
  writeFileSync(join(bin, "docker"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "docker"), 0o755);
  const calls =
    api === undefined
      ? []
      : [
          `await fetch(${JSON.stringify(`${api}/accounts/a/containers/applications/namespace`)});`,
          `await fetch(${JSON.stringify(`${api}/accounts/a/containers/applications`)}, { method: "POST" });`,
        ];
  writeFileSync(
    join(wranglerBin, "wrangler.js"),
    [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const build = spawn("sleep", ["60"], { stdio: "ignore" });',
      `writeFileSync(${JSON.stringify(pids)}, \`\${process.pid} \${build.pid}\`);`,
      'process.stdout.write("building the Orb image\\n");',
      ...calls,
      "setTimeout(() => {",
      "  build.kill();",
      `  process.stderr.write("wrangler finished ${exitCode}\\n");`,
      `  process.exit(${exitCode});`,
      `}, ${seconds * 1000});`,
    ].join("\n"),
  );
  return {
    pids,
    workspaceRoot: root,
    stateDirectory: join(root, "state"),
    environment: { PATH: `${bin}:${process.env.PATH}`, HOME: root },
  };
};

// These tests start Node and Wrangler processes, which take seconds on a
// loaded CI runner.
describe("Orb Worker deploy alongside other deploy steps", {
  timeout: 30_000,
}, () => {
  // Staging run 39536695999: a 326 s synchronous deploy froze Alchemy's
  // event loop, so Bootstrap's 3-minute timer fired as soon as it returned.
  it("keeps other steps' timers on schedule and streams Wrangler's output", async () => {
    const workspace = slowWranglerWorkspace({ seconds: 2 });
    const written = [];
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => written.push(String(chunk)) > 0);
    const lateness = [];
    let streamedWhileRunning = false;
    let settled = false;
    let previous = Date.now();
    const timer = setInterval(() => {
      const now = Date.now();
      lateness.push(now - previous - 50);
      previous = now;
      if (!settled && written.join("").includes("building the Orb image"))
        streamedWhileRunning = true;
    }, 50);
    try {
      const started = Date.now();
      const deploying = deployOrbWorker({
        workerName: "dx-orb-test",
        ...workspace,
      });
      expect(deploying).toBeInstanceOf(Promise);
      await expect(deploying).resolves.toEqual({ workerName: "dx-orb-test" });
      settled = true;
      expect(Date.now() - started).toBeGreaterThanOrEqual(2000);
    } finally {
      clearInterval(timer);
      write.mockRestore();
    }
    expect(lateness.length).toBeGreaterThanOrEqual(20);
    expect(Math.max(...lateness)).toBeLessThan(500);
    expect(streamedWhileRunning).toBe(true);
    expect(written.join("")).toContain("wrangler finished 0");
  });

  it("fails with Wrangler's exit status and the Cloudflare API's answer", async () => {
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      await refusingCloudflareApi(async (api) => {
        const workspace = slowWranglerWorkspace({
          seconds: 0,
          exitCode: 7,
          api,
        });
        const failure = deployOrbWorker({
          workerName: "dx-orb-test",
          ...workspace,
        });
        await expect(failure).rejects.toThrow(/wrangler exit 7\)\./);
        await expect(failure).rejects.toThrow(
          "Cloudflare API POST /client/v4/accounts/a/containers/applications answered 400",
        );
        await expect(failure).rejects.toThrow(
          "account container limit reached",
        );
        // The lookup's 404 is the expected "no application yet".
        await expect(failure).rejects.not.toThrow("answered 404");
      });
    } finally {
      write.mockRestore();
    }
  });

  // DX_ORB_DEPLOY_FAULTS proves the retry on a real preview deploy without
  // waiting for Cloudflare to fail.
  describe("with recorded failures injected", () => {
    const deployWithFaults = async (faults, deployment = "preview") => {
      const workspace = slowWranglerWorkspace({ seconds: 0 });
      const written = [];
      const write = vi
        .spyOn(process.stderr, "write")
        .mockImplementation((chunk) => written.push(String(chunk)) > 0);
      try {
        const outcome = await deployOrbWorker({
          workerName: "dx-orb-test",
          ...workspace,
          environment: {
            ...workspace.environment,
            DX_DEPLOYMENT_ENVIRONMENT: deployment,
            DX_ORB_DEPLOY_FAULTS: faults,
          },
          retryDelayMilliseconds: 10,
        }).then(
          (value) => ({ value }),
          (error) => ({ error }),
        );
        const output = written.join("");
        return {
          ...outcome,
          output,
          wranglerRuns: output.split("building the Orb image").length - 1,
        };
      } finally {
        write.mockRestore();
      }
    };

    it("replays each failure in place of a run, then deploys with Wrangler", async () => {
      const { value, output, wranglerRuns } = await deployWithFaults(
        "registry-push-timeout,cloudflare-10500",
      );
      expect(value).toEqual({ workerName: "dx-orb-test" });
      expect(wranglerRuns).toBe(1);
      expect(output).toContain(
        "Replaying the recorded failure registry-push-timeout",
      );
      expect(output).toContain("net/http: timeout awaiting response headers");
      expect(output).toContain(
        "Replaying the recorded failure cloudflare-10500",
      );
      expect(output).toContain("wrangler deploy run 3 of 3 exited 0");
    });

    it("fails at once on a recorded refusal, without running Wrangler", async () => {
      const { error, wranglerRuns } =
        await deployWithFaults("consecutive-dashes");
      expect(error.message).toContain("has two consecutive dashes");
      expect(wranglerRuns).toBe(0);
    });

    it("refuses faults outside a preview deploy and names it cannot know", async () => {
      for (const [faults, deployment, message] of [
        ["cloudflare-10500", "staging", /only on a preview deploy/],
        ["cloudflare-10500", "selfhost", /only on a preview deploy/],
        ["cloudflare-1050", "preview", /no recorded failure cloudflare-1050/],
      ]) {
        const { error, wranglerRuns } = await deployWithFaults(
          faults,
          deployment,
        );
        expect(error.message).toMatch(message);
        expect(wranglerRuns).toBe(0);
      }
    });
  });

  it("stops Wrangler and what it started when the deploy is interrupted", async () => {
    const workspace = slowWranglerWorkspace({ seconds: 30 });
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const write = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const controller = new AbortController();
      const deploying = deployOrbWorker({
        workerName: "dx-orb-test",
        ...workspace,
        signal: controller.signal,
      });
      for (let wait = 0; wait < 100 && !existsSync(workspace.pids); wait += 1)
        await new Promise((done) => setTimeout(done, 50));
      const pids = readFileSync(workspace.pids, "utf8").split(" ").map(Number);
      expect(pids.every(alive)).toBe(true);
      controller.abort(new Error("deploy interrupted"));
      await expect(deploying).rejects.toThrow("deploy interrupted");
      for (let wait = 0; wait < 40 && pids.some(alive); wait += 1)
        await new Promise((done) => setTimeout(done, 50));
      expect(pids.filter(alive)).toEqual([]);
    } finally {
      write.mockRestore();
    }
  });

  // Wrangler 4.147 keeps the Containers API's answer as an unprinted cause
  // of "could not finish applying its ... Container application settings"
  // (preview run 39538154170), so the deploy prints it from Wrangler's fetch.
  it("prints the API's answer from the pinned Wrangler's Containers client", async () => {
    const result = await refusingCloudflareApi((api) => {
      const home = mkdtempSync(join(tmpdir(), "dx-orb-wrangler-"));
      return new Promise((done) => {
        const child = spawn(
          process.execPath,
          [
            "--import",
            join(import.meta.dirname, "wrangler-api-errors.mjs"),
            join(
              workspaceRoot,
              "node_modules/wrangler-containers/bin/wrangler.js",
            ),
            "containers",
            "list",
          ],
          {
            cwd: home,
            env: {
              PATH: process.env.PATH,
              HOME: home,
              CI: "1",
              WRANGLER_SEND_METRICS: "false",
              CLOUDFLARE_API_BASE_URL: api,
              CLOUDFLARE_API_TOKEN: "token",
              CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
            },
          },
        );
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("close", (status) => done({ status, stderr }));
      });
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /\[OrbContainers\] Cloudflare API GET \/client\/v4\/accounts\/a{32}\/containers\/\S+ answered 400: .*account container limit reached/,
    );
  });
});

const dockerCli = spawnSync("docker", ["--version"]).status === 0;

/**
 * An operator machine: a real HOME with its own Docker configuration, the
 * deploy's isolated HOME, and a PATH whose default credential helper fails
 * like a macOS keychain with no login keychain and records every call.
 */
const operatorMachine = ({ buildx = "working", context = true } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "dx-orb-docker-"));
  const operatorHome = join(root, "operator");
  const operatorDocker = join(operatorHome, ".docker");
  const isolatedHome = join(root, "auth-home");
  const bin = join(root, "bin");
  const helperCalls = join(root, "helper-calls");
  mkdirSync(join(operatorDocker, "cli-plugins"), { recursive: true });
  mkdirSync(isolatedHome, { recursive: true });
  mkdirSync(bin, { recursive: true });
  for (const helper of ["osxkeychain", "secretservice", "desktop"]) {
    const path = join(bin, `docker-credential-${helper}`);
    writeFileSync(
      path,
      `#!/bin/sh\necho "$0 $*" >> '${helperCalls}'\necho "Keychain Error. (-60006)" >&2\nexit 1\n`,
    );
    chmodSync(path, 0o755);
  }
  // The operator's own Buildx, recognizable by its version. A "broken" one
  // is found but cannot run, which the preflight must treat as missing; it
  // also shadows any Buildx the host installs system-wide.
  if (buildx !== "none") {
    const plugin = join(operatorDocker, "cli-plugins", "docker-buildx");
    writeFileSync(
      plugin,
      `#!/bin/sh
if [ "$1" = docker-cli-plugin-metadata ]; then
  echo '{"SchemaVersion":"0.1.0","Vendor":"test","Version":"v0.99.0","ShortDescription":"Buildx"}'
  exit 0
fi
${buildx === "broken" ? 'echo "buildx is broken" >&2; exit 1' : 'echo "buildx v0.99.0 test"'}
`,
    );
    chmodSync(plugin, 0o755);
  }
  // The operator's engine, selected as a context the way OrbStack and
  // Docker Desktop select theirs.
  writeFileSync(
    join(operatorDocker, "config.json"),
    JSON.stringify({ credsStore: "osxkeychain", auths: {} }),
  );
  if (context) {
    const created = spawnSync(
      "docker",
      [
        "context",
        "create",
        "operator-engine",
        "--docker",
        "host=unix:///tmp/dx-operator-engine.sock",
      ],
      { env: { ...process.env, DOCKER_CONFIG: operatorDocker } },
    );
    if (created.status !== 0) throw new Error(String(created.stderr));
    const config = JSON.parse(
      readFileSync(join(operatorDocker, "config.json"), "utf8"),
    );
    writeFileSync(
      join(operatorDocker, "config.json"),
      JSON.stringify({ ...config, currentContext: "operator-engine" }),
    );
  }
  // What the deploy hands its children: an isolated HOME, the operator's
  // HOME recorded beside it, and the operator's other variables.
  const deployEnvironment = {
    PATH: `${bin}:${process.env.PATH}`,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    XDG_CONFIG_HOME: join(isolatedHome, ".config"),
    DX_OPERATOR_HOME: operatorHome,
  };
  return {
    root,
    operatorDocker,
    helperCalls,
    deployEnvironment,
    stateDirectory: join(root, "state"),
  };
};

// Public CI run 39549404683: on a GitHub-hosted runner, under the whole
// suite, the Buildx test took 10.7 s where earlier runs took about 0.5 s,
// past Vitest's 5 s default. The tests below allow for a slow Docker call;
// a hung one still fails here.
const docker = (environment, args) =>
  spawnSync("docker", args, {
    env: environment,
    encoding: "utf8",
    timeout: 20_000,
  });

describe.skipIf(!dockerCli)(
  "Docker for the Orb image under the deploy's isolated HOME",
  { timeout: 60_000 },
  () => {
    it("stores the registry login in its own file, never the OS keychain", () => {
      const machine = operatorMachine();
      const environment = orbDockerEnvironment({
        environment: machine.deployEnvironment,
        stateDirectory: machine.stateDirectory,
      });
      const logout = docker(environment, ["logout", "registry.cloudflare.com"]);
      expect(logout.status).toBe(0);
      expect(existsSync(machine.helperCalls)).toBe(false);
      // Without it, Docker picks the platform helper, which is what failed.
      docker(machine.deployEnvironment, ["logout", "registry.cloudflare.com"]);
      expect(existsSync(machine.helperCalls)).toBe(true);
    });

    it("keeps the operator's CLI plugins, so Buildx builds the image", () => {
      const machine = operatorMachine();
      // Under the isolated HOME the operator's Buildx is out of reach: the
      // command fails, or reaches a Buildx the host installed system-wide.
      expect(
        docker(machine.deployEnvironment, ["buildx", "version"]).stdout,
      ).not.toContain("buildx v0.99.0");
      const environment = orbDockerEnvironment({
        environment: machine.deployEnvironment,
        stateDirectory: machine.stateDirectory,
      });
      const buildx = docker(environment, ["buildx", "version"]);
      expect(buildx.status).toBe(0);
      expect(buildx.stdout).toContain("buildx v0.99.0");
    });

    it("keeps the operator's selected engine", () => {
      const machine = operatorMachine();
      const environment = orbDockerEnvironment({
        environment: machine.deployEnvironment,
        stateDirectory: machine.stateDirectory,
      });
      const host = docker(environment, [
        "context",
        "inspect",
        "--format",
        "{{.Endpoints.docker.Host}}",
      ]);
      expect(host.status).toBe(0);
      expect(host.stdout.trim()).toBe("unix:///tmp/dx-operator-engine.sock");
    });

    it("respects an explicit DOCKER_HOST", () => {
      const machine = operatorMachine();
      const environment = orbDockerEnvironment({
        environment: {
          ...machine.deployEnvironment,
          DOCKER_HOST: "tcp://127.0.0.1:2375",
        },
        stateDirectory: machine.stateDirectory,
      });
      expect(environment.DOCKER_HOST).toBe("tcp://127.0.0.1:2375");
      const host = docker(environment, [
        "context",
        "inspect",
        "--format",
        "{{.Endpoints.docker.Host}}",
      ]);
      expect(host.stdout.trim()).toBe("tcp://127.0.0.1:2375");
    });

    it("never writes to the operator's Docker configuration", () => {
      const machine = operatorMachine();
      const before = readFileSync(
        join(machine.operatorDocker, "config.json"),
        "utf8",
      );
      const environment = orbDockerEnvironment({
        environment: machine.deployEnvironment,
        stateDirectory: machine.stateDirectory,
      });
      docker(environment, ["logout", "registry.cloudflare.com"]);
      expect(
        readFileSync(join(machine.operatorDocker, "config.json"), "utf8"),
      ).toBe(before);
      expect(
        environment.DOCKER_CONFIG?.startsWith(machine.stateDirectory),
      ).toBe(true);
    });

    it("works for an operator without any Docker configuration", () => {
      const machine = operatorMachine({ buildx: "none", context: false });
      const environment = orbDockerEnvironment({
        environment: {
          ...machine.deployEnvironment,
          DX_OPERATOR_HOME: join(machine.root, "no-such-home"),
        },
        stateDirectory: machine.stateDirectory,
      });
      expect(
        docker(environment, ["logout", "registry.cloudflare.com"]).status,
      ).toBe(0);
      expect(existsSync(machine.helperCalls)).toBe(false);
    });

    it("refuses to start when Buildx cannot run, naming what to install", async () => {
      const machine = operatorMachine({ buildx: "broken" });
      const environment = orbDockerEnvironment({
        environment: machine.deployEnvironment,
        stateDirectory: machine.stateDirectory,
      });
      await expect(
        assertDockerReady(environment, {
          // The daemon check is separate; this machine has no engine.
          daemon: async () => true,
        }),
      ).rejects.toThrow(/Buildx/);
    });
  },
);
