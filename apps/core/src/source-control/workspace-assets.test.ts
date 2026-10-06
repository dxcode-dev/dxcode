import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  assetInstallerProgram,
  assetVerifierProgram,
  createSourceWorkspaceProgram,
  gitCredentialHelperProgram,
  type SourceWorkspaceProgramConfiguration,
} from "./workspace-assets.js";

const token = "synthetic-token-116";

const invokeHelper = async (
  operation: string,
  input: string,
  environment: Record<string, string> = {},
) => {
  const directory = await mkdtemp(join(tmpdir(), "dx-helper-"));
  const helper = join(directory, "dx-git-credential");
  writeFileSync(helper, gitCredentialHelperProgram, { mode: 0o700 });
  return spawnSync(
    process.execPath,
    ["--no-experimental-detect-module", helper, operation],
    {
      input,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        DX_SOURCE_PROVIDER: "github",
        GH_TOKEN: token,
        DX_GIT_ALLOWED_PATH: "Owner/Repository",
        ...environment,
      },
    },
  );
};

const git = (cwd: string, ...argumentsList: string[]) => {
  const result = spawnSync("git", argumentsList, { cwd, encoding: "utf8" });
  if (result.status !== 0)
    throw new Error(`git failed: ${result.stderr || result.stdout}`);
  return result.stdout.trim();
};

interface HarnessFixture {
  readonly base: string;
  readonly paths: SourceWorkspaceProgramConfiguration;
  readonly program: string;
  readonly lock: string;
  readonly sourceSha: string;
  readonly environment: Record<string, string>;
  readonly outside: string;
  readonly stop: () => Promise<void>;
}

const startGitHttpServer = async (repository: string) => {
  const server = spawn(
    process.execPath,
    [
      "-e",
      String.raw`
const { createReadStream, lstatSync, realpathSync } = require("node:fs");
const { createServer } = require("node:http");
const { resolve, sep } = require("node:path");
const root = realpathSync(process.argv[1]);
const prefix = "/owner/repository.git/";
const server = createServer((request, response) => {
  if (request.method !== "GET" || request.headers.authorization !== undefined) {
    response.writeHead(400).end();
    return;
  }
  let pathname;
  try { pathname = new URL(request.url, "http://127.0.0.1").pathname; }
  catch { response.writeHead(400).end(); return; }
  if (!pathname.startsWith(prefix) || pathname.includes("%")) {
    response.writeHead(404).end();
    return;
  }
  const relative = pathname.slice(prefix.length);
  const parts = relative.split("/");
  if (parts.some(part => part === "" || part === "." || part === ".." || !/^[A-Za-z0-9._-]+$/.test(part))) {
    response.writeHead(404).end();
    return;
  }
  const target = resolve(root, ...parts);
  if (!target.startsWith(root + sep)) {
    response.writeHead(404).end();
    return;
  }
  let stat;
  try { stat = lstatSync(target); }
  catch { response.writeHead(404).end(); return; }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "content-type": relative === "info/refs" || relative === "HEAD" ? "text/plain" : "application/octet-stream",
    "content-length": stat.size,
  });
  createReadStream(target).pipe(response);
});
server.listen(0, "127.0.0.1", () => process.stdout.write(String(server.address().port) + "\n"));
process.on("SIGTERM", () => server.close());
`,
      repository,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const port = await new Promise<number>((resolvePort, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(
      () => reject(new Error("Git HTTP fixture timed out.")),
      5_000,
    );
    server.stderr.setEncoding("utf8");
    server.stderr.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4_096);
    });
    server.stdout.setEncoding("utf8");
    server.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const match = /^(\d+)\n/.exec(stdout);
      if (match?.[1] === undefined) return;
      clearTimeout(timer);
      resolvePort(Number(match[1]));
    });
    server.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    server.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Git HTTP fixture exited (${code}): ${stderr}`));
    });
  });
  return {
    url: `http://127.0.0.1:${port}/owner/repository.git`,
    stop: async () => {
      if (server.exitCode !== null || server.signalCode !== null) return;
      const exited = new Promise<void>((resolveExit) => {
        server.once("exit", () => resolveExit());
      });
      server.kill("SIGTERM");
      await exited;
    },
  };
};

