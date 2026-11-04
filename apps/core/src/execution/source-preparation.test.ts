import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../http/types.js";
import { executionWorkspaceLogger } from "../logging.js";
import { sourceAccessDenied } from "../source-control/authority.js";
import { takeAdditionalRepositoryNote } from "./additional-repository-note.js";
import {
  additionalRepositoryDirectories,
  cloneAdditionalRepositories,
  ensureGithubCliWrapper,
} from "./source-preparation.js";

const rows = [
  {
    provider: "github",
    full_name: "acme/api",
    clone_url: "https://github.com/acme/api.git",
    owner_user_id: "user-1",
  },
  {
    provider: "git",
    full_name: "group/sub/api",
    clone_url: "https://git.example.test/group/sub/api.git",
    owner_user_id: "user-1",
  },
  {
    provider: "github",
    full_name: "acme/web",
    clone_url: "https://github.com/acme/web.git",
    owner_user_id: "user-1",
  },
  {
    provider: "bitbucket",
    full_name: "team/lib",
    clone_url: "https://bitbucket.org/team/lib.git",
    owner_user_id: "user-1",
  },
];

const fakeDb = (results: ReadonlyArray<unknown>) =>
  ({
    prepare: () => ({
      bind: () => ({ all: async () => ({ results }) }),
    }),
  }) as unknown as D1Database;

const recordingSandbox = (present: ReadonlySet<string>, failing = "") => {
  const clones: Array<Record<string, string>> = [];
  return {
    clones,
    commands: {
      run: async (
        command: string,
        options: { readonly envs: Record<string, string> },
      ) => {
        const directory = options.envs.DX_REPOSITORY_DIRECTORY ?? "";
        if (command.startsWith("if test -e"))
          return { stdout: present.has(directory) ? "present\n" : "absent\n" };
        clones.push(options.envs);
        if (directory === failing) throw new Error("exit status 128");
        return { exitCode: 0, stdout: "" };
      },
    },
  };
};

