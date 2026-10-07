import { describe, expect, it } from "vitest";
import type { Bindings } from "../http/types.js";
import {
  additionalRepositoryDirectories,
  cloneAdditionalRepositories,
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

  it("does nothing for a Project without additional repositories", async () => {
    const sandbox = recordingSandbox(new Set());
    await cloneAdditionalRepositories(
      {} as Bindings,
      fakeDb([]),
      "thr_1",
      sandbox,
    );
    expect(sandbox.clones).toEqual([]);
  });
});