const makeHarness = async (input?: {
  readonly lfsAttributes?: boolean;
  readonly http?: boolean;
  readonly shallowClone?: boolean;
  readonly requiresFullHistory?: boolean;
}): Promise<HarnessFixture> => {
  const base = await mkdtemp(
    join(realpathSync(tmpdir()), "dx-workspace-harness-"),
  );
  const source = join(base, "source");
  const upstream = join(base, "upstream.git");
  const workspaceParent = join(base, "workspace");
  const home = join(base, "home");
  const helper = join(base, "libexec", "dx-git-credential");
  const program = join(base, "libexec", "dx-source-workspace.mjs");
  const outside = join(base, "outside");
  mkdirSync(source);
  mkdirSync(workspaceParent);
  mkdirSync(home);
  mkdirSync(dirname(helper));
  mkdirSync(outside);
  git(source, "init", "-b", "main");
  git(source, "config", "user.email", "fixture@example.test");
  git(source, "config", "user.name", "Fixture");
  git(source, "config", "commit.gpgsign", "false");
  mkdirSync(join(source, ".agents"));
  writeFileSync(join(source, "README.md"), "snapshot\n");
  if (input?.lfsAttributes === true)
    writeFileSync(join(source, ".gitattributes"), "*.bin filter=lfs\n");
  writeFileSync(
    join(source, ".agents", "setup"),
    `#!/bin/sh\n${input?.requiresFullHistory === true ? "# dx-requires: full-history\n" : ""}[ ! -f "$HOME/fail-setup" ] || exit 7\nprintf "setup\\n" >> "$HOME/hook-order"\n`,
    { mode: 0o755 },
  );
  writeFileSync(
    join(source, ".agents", "resume"),
    '#!/bin/sh\nprintf "resume\\n" >> "$HOME/hook-order"\n',
    { mode: 0o755 },
  );
  git(source, "add", ".");
  git(source, "commit", "-m", "fixture");
  const sourceSha = git(source, "rev-parse", "HEAD");
  git(base, "clone", "--bare", source, upstream);
  let fixtureRemote = upstream;
  let stop = async () => {};
  if (input?.http === true) {
    git(base, "--git-dir", upstream, "update-server-info");
    const http = await startGitHttpServer(upstream);
    fixtureRemote = http.url;
    stop = http.stop;
  }
  const paths: SourceWorkspaceProgramConfiguration = {
    root: join(workspaceParent, "repo"),
    state: join(base, "state", "source-control-v1.json"),
    claim: join(base, "state", "source-control-claim-v1.json"),
    logDirectory: join(base, "logs"),
    helper,
    templateDirectory: join(base, "state", "empty-template"),
    home,
    workspaceParent,
    gitHome: join(base, "state", "git-home"),
    fixtureRemote:
      input?.shallowClone === true && input.http !== true
        ? `file://${fixtureRemote}`
        : fixtureRemote,
    shallowClone: input?.shallowClone,
  };
  writeFileSync(helper, gitCredentialHelperProgram, { mode: 0o555 });
  writeFileSync(program, createSourceWorkspaceProgram(paths), { mode: 0o555 });
  return {
    base,
    paths,
    program,
    lock: join(base, "state", "source-control.lock.d"),
    sourceSha,
    outside,
    stop,
    environment: {
      PATH: process.env.PATH ?? "",
      DX_SOURCE_PROVIDER: "github",
      GH_TOKEN: token,
      DX_THREAD_ID: "thr_00000000-0000-4000-8000-000000000116",
      DX_REPOSITORY_ID: "7116",
      DX_REPOSITORY_NAME: "owner/repository",
      DX_SOURCE_SHA: sourceSha,
      DX_CLONE_URL: "https://github.com/owner/repository.git",
      DX_DEFAULT_BRANCH: "main",
      DX_INSTALLATION_ID: "9116",
      DX_GRANT_ID: "grant-116",
      DX_BINDING_REVISION: "1",
      DX_INVOCATION_ID: crypto.randomUUID(),
      DX_SOURCE_CONFIG_DIGEST: "config-116",
    },
  };
};

const runHarness = (
  fixture: HarnessFixture,
  action: string,
  environment: Record<string, string> = {},
) =>
  spawnSync(process.execPath, [fixture.program, action], {
    encoding: "utf8",
    env: {
      ...fixture.environment,
      DX_INVOCATION_ID: crypto.randomUUID(),
      ...environment,
    },
  });

const initialize = (fixture: HarnessFixture) => {
  const result = runHarness(fixture, "initialize");
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ status: "ready" });
};

const checkoutState = (
  fixture: HarnessFixture,
  environment: Record<string, string> = {},
) => {
  const result = runHarness(fixture, "snapshot", environment);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
};

const hooksState = (
  fixture: HarnessFixture,
  environment: Record<string, string> = {},
) => {
  const result = runHarness(fixture, "hooks", environment);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
};

const activationState = (
  fixture: HarnessFixture,
  environment: Record<string, string> = {},
) => {
  const result = runHarness(fixture, "activate", {
    DX_ALLOW_COMBINED_HOOKS: "true",
    ...environment,
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
};

const allRegularFileContents = (root: string): string => {
  const contents: string[] = [];
  const visit = (path: string) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      contents.push(readFileSync(path, "utf8"));
      return;
    }
    if (stat.isDirectory())
      for (const entry of readdirSync(path)) visit(join(path, entry));
  };
  visit(root);
  return contents.join("\n");
};

