import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertDockerReady,
  destroyOrbWorker,
  orbDockerEnvironment,
  orbWorkerExists,
  retryContainerSettings,
} from "./containers.mjs";

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

describe("Wrangler's interrupted container settings", () => {
  // Wrangler's own words when the Worker version is live but the container
  // application settings were not applied (preview runs 39445094840 and
  // 39523973423).
  const interrupted = {
    status: 1,
    stdout: "",
    stderr:
      "✘ [ERROR] The Worker version was deployed, but Wrangler could not finish applying its Durable Object-managed Container application settings. Re-run the same `wrangler deploy` command to retry and finish deployment.",
  };
  const run = (...results) => {
    const deploy = vi.fn(() => results.shift());
    const wait = vi.fn();
    return { deploy, wait };
  };

  it("re-runs the same deploy until Wrangler finishes, waiting between runs", () => {
    const { deploy, wait } = run(interrupted, interrupted, {
      status: 0,
      stdout: "",
      stderr: "",
    });
    expect(retryContainerSettings({ deploy, wait }).status).toBe(0);
    expect(deploy).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("stops after three runs and returns Wrangler's failure", () => {
    const { deploy, wait } = run(interrupted, interrupted, interrupted, {
      status: 0,
    });
    expect(retryContainerSettings({ deploy, wait })).toBe(interrupted);
    expect(deploy).toHaveBeenCalledTimes(3);
  });

  it("never repeats a successful deploy or any other failure", () => {
    const failed = { status: 1, stdout: "", stderr: "image build failed" };
    for (const result of [{ status: 0, stdout: "", stderr: "" }, failed]) {
      const { deploy, wait } = run(result, { status: 0 });
      expect(retryContainerSettings({ deploy, wait })).toBe(result);
      expect(deploy).toHaveBeenCalledTimes(1);
      expect(wait).not.toHaveBeenCalled();
    }
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

const docker = (environment, args) =>
  spawnSync("docker", args, { env: environment, encoding: "utf8" });

describe.skipIf(!dockerCli)(
  "Docker for the Orb image under the deploy's isolated HOME",
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

    it("refuses to start when Buildx cannot run, naming what to install", () => {
      const machine = operatorMachine({ buildx: "broken" });
      const environment = orbDockerEnvironment({
        environment: machine.deployEnvironment,
        stateDirectory: machine.stateDirectory,
      });
      expect(() =>
        assertDockerReady(environment, {
          // The daemon check is separate; this machine has no engine.
          daemon: () => true,
        }),
      ).toThrow(/Buildx/);
    });
  },
);