describe("additional repositories", () => {
  it("names directories by repository, qualifying shared names", () => {
    expect(
      additionalRepositoryDirectories([
        "acme/api",
        "group/sub/api",
        "acme/web",
      ]),
    ).toEqual(["acme-api", "group-sub-api", "web"]);
  });

  it("clones missing repositories on behalf of the Thread owner", async () => {
    const sandbox = recordingSandbox(new Set(["web"]), "group-sub-api");
    const tokenRequests: Array<string> = [];
    await cloneAdditionalRepositories(
      {} as Bindings,
      fakeDb(rows),
      "thr_1",
      sandbox,
      async (provider, userId) => {
        tokenRequests.push(`${provider}:${userId}`);
        return `${provider}-token`;
      },
    );
    // The existing directory is left untouched; the failing clone does not
    // stop activation.
    expect(sandbox.clones.map((env) => env.DX_REPOSITORY_DIRECTORY)).toEqual([
      "acme-api",
      "group-sub-api",
      "lib",
    ]);
    // One token per provider, reused across that provider's repositories.
    expect(tokenRequests).toEqual(["github:user-1", "bitbucket:user-1"]);
    expect(sandbox.clones[0]).toMatchObject({
      DX_REPOSITORIES_ROOT: "/home/user/workspace/repos",
      DX_CLONE_URL: "https://github.com/acme/api.git",
      DX_SOURCE_PROVIDER: "github",
      DX_GIT_ALLOWED_PATH: "acme/api",
      GH_TOKEN: "github-token",
    });
    // A non-GitHub repository never receives the owner's GitHub credential.
    expect(sandbox.clones[1]).not.toHaveProperty("GH_TOKEN");
    expect(sandbox.clones[1]).toMatchObject({
      DX_CLONE_URL: "https://git.example.test/group/sub/api.git",
    });
    expect(sandbox.clones[1]).not.toHaveProperty("GIT_CONFIG_COUNT");
    // Bitbucket receives the owner's token for exactly this repository.
    expect(sandbox.clones[2]).not.toHaveProperty("GH_TOKEN");
    expect(sandbox.clones[2]).toMatchObject({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://bitbucket.org/team/lib.git.extraHeader",
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa("x-token-auth:bitbucket-token")}`,
    });
  });

  it("clones anonymously when the owner has not connected the provider", async () => {
    const sandbox = recordingSandbox(new Set());
    await cloneAdditionalRepositories(
      {} as Bindings,
      fakeDb([rows[0], rows[3]]),
      "thr_1",
      sandbox,
      async () => {
        throw new Error("Provider is not connected.");
      },
    );
    expect(sandbox.clones).toHaveLength(2);
    for (const clone of sandbox.clones) {
      expect(clone).not.toHaveProperty("GH_TOKEN");
      expect(clone).not.toHaveProperty("GIT_CONFIG_COUNT");
    }
  });
});

describe("GitHub CLI wrapper installation", () => {
  it("logs the exit code and a bounded stderr tail when the install command fails", async () => {
    const warn = vi
      .spyOn(executionWorkspaceLogger, "warn")
      .mockImplementation(() => {});
    const db = {
      prepare: () => ({
        bind: () => ({ first: async () => ({ connected: 1 }) }),
      }),
    } as unknown as D1Database;
    const stderr = `${"x".repeat(4_000)}\nmktemp: failed to create file via template '/home/user/.local/bin/.gh.XXXXXX': Permission denied\n`;
    try {
      await ensureGithubCliWrapper(db, "thr_wrapper", {
        commands: {
          run: async () => ({ exitCode: 1, stdout: "", stderr }),
        },
      });
      expect(warn).toHaveBeenCalledOnce();
      const [message, properties] = warn.mock.calls[0] as unknown as [
        string,
        Record<string, unknown>,
      ];
      expect(message).toBe("GitHub CLI wrapper installation failed.");
      expect(properties).toMatchObject({
        event: "github_cli_wrapper",
        threadId: "thr_wrapper",
        exitCode: 1,
      });
      const tail = properties.stderrTail as string;
      expect(tail).toContain(
        "mktemp: failed to create file via template '/home/user/.local/bin/.gh.XXXXXX': Permission denied",
      );
      expect(tail.length).toBeLessThanOrEqual(1_000);
    } finally {
      warn.mockRestore();
    }
  });
});

// The real clone command, run by bash against a local Git server. The runner
// stands in for the Orb provider: it kills the command at its timeout and
// throws the provider's message, as E2B does.
describe("additional repository clone failures", { timeout: 30_000 }, () => {
  const hermetic = {
    PATH: process.env.PATH ?? "",
    HOME: tmpdir(),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const git = (args: ReadonlyArray<string>, cwd?: string) => {
    const result = spawnSync("git", args, {
      cwd,
      env: {
        ...hermetic,
        GIT_AUTHOR_NAME: "dx",
        GIT_AUTHOR_EMAIL: "dx@example.test",
        GIT_COMMITTER_NAME: "dx",
        GIT_COMMITTER_EMAIL: "dx@example.test",
      },
      encoding: "utf8",
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const shellSandbox = (root: string, capMs = 20_000) => ({
    commands: {
      run: (
        command: string,
        options: {
          readonly envs: Record<string, string>;
          readonly timeoutMs: number;
        },
      ) =>
        new Promise<{ exitCode?: number; stdout?: string }>(
          (resolve, reject) => {
            const child = spawn("bash", ["-c", command], {
              env: {
                ...hermetic,
                ...options.envs,
                DX_REPOSITORIES_ROOT: root,
                DX_CLONE_STALL_SECONDS: "2",
              },
            });
            let stdout = "";
            child.stdout.on("data", (chunk) => {
              stdout += String(chunk);
            });
            const timer = setTimeout(
              () => {
                child.kill("SIGKILL");
                reject(
                  new Error(
                    `Command timed out after ${String(options.timeoutMs)} ms.`,
                  ),
                );
              },
              Math.min(options.timeoutMs, capMs),
            );
            child.on("close", (code) => {
              clearTimeout(timer);
              if (code === 0) resolve({ exitCode: 0, stdout });
              else reject(new Error(`exit status ${String(code)}`));
            });
          },
        ),
    },
  });
  /** Serves `root` with `git http-backend`; `intercept` may answer first. */
  const gitServer = async (
    root: string,
    intercept?: (request: IncomingMessage, response: ServerResponse) => boolean,
  ) => {
    const requests: Array<{ url: string; authorization?: string }> = [];
    const server = createServer((request, response) => {
      requests.push({
        url: request.url ?? "",
        ...(request.headers.authorization === undefined
          ? {}
          : { authorization: request.headers.authorization }),
      });
      if (intercept?.(request, response)) return;
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const child = spawn("git", ["http-backend"], {
        env: {
          ...hermetic,
          GIT_PROJECT_ROOT: root,
          GIT_HTTP_EXPORT_ALL: "1",
          PATH_INFO: url.pathname,
          QUERY_STRING: url.search.slice(1),
          REQUEST_METHOD: request.method ?? "GET",
          CONTENT_TYPE: request.headers["content-type"] ?? "",
          HTTP_CONTENT_ENCODING: request.headers["content-encoding"] ?? "",
          GIT_PROTOCOL: String(request.headers["git-protocol"] ?? ""),
        },
      });
      request.pipe(child.stdin);
      const chunks: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.on("close", () => {
        const output = Buffer.concat(chunks);
        const split = output.indexOf("\r\n\r\n");
        const head = output.subarray(0, split).toString();
        let status = 200;
        for (const line of head.split("\r\n")) {
          const [name, ...rest] = line.split(":");
          const value = rest.join(":").trim();
          if (name?.toLowerCase() === "status")
            status = Number(value.split(" ")[0]);
          else if (name) response.setHeader(name, value);
        }
        response.statusCode = status;
        response.end(output.subarray(split + 4));
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as AddressInfo;
    return {
      origin: `http://127.0.0.1:${String(port)}`,
      requests,
      close: () => {
        server.closeAllConnections();
        server.close();
      },
    };
  };
  const fixture = async () => {
    const base = await mkdtemp(join(tmpdir(), "dx-additional-"));
    const served = join(base, "served");
    const work = join(base, "work");
    mkdirSync(join(served, "team"), { recursive: true });
    git(["init", "--quiet", "--bare", join(served, "team", "lib.git")]);
    git(["init", "--quiet", "-b", "main", work]);
    writeFileSync(join(work, "README.md"), "lib\n");
    git(["add", "README.md"], work);
    git(["commit", "--quiet", "-m", "initial"], work);
    git(["push", "--quiet", join(served, "team", "lib.git"), "main"], work);
    git([
      "--git-dir",
      join(served, "team", "lib.git"),
      "symbolic-ref",
      "HEAD",
      "refs/heads/main",
    ]);
    const repositories = join(base, "repos");
    return {
      base,
      served,
      repositories,
      head: git(["rev-parse", "HEAD"], work),
    };
  };
  const bitbucketRow = (origin: string) => ({
    provider: "bitbucket",
    full_name: "team/lib",
    clone_url: `${origin}/team/lib.git`,
    owner_user_id: "user-1",
  });
  const clone = (
    repositories: string,
    origin: string,
    threadId: string,
    token: () => Promise<string>,
  ) =>
    cloneAdditionalRepositories(
      {} as Bindings,
      fakeDb([]),
      threadId,
      shellSandbox(repositories),
      token,
      Promise.resolve([bitbucketRow(origin)]),
    );

  it("clones with the owner's Bitbucket token and leaves the agent no note", async () => {
    const f = await fixture();
    const server = await gitServer(f.served, (request, response) => {
      if (
        request.headers.authorization ===
        `Basic ${btoa("x-token-auth:bitbucket-token")}`
      )
        return false;
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
      response.end();
      return true;
    });
    try {
      await clone(
        f.repositories,
        server.origin,
        "thr_ok",
        async () => "bitbucket-token",
      );
      expect(git(["rev-parse", "HEAD"], join(f.repositories, "lib"))).toBe(
        f.head,
      );
      expect(takeAdditionalRepositoryNote("thr_ok")).toBeUndefined();
    } finally {
      server.close();
    }
  });

  it("stops a stalled Bitbucket clone early and tells the agent which repository failed and why", async () => {
    const f = await fixture();
    // Bitbucket accepts the connection and then sends nothing.
    const server = await gitServer(f.served, () => true);
    const started = Date.now();
    try {
      await clone(
        f.repositories,
        server.origin,
        "thr_stall",
        async () => "bitbucket-token",
      );
    } finally {
      server.close();
    }
    // Two stalled attempts of about two seconds each, not the timeout.
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(server.requests.length).toBe(2);
    expect(existsSync(join(f.repositories, "lib"))).toBe(false);
    const note = takeAdditionalRepositoryNote("thr_stall");
    expect(note).toContain("team/lib");
    expect(note).toContain("Bitbucket");
    expect(note).toContain("~/workspace/repos/lib");
    expect(note).toMatch(/stopped sending data/);
    // Taken once: a later turn gets no stale note.
    expect(takeAdditionalRepositoryNote("thr_stall")).toBeUndefined();
  });

  it("retries a clone whose first attempt stalls", async () => {
    const f = await fixture();
    let stalled = false;
    const server = await gitServer(f.served, () => {
      if (stalled) return false;
      stalled = true;
      return true;
    });
    try {
      await clone(
        f.repositories,
        server.origin,
        "thr_retry",
        async () => "bitbucket-token",
      );
    } finally {
      server.close();
    }
    expect(git(["rev-parse", "HEAD"], join(f.repositories, "lib"))).toBe(
      f.head,
    );
    expect(takeAdditionalRepositoryNote("thr_retry")).toBeUndefined();
  });

  it("names Bitbucket and asks for a reconnect when its authorization is gone", async () => {
    const f = await fixture();
    const server = await gitServer(f.served, (_request, response) => {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
      response.end();
      return true;
    });
    // Another additional repository is already in place.
    mkdirSync(join(f.repositories, "web"), { recursive: true });
    try {
      await cloneAdditionalRepositories(
        {} as Bindings,
        fakeDb([]),
        "thr_auth",
        shellSandbox(f.repositories),
        async () => {
          throw sourceAccessDenied(
            "connection-reauthorization-required",
            "reconnect",
          );
        },
        Promise.resolve([
          bitbucketRow(server.origin),
          {
            provider: "github",
            full_name: "acme/web",
            clone_url: "https://github.com/acme/web.git",
            owner_user_id: "user-1",
          },
        ]),
      );
    } finally {
      server.close();
    }
    const note = takeAdditionalRepositoryNote("thr_auth");
    // The agent is told what is there, so it need not guess.
    expect(note).toContain("~/workspace/repos holds the others: web.");
    expect(note).toContain("team/lib");
    expect(note).toMatch(/reconnect Bitbucket in Settings → Integrations/);
    expect(note).not.toMatch(/connect GitHub/i);
  });
});