describe("dx Git credential helper", () => {
  it("serves a Bitbucket lease only for the exact gateway repository", async () => {
    const lease = "opaque-dx-lease";
    const environment = {
      DX_SOURCE_PROVIDER: "bitbucket",
      DX_BITBUCKET_GIT_TOKEN: lease,
      DX_BITBUCKET_GIT_ORIGIN: "https://core.dx.example",
      DX_BITBUCKET_GIT_PATH: "/api/source/bitbucket/git",
      DX_GIT_ALLOWED_PATH: "owner/repository",
      GH_TOKEN: "oauth-must-not-be-used",
    };
    const accepted = await invokeHelper(
      "get",
      "protocol=https\nhost=core.dx.example\npath=api/source/bitbucket/git/owner/repository.git\n\n",
      environment,
    );
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toBe(`username=dx\npassword=${lease}\n\n`);
    expect(accepted.stdout).not.toContain("oauth-must-not-be-used");
    const withGitAttributes = await invokeHelper(
      "get",
      'capability[]=authtype\ncapability[]=state\nprotocol=https\nhost=core.dx.example\npath=api/source/bitbucket/git/owner/repository.git\nwwwauth[]=Basic realm="dx"\n\n',
      environment,
    );
    expect(withGitAttributes.status).toBe(0);
    expect(withGitAttributes.stdout).toBe(`username=dx\npassword=${lease}\n\n`);
    for (const input of [
      "protocol=https\nhost=bitbucket.org\npath=owner/repository.git\n\n",
      "protocol=https\nhost=core.dx.example\npath=api/source/bitbucket/git/owner/other.git\n\n",
      "protocol=https\nhost=core.dx.example\npath=api/source/bitbucket/git/owner/repository-extra.git\n\n",
    ]) {
      const rejected = await invokeHelper("get", input, environment);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stdout).toBe("");
    }
  });

  it.each([
    "Owner/Repository",
    "owner/repository.git",
    "OWNER/REPOSITORY.git/info/lfs",
    "/owner/repository/info/lfs/objects/batch",
  ])("serves only the exact approved root path: %s", async (path) => {
    const result = await invokeHelper(
      "get",
      `protocol=https\nhost=github.com\npath=${path}\n\n`,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      `username=x-access-token\npassword=${token}\n\n`,
    );
  });

  it("ignores Git's optional attributes but still refuses duplicate selectors", async () => {
    const accepted = await invokeHelper(
      "get",
      'capability[]=authtype\ncapability[]=state\nprotocol=https\nhost=github.com\npath=owner/repository.git\nwwwauth[]=Basic realm="GitHub"\nwwwauth[]=Bearer\nstate[]=dx\n\n',
    );
    expect(accepted.status).toBe(0);
    expect(accepted.stdout).toBe(
      `username=x-access-token\npassword=${token}\n\n`,
    );
    const duplicate = await invokeHelper(
      "get",
      "protocol=https\nhost=github.com\npath=owner/repository\npath=owner/other\n\n",
    );
    expect(duplicate.status).not.toBe(0);
    expect(duplicate.stdout).toBe("");
  });

  it.each([
    ["store", "protocol=https\nhost=github.com\npath=owner/repository\n"],
    ["erase", "protocol=https\nhost=github.com\npath=owner/repository\n"],
    ["get", "protocol=http\nhost=github.com\npath=owner/repository\n"],
    ["get", "protocol=https\nhost=evil.example\npath=owner/repository\n"],
    ["get", "protocol=https\nhost=github.com.evil\npath=owner/repository\n"],
    ["get", "protocol=https\nhost=github.com\npath=owner/repository-extra\n"],
    ["get", "protocol=https\nhost=github.com\npath=owner/repository/other\n"],
    ["get", "protocol=https\nhost=github.com\npath=owner%2frepository\n"],
    [
      "get",
      "protocol=https\nhost=github.com\npath=owner/repository\nusername=attacker\n",
    ],
    [
      "get",
      "protocol=https\nhost=github.com\npath=owner/repository\npassword=secret\n",
    ],
    ["get", "protocol=https\nhost=github.com\npath=owner/repository\r\n"],
  ])(
    "rejects malformed or overbroad credential requests",
    async (operation, input) => {
      const result = await invokeHelper(operation, input);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
    },
  );

  it("serves through Git's credential fill when Git sends its optional fetch-time attributes", async () => {
    // Git 2.41+ sends wwwauth[] and 2.46+ sends capability[] to helpers during fetch; the
    // standard Orb image's Git 2.47 does both, so rejecting them broke every private checkout.
    const directory = await mkdtemp(join(tmpdir(), "dx-git-fetch-attributes-"));
    const helper = join(directory, "dx-git-credential");
    writeFileSync(helper, gitCredentialHelperProgram, { mode: 0o555 });
    const fill = (input: string) =>
      spawnSync(
        "git",
        [
          "-c",
          "credential.helper=",
          "-c",
          `credential.helper=${helper}`,
          "-c",
          "credential.useHttpPath=true",
          "-c",
          "credential.interactive=false",
          "credential",
          "fill",
        ],
        {
          input,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            DX_SOURCE_PROVIDER: "github",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            GH_TOKEN: token,
            DX_GIT_ALLOWED_PATH: "owner/repository",
          },
        },
      );
    const attributes =
      'capability[]=authtype\ncapability[]=state\nwwwauth[]=Basic realm="GitHub"\n';
    const accepted = fill(
      `${attributes}protocol=https\nhost=github.com\npath=owner/repository.git\n\n`,
    );
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain(`password=${token}`);
    const rejected = fill(
      `${attributes}protocol=https\nhost=github.com\npath=owner/repository-extra.git\n\n`,
    );
    expect(rejected.status).not.toBe(0);
    expect(rejected.stdout + rejected.stderr).not.toContain(token);
  });

  it("works through command-scoped Git credential plumbing only for the exact URL", async () => {
    const directory = await mkdtemp(join(tmpdir(), "dx-git-plumbing-"));
    const helper = join(directory, "dx-git-credential");
    writeFileSync(helper, gitCredentialHelperProgram, { mode: 0o555 });
    const invoke = (url: string) =>
      spawnSync(
        "git",
        [
          "-c",
          "credential.helper=",
          "-c",
          `credential.helper=${helper}`,
          "-c",
          "credential.useHttpPath=true",
          "-c",
          "credential.interactive=false",
          "credential",
          "fill",
        ],
        {
          input: `url=${url}\n\n`,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            DX_SOURCE_PROVIDER: "github",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_SYSTEM: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
            GH_TOKEN: token,
            DX_GIT_ALLOWED_PATH: "owner/repository",
          },
        },
      );
    const accepted = invoke("https://github.com/owner/repository.git");
    expect(accepted.status, accepted.stderr).toBe(0);
    expect(accepted.stdout).toContain(`password=${token}`);
    const acceptedLfs = invoke(
      "https://github.com/owner/repository.git/info/lfs",
    );
    expect(acceptedLfs.status, acceptedLfs.stderr).toBe(0);
    expect(acceptedLfs.stdout).toContain(`password=${token}`);
    for (const url of [
      "https://github.com/owner/repository-extra.git",
      "https://github.com.evil/owner/repository.git",
    ]) {
      const rejected = invoke(url);
      expect(rejected.status).not.toBe(0);
      expect(rejected.stdout + rejected.stderr).not.toContain(token);
    }
  });
});

describe("generated source workspace harness", { timeout: 30000 }, () => {
  it("maps a missing checkout to the snapshot absent JSON state", async () => {
    const fixture = await makeHarness();

    expect(checkoutState(fixture)).toEqual({
      status: "absent",
      modules: [],
      lfsNeeded: false,
      shallow: false,
      fullHistoryNeeded: false,
    });
  });

  it("clones anonymous default HEAD once and reports the finalized identity without credentials", async () => {
    const fixture = await makeHarness({ http: true });
    try {
      const first = runHarness(fixture, "initialize-anonymous", {
        GH_TOKEN: "",
        DX_SOURCE_SHA: "",
        DX_DEFAULT_BRANCH: "",
        DX_REPOSITORY_ID: "",
        DX_INSTALLATION_ID: "",
        DX_GRANT_ID: "",
      });
      expect(first.status, first.stderr).toBe(0);
      expect(JSON.parse(first.stdout)).toEqual({
        sourceRevision: fixture.sourceSha,
        defaultBranch: "main",
        initialRef: "refs/heads/main",
      });
      expect(git(fixture.paths.root, "rev-parse", "HEAD")).toBe(
        fixture.sourceSha,
      );
      expect(git(fixture.paths.root, "remote", "get-url", "origin")).toBe(
        "https://github.com/owner/repository.git",
      );
      const state = JSON.parse(readFileSync(fixture.paths.state, "utf8"));
      expect(state).not.toHaveProperty("grantId");
      expect(state).not.toHaveProperty("installationId");
      expect(state).not.toHaveProperty("repositoryId");
      writeFileSync(join(fixture.paths.root, "local.txt"), "writable\n");
      const retry = runHarness(fixture, "initialize-anonymous", {
        GH_TOKEN: "",
      });
      expect(retry.status, retry.stderr).toBe(0);
      expect(JSON.parse(retry.stdout).sourceRevision).toBe(fixture.sourceSha);
      expect(readFileSync(join(fixture.paths.root, "local.txt"), "utf8")).toBe(
        "writable\n",
      );
      expect(allRegularFileContents(fixture.base)).not.toContain(token);
    } finally {
      await fixture.stop();
    }
  });

  it("clones a host-neutral public URL through the anonymous Git path", async () => {
    const fixture = await makeHarness({ http: true });
    try {
      const result = runHarness(fixture, "initialize-anonymous", {
        DX_SOURCE_PROVIDER: "git",
        DX_REPOSITORY_NAME: "group/team/repository",
        DX_CLONE_URL: "https://git.example.test/group/team/repository.git",
        GH_TOKEN: "",
        DX_SOURCE_SHA: "",
        DX_DEFAULT_BRANCH: "",
        DX_REPOSITORY_ID: "",
        DX_INSTALLATION_ID: "",
        DX_GRANT_ID: "",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        sourceRevision: fixture.sourceSha,
        defaultBranch: "main",
        initialRef: "refs/heads/main",
      });
      expect(git(fixture.paths.root, "remote", "get-url", "origin")).toBe(
        "https://git.example.test/group/team/repository.git",
      );
      expect(allRegularFileContents(fixture.base)).not.toContain(token);
    } finally {
      await fixture.stop();
    }
  });

  it("cleans its owned temporary checkout when anonymous cloning fails", async () => {
    const fixture = await makeHarness();
    rmSync(fixture.paths.fixtureRemote as string, { recursive: true });
    const result = runHarness(fixture, "initialize-anonymous", {
      GH_TOKEN: "",
    });
    expect(result.status).toBe(40);
    expect(result.stdout + result.stderr).not.toContain(token);
    expect(() => lstatSync(fixture.paths.root)).toThrow();
    expect(() => lstatSync(fixture.paths.state)).toThrow();
    expect(
      readdirSync(fixture.paths.workspaceParent).filter((entry) =>
        entry.startsWith(".dx-repo-"),
      ),
    ).toEqual([]);
  });

  it("initializes the exact SHA and canonical origin, then preserves local work", async () => {
    const fixture = await makeHarness();
    initialize(fixture);
    expect(git(fixture.paths.root, "rev-parse", "HEAD")).toBe(
      fixture.sourceSha,
    );
    expect(git(fixture.paths.root, "remote", "get-url", "origin")).toBe(
      "https://github.com/owner/repository.git",
    );
    const gitInode = lstatSync(join(fixture.paths.root, ".git")).ino;
    writeFileSync(join(fixture.paths.root, "README.md"), "local work\n");
    writeFileSync(join(fixture.paths.root, "untracked.txt"), "keep\n");
    expect(checkoutState(fixture)).toMatchObject({
      status: "ready",
      modules: [],
      lfsNeeded: false,
    });
    expect(readFileSync(join(fixture.paths.root, "README.md"), "utf8")).toBe(
      "local work\n",
    );
    expect(
      readFileSync(join(fixture.paths.root, "untracked.txt"), "utf8"),
    ).toBe("keep\n");
    expect(lstatSync(join(fixture.paths.root, ".git")).ino).toBe(gitInode);
    expect(allRegularFileContents(fixture.base)).not.toContain(token);
    expect(
      git(fixture.paths.root, "config", "--local", "--list"),
    ).not.toContain(token);
    expect(lstatSync(fixture.paths.state).size).toBeLessThan(65_536);
  });

  it("uses full history by default and depth one only when enabled", async () => {
    const legacy = await makeHarness();
    initialize(legacy);
    expect(git(legacy.paths.root, "rev-parse", "--is-shallow-repository")).toBe(
      "false",
    );

    const shallow = await makeHarness({ shallowClone: true });
    initialize(shallow);
    expect(
      git(shallow.paths.root, "rev-parse", "--is-shallow-repository"),
    ).toBe("true");
    expect(checkoutState(shallow)).toMatchObject({
      status: "ready",
      shallow: true,
      fullHistoryNeeded: false,
    });
    const remoteRef = git(
      shallow.paths.root,
      "rev-parse",
      "refs/remotes/origin/main",
    );
    const unshallow = runHarness(shallow, "unshallow");
    expect(unshallow.status, unshallow.stderr).toBe(0);
    expect(
      git(shallow.paths.root, "rev-parse", "--is-shallow-repository"),
    ).toBe("false");
    expect(
      git(shallow.paths.root, "rev-parse", "refs/remotes/origin/main"),
    ).toBe(remoteRef);

    const anonymous = await makeHarness({ shallowClone: true });
    initialize(anonymous);
    const anonymousUnshallow = runHarness(anonymous, "unshallow-anonymous", {
      GH_TOKEN: "",
    });
    expect(anonymousUnshallow.status, anonymousUnshallow.stderr).toBe(0);
    expect(
      git(anonymous.paths.root, "rev-parse", "--is-shallow-repository"),
    ).toBe("false");
  });

  it("reports the exact full-history hook directive from a shallow snapshot", async () => {
    const fixture = await makeHarness({
      shallowClone: true,
      requiresFullHistory: true,
    });
    initialize(fixture);
    expect(checkoutState(fixture)).toMatchObject({
      shallow: true,
      fullHistoryNeeded: true,
    });
  });

  it("rejects Bitbucket submodule checkout at the workspace program boundary", async () => {
    const fixture = await makeHarness();
    const bitbucketEnvironment = {
      DX_SOURCE_PROVIDER: "bitbucket",
      DX_CLONE_URL: "https://bitbucket.org/owner/repository.git",
      DX_BITBUCKET_GIT_TOKEN: "opaque-dx-lease",
      DX_BITBUCKET_GIT_ORIGIN: "https://core.dx.example",
      DX_BITBUCKET_GIT_PATH: "/api/source/bitbucket/git",
    };
    const initialized = runHarness(fixture, "initialize", bitbucketEnvironment);
    expect(initialized.status, initialized.stderr).toBe(0);
    writeFileSync(
      join(fixture.paths.root, ".gitmodules"),
      '[submodule "private"]\n\tpath = vendor/private\n\turl = https://bitbucket.org/owner/private.git\n',
    );

    const result = runHarness(fixture, "submodule", {
      ...bitbucketEnvironment,
      DX_SUBMODULE_KEY: "private",
      DX_SUBMODULE_PATH: "vendor/private",
      DX_SUBMODULE_NAME: "owner/private",
    });

    expect(result.status).toBe(40);
    expect(result.stderr).toContain("initialization");
    expect(
      readFileSync(join(fixture.paths.root, ".git", "config"), "utf8"),
    ).not.toContain("submodule.private.url");
  });

  it("serializes concurrent anonymous initialization to one final checkout", async () => {
    const fixture = await makeHarness();
    const launch = () =>
      new Promise<number | null>((resolve) => {
        const child = spawn(
          process.execPath,
          [fixture.program, "initialize-anonymous"],
          {
            env: {
              ...fixture.environment,
              GH_TOKEN: "",
              DX_INVOCATION_ID: crypto.randomUUID(),
            },
            stdio: "ignore",
          },
        );
        child.on("exit", resolve);
      });
    expect(await Promise.all([launch(), launch()])).toEqual([0, 0]);
    expect(existsSync(fixture.lock)).toBe(false);
    expect(git(fixture.paths.root, "rev-parse", "HEAD")).toBe(
      fixture.sourceSha,
    );
    expect(
      readdirSync(fixture.paths.workspaceParent).filter((entry) =>
        entry.startsWith(".dx-repo-"),
      ),
    ).toEqual([]);
  });

  it("recovers only an owned claimed temporary checkout", async () => {
    const fixture = await makeHarness();
    initialize(fixture);
    const state = JSON.parse(readFileSync(fixture.paths.state, "utf8"));
    const owner = crypto.randomUUID();
    const temporary = join(
      fixture.paths.workspaceParent,
      `.dx-repo-${owner}.tmp`,
    );
    renameSync(fixture.paths.root, temporary);
    rmSync(fixture.paths.state);
    writeFileSync(
      fixture.paths.claim,
      `${JSON.stringify({ ...state, invocationId: owner })}\n`,
    );
    writeFileSync(`${temporary}.owner`, owner);
    expect(checkoutState(fixture)).toMatchObject({ status: "ready" });
    expect(git(fixture.paths.root, "rev-parse", "HEAD")).toBe(
      fixture.sourceSha,
    );
  });

  it("runs setup once, retries failure, and resumes on every activation in order", async () => {
    const fixture = await makeHarness();
    initialize(fixture);
    writeFileSync(join(fixture.paths.home, "fail-setup"), "fail\n");
    expect(hooksState(fixture)).toEqual({
      status: "hook-failed",
      hook: "setup",
    });
    const immutableSetup = readFileSync(
      join(fixture.paths.root, ".agents", "setup"),
      "utf8",
    );
    const setupDigest = createHash("sha256")
      .update(`${fixture.sourceSha}\0config-116\0${immutableSetup}`)
      .digest("hex");
    expect(JSON.parse(readFileSync(fixture.paths.state, "utf8")).setup).toEqual(
      { status: "failed", digest: setupDigest },
    );
    rmSync(join(fixture.paths.home, "fail-setup"));
    expect(hooksState(fixture)).toEqual({ status: "ready" });
    expect(hooksState(fixture)).toEqual({ status: "ready" });
    expect(readFileSync(join(fixture.paths.home, "hook-order"), "utf8")).toBe(
      "setup\nresume\nresume\n",
    );
  });

  it("maps a resume hook failure to the hooks JSON state", async () => {
    const fixture = await makeHarness();
    initialize(fixture);
    writeFileSync(
      join(fixture.paths.root, ".agents", "resume"),
      "#!/bin/sh\nexit 7\n",
      { mode: 0o755 },
    );

    expect(hooksState(fixture)).toEqual({
      status: "hook-failed",
      hook: "resume",
    });
  });

  it("runs setup but not resume when a running workspace reconnects", async () => {
    const fixture = await makeHarness();
    initialize(fixture);
    writeFileSync(
      join(fixture.paths.root, ".agents", "resume"),
      "#!/bin/sh\nexit 7\n",
      { mode: 0o755 },
    );

    expect(hooksState(fixture, { DX_RUN_RESUME: "false" })).toEqual({
      status: "ready",
    });
    expect(readFileSync(join(fixture.paths.home, "hook-order"), "utf8")).toBe(
      "setup\n",
    );
  });

  it("verifies checkout and runs ordered hooks in one activation", async () => {
    const fixture = await makeHarness();
    initialize(fixture);

    expect(activationState(fixture)).toEqual({
      checkout: {
        status: "ready",
        modules: [],
        lfsNeeded: false,
        shallow: false,
        fullHistoryNeeded: false,
      },
      hooks: { status: "ready" },
    });
    expect(readFileSync(join(fixture.paths.home, "hook-order"), "utf8")).toBe(
      "setup\nresume\n",
    );
  });

  it("does not run hooks in combined activation when source preparation remains", async () => {
    const fixture = await makeHarness({ lfsAttributes: true });
    initialize(fixture);

    expect(activationState(fixture)).toMatchObject({
      checkout: { status: "ready", lfsNeeded: true },
    });
    expect(() =>
      readFileSync(join(fixture.paths.home, "hook-order"), "utf8"),
    ).toThrow();
  });

  it.each([
    "root",
    "workspace-parent",
    "state-parent",
    "state",
    "claim",
    "git",
    "git-file",
    "agents",
    "setup",
    "resume",
    "logs",
    "log-file",
    "helper",
  ])(
    "rejects a %s symlink without modifying its outside target",
    async (kind) => {
      const fixture = await makeHarness();
      const outsideFile = join(fixture.outside, "sentinel");
      writeFileSync(outsideFile, "untouched\n");
      let action = "snapshot";
      if (kind === "root") {
        symlinkSync(fixture.outside, fixture.paths.root);
      } else if (kind === "workspace-parent") {
        rmSync(fixture.paths.workspaceParent, { recursive: true });
        symlinkSync(fixture.outside, fixture.paths.workspaceParent);
      } else if (kind === "state-parent") {
        symlinkSync(fixture.outside, dirname(fixture.paths.state));
      } else if (kind === "claim") {
        mkdirSync(dirname(fixture.paths.claim));
        symlinkSync(outsideFile, fixture.paths.claim);
      } else {
        initialize(fixture);
        if (kind === "state") {
          rmSync(fixture.paths.state);
          symlinkSync(outsideFile, fixture.paths.state);
        } else if (kind === "git" || kind === "git-file") {
          rmSync(join(fixture.paths.root, ".git"), { recursive: true });
          if (kind === "git")
            symlinkSync(fixture.outside, join(fixture.paths.root, ".git"));
          else
            writeFileSync(
              join(fixture.paths.root, ".git"),
              `gitdir: ${fixture.outside}\n`,
            );
        } else if (kind === "agents") {
          rmSync(join(fixture.paths.root, ".agents"), { recursive: true });
          symlinkSync(fixture.outside, join(fixture.paths.root, ".agents"));
          action = "hooks";
        } else if (kind === "setup" || kind === "resume") {
          rmSync(join(fixture.paths.root, ".agents", kind));
          symlinkSync(outsideFile, join(fixture.paths.root, ".agents", kind));
          action = "hooks";
        } else if (kind === "logs") {
          symlinkSync(fixture.outside, fixture.paths.logDirectory);
          action = "hooks";
        } else if (kind === "log-file") {
          mkdirSync(fixture.paths.logDirectory);
          symlinkSync(
            outsideFile,
            join(fixture.paths.logDirectory, "setup.log"),
          );
          action = "hooks";
        } else {
          rmSync(fixture.paths.helper);
          symlinkSync(outsideFile, fixture.paths.helper);
        }
      }
      const result = runHarness(fixture, action);
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "conflict" });
      expect(readFileSync(outsideFile, "utf8")).toBe("untouched\n");
    },
  );

  it("rejects wrong marker, origin, and SHA identities without resetting files", async () => {
    for (const mutate of [
      (fixture: HarnessFixture) => {
        const state = JSON.parse(readFileSync(fixture.paths.state, "utf8"));
        writeFileSync(
          fixture.paths.state,
          `${JSON.stringify({ ...state, repositoryName: "wrong/repository" })}\n`,
        );
      },
      (fixture: HarnessFixture) =>
        git(
          fixture.paths.root,
          "remote",
          "set-url",
          "origin",
          "https://github.com/owner/wrong.git",
        ),
    ]) {
      const fixture = await makeHarness();
      initialize(fixture);
      writeFileSync(join(fixture.paths.root, "local.txt"), "preserved\n");
      mutate(fixture);
      expect(checkoutState(fixture)).toMatchObject({ status: "conflict" });
      expect(readFileSync(join(fixture.paths.root, "local.txt"), "utf8")).toBe(
        "preserved\n",
      );
    }
    const fixture = await makeHarness();
    initialize(fixture);
    expect(
      checkoutState(fixture, { DX_SOURCE_SHA: "b".repeat(40) }),
    ).toMatchObject({ status: "conflict" });
  });

  it("accepts the expected source SHA as an ancestor after local commits", async () => {
    const fixture = await makeHarness();
    initialize(fixture);
    git(fixture.paths.root, "config", "user.email", "fixture@example.test");
    git(fixture.paths.root, "config", "user.name", "Fixture");
    git(fixture.paths.root, "config", "commit.gpgsign", "false");
    writeFileSync(join(fixture.paths.root, "local.txt"), "local commit\n");
    git(fixture.paths.root, "add", "local.txt");
    git(fixture.paths.root, "commit", "-m", "local change");

    expect(checkoutState(fixture)).toMatchObject({ status: "ready" });
  });

  it("rejects oversized state and symlinked ownership markers", async () => {
    const oversized = await makeHarness();
    initialize(oversized);
    writeFileSync(oversized.paths.state, "x".repeat(65_537));
    expect(checkoutState(oversized)).toMatchObject({ status: "conflict" });

    const fixture = await makeHarness();
    initialize(fixture);
    const state = JSON.parse(readFileSync(fixture.paths.state, "utf8"));
    const owner = crypto.randomUUID();
    const temporary = join(
      fixture.paths.workspaceParent,
      `.dx-repo-${owner}.tmp`,
    );
    renameSync(fixture.paths.root, temporary);
    rmSync(fixture.paths.state);
    writeFileSync(
      fixture.paths.claim,
      `${JSON.stringify({ ...state, invocationId: owner })}\n`,
    );
    const outsideFile = join(fixture.outside, "sentinel");
    writeFileSync(outsideFile, owner);
    symlinkSync(outsideFile, `${temporary}.owner`);
    expect(checkoutState(fixture)).toMatchObject({ status: "conflict" });
    expect(readFileSync(outsideFile, "utf8")).toBe(owner);
  });

  it("does not substitute a current tip when the exact SHA is unavailable", async () => {
    const fixture = await makeHarness();
    const result = runHarness(fixture, "initialize", {
      DX_SOURCE_SHA: "b".repeat(40),
    });
    expect(result.status).toBe(40);
    expect(result.stdout + result.stderr).not.toContain(token);
    expect(() => lstatSync(fixture.paths.root)).toThrow();
    expect(() => lstatSync(fixture.paths.state)).toThrow();
  });

  it("detects root LFS configuration without invoking unavailable git-lfs", async () => {
    const fixture = await makeHarness({ lfsAttributes: true });
    initialize(fixture);
    expect(checkoutState(fixture)).toMatchObject({
      status: "ready",
      lfsNeeded: true,
    });
  });
});

describe("template source asset verifier", () => {
  it("runs activation only after verifying the exact source program digest", async () => {
    const fixture = await makeHarness();
    initialize(fixture);
    const digest = (path: string) =>
      createHash("sha256").update(readFileSync(path)).digest("hex");
    const run = (programDigest: string) =>
      spawnSync(
        "flock",
        [
          "-x",
          `${fixture.lock}.outer`,
          process.execPath,
          "-e",
          assetVerifierProgram,
        ],
        {
          encoding: "utf8",
          env: {
            ...fixture.environment,
            DX_ASSET_HELPER_PATH: fixture.paths.helper,
            DX_ASSET_PROGRAM_PATH: fixture.program,
            DX_ASSET_HELPER_DIGEST: digest(fixture.paths.helper),
            DX_ASSET_PROGRAM_DIGEST: programDigest,
            DX_ASSET_STATE_DIRECTORY: dirname(fixture.paths.state),
            DX_ASSET_TOOLS: "[]",
            DX_ASSET_TOOL_CONTRACT: "{}",
            DX_ASSET_ACTION: "activate",
            DX_ASSET_ACTION_TIMEOUT_MS: "660000",
            DX_ALLOW_COMBINED_HOOKS: "true",
          },
        },
      );

    const fresh = run(digest(fixture.program));
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(JSON.parse(fresh.stdout)).toMatchObject({
      assets: "fresh",
      operation: {
        exitCode: 0,
        stderr: "",
        stdout: expect.stringContaining('"hooks":{"status":"ready"}'),
      },
    });
    expect(readFileSync(join(fixture.paths.home, "hook-order"), "utf8")).toBe(
      "setup\nresume\n",
    );

    rmSync(join(fixture.paths.home, "hook-order"));
    const stale = run("0".repeat(64));
    expect(stale.status, stale.stderr).toBe(42);
    expect(JSON.parse(stale.stdout)).toEqual({ assets: "stale", tools: [] });
    expect(() =>
      readFileSync(join(fixture.paths.home, "hook-order"), "utf8"),
    ).toThrow();
  });

  it("reports one JSON verdict and identifies a baked asset digest mismatch", async () => {
    const root = await mkdtemp(join(tmpdir(), "dx-asset-verifier-"));
    const helper = join(root, "helper");
    const program = join(root, "program");
    writeFileSync(helper, "helper\n", { mode: 0o555 });
    writeFileSync(program, "program\n", { mode: 0o555 });
    const digest = (path: string) =>
      createHash("sha256").update(readFileSync(path)).digest("hex");
    const environment = {
      ...process.env,
      DX_ASSET_HELPER_PATH: helper,
      DX_ASSET_PROGRAM_PATH: program,
      DX_ASSET_HELPER_DIGEST: digest(helper),
      DX_ASSET_PROGRAM_DIGEST: digest(program),
      DX_ASSET_STATE_DIRECTORY: root,
      DX_ASSET_TOOLS: "[]",
      DX_ASSET_TOOL_CONTRACT: "{}",
    };
    const fresh = spawnSync(process.execPath, ["-e", assetVerifierProgram], {
      encoding: "utf8",
      env: environment,
    });
    expect(fresh.status, fresh.stderr).toBe(0);
    expect(JSON.parse(fresh.stdout)).toEqual({ assets: "fresh", tools: [] });

    chmodSync(helper, 0o600);
    const helperNotExecutable = spawnSync(
      process.execPath,
      ["-e", assetVerifierProgram],
      { encoding: "utf8", env: environment },
    );
    expect(helperNotExecutable.status, helperNotExecutable.stderr).toBe(42);
    chmodSync(helper, 0o555);

    const missingStateDirectory = spawnSync(
      process.execPath,
      ["-e", assetVerifierProgram],
      {
        encoding: "utf8",
        env: {
          ...environment,
          DX_ASSET_STATE_DIRECTORY: join(root, "missing"),
        },
      },
    );
    expect(missingStateDirectory.status, missingStateDirectory.stderr).toBe(42);

    chmodSync(program, 0o700);
    writeFileSync(program, "drifted\n", { mode: 0o555 });
    const stale = spawnSync(process.execPath, ["-e", assetVerifierProgram], {
      encoding: "utf8",
      env: environment,
    });
    expect(stale.status, stale.stderr).toBe(42);
    expect(JSON.parse(stale.stdout)).toEqual({ assets: "stale", tools: [] });
  });
});

describe("atomic source asset installer", () => {
  it("atomically replaces final symlinks without writing through them", async () => {
    const base = realpathSync(
      await mkdtemp(join(tmpdir(), "dx-asset-installer-")),
    );
    const parent = join(base, "libexec");
    const outside = join(base, "outside");
    mkdirSync(parent);
    writeFileSync(outside, "untouched\n");
    const helper = join(parent, "helper");
    const program = join(parent, "program");
    const helperTemporary = `${helper}.owned.tmp`;
    const programTemporary = `${program}.owned.tmp`;
    const stateDirectory = join(base, "state", "dx");
    symlinkSync(outside, helper);
    symlinkSync(outside, program);
    const run = (mode: string) =>
      spawnSync(
        process.execPath,
        [
          "-e",
          assetInstallerProgram,
          mode,
          helperTemporary,
          helper,
          programTemporary,
          program,
          stateDirectory,
        ],
        { encoding: "utf8" },
      );
    expect(run("prepare").status).toBe(0);
    writeFileSync(helperTemporary, "helper\n");
    writeFileSync(programTemporary, "program\n");
    expect(run("finalize").status).toBe(0);
    expect(readFileSync(outside, "utf8")).toBe("untouched\n");
    expect(readFileSync(helper, "utf8")).toBe("helper\n");
    expect(readFileSync(program, "utf8")).toBe("program\n");
    expect(lstatSync(helper).isSymbolicLink()).toBe(false);
    expect(lstatSync(stateDirectory).isDirectory()).toBe(true);
  });

  it("rejects a symlinked asset parent without touching its target", async () => {
    const base = await mkdtemp(join(tmpdir(), "dx-asset-parent-"));
    const outside = join(base, "outside");
    const linked = join(base, "linked");
    mkdirSync(outside);
    symlinkSync(outside, linked);
    const sentinel = join(outside, "sentinel");
    writeFileSync(sentinel, "untouched\n");
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        assetInstallerProgram,
        "prepare",
        join(linked, "helper.tmp"),
        join(linked, "helper"),
        join(linked, "program.tmp"),
        join(linked, "program"),
        join(base, "state", "dx"),
      ],
      { encoding: "utf8" },
    );
    expect(result.status).not.toBe(0);
    expect(readFileSync(sentinel, "utf8")).toBe("untouched\n");
    expect(readdirSync(outside)).toEqual(["sentinel"]);
  });
});
