import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unpack } from "./pack.js";
import {
  createPublicGitRepositoryReader,
  PublicGitUnreachable,
  readPublicGitTip,
} from "./public-reader.js";

/**
 * The credential-free read of a public repository, against real Git: a smart
 * HTTP server is `git upload-pack --stateless-rpc` behind a fake `fetch`.
 *
 * Ways it could fail, each covered below:
 *   - the advertisement of an empty repository names no tip, or one whose
 *     HEAD is not `main` names the wrong default branch;
 *   - commits come back out of order, past a merge's second parent, or more
 *     than asked;
 *   - a folder resolves through a file, a missing segment, or the wrong tree;
 *     symlinks and submodules are listed as files;
 *   - a pack's offset or reference deltas resolve to the wrong bytes;
 *   - the server refusing (`ERR`), an HTTP error, or an oversized answer
 *     reads as an empty listing instead of a failure.
 */

let root: string;
let repository: string;
let empty: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Ada Lovelace",
      GIT_AUTHOR_EMAIL: "ada@example.test",
      GIT_COMMITTER_NAME: "Ada Lovelace",
      GIT_COMMITTER_EMAIL: "ada@example.test",
    },
  }).trim();

const commitAll = (message: string, date: string) => {
  git(repository, "add", "-A");
  execFileSync("git", ["commit", "-q", "-m", message], {
    cwd: repository,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Ada Lovelace",
      GIT_AUTHOR_EMAIL: "ada@example.test",
      GIT_COMMITTER_NAME: "Ada Lovelace",
      GIT_COMMITTER_EMAIL: "ada@example.test",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
};

/** `git upload-pack` as a smart HTTP server for `directories` by URL. */
const smartHttp =
  (
    directories: Record<string, string>,
    override?: (url: string) => Response | undefined,
    /** Off is a server without partial clones, as git.kernel.org runs. */
    server: {
      readonly filter?: boolean;
      readonly serviceNewline?: boolean;
    } = {},
  ): typeof fetch =>
  async (input, init) => {
    const url = String(input);
    const answered = override?.(url);
    if (answered !== undefined) return answered;
    const entry = Object.entries(directories).find(([prefix]) =>
      url.startsWith(prefix),
    );
    if (entry === undefined) return new Response("Not Found", { status: 404 });
    const [, directory] = entry;
    if (url.endsWith("/info/refs?service=git-upload-pack")) {
      const refs = execFileSync("git", [
        "-c",
        `uploadpack.allowFilter=${server.filter ?? true}`,
        "upload-pack",
        "--stateless-rpc",
        "--advertise-refs",
        directory,
      ]);
      return new Response(
        Buffer.concat([
          Buffer.from(
            // Bitbucket sends the service line without its newline.
            server.serviceNewline === false
              ? "001d# service=git-upload-pack0000"
              : "001e# service=git-upload-pack\n0000",
          ),
          refs,
        ]),
      );
    }
    if (url.endsWith("/git-upload-pack") && init?.method === "POST") {
      const result = spawnSync(
        "git",
        [
          "-c",
          `uploadpack.allowFilter=${server.filter ?? true}`,
          "upload-pack",
          "--stateless-rpc",
          directory,
        ],
        {
          input: Buffer.from(String(init.body)),
          env: { ...process.env, GIT_PROTOCOL: "version=2" },
        },
      );
      return new Response(result.stdout);
    }
    return new Response("Bad Request", { status: 400 });
  };

const URL_BASE = "https://git.example.test/acme/app.git";
const EMPTY_URL = "https://git.example.test/acme/empty.git";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "dx-public-git-"));
  repository = join(root, "app");
  empty = join(root, "empty");
  mkdirSync(repository);
  git(repository, "init", "-q", "-b", "trunk");
  mkdirSync(join(repository, "src", "lib"), { recursive: true });
  writeFileSync(join(repository, "README.md"), "# app\n");
  writeFileSync(join(repository, "src", "index.ts"), "export {};\n");
  commitAll("Initial commit", "2026-10-01T09:00:00Z");
  // A large file edited by every commit packs as deltas of itself.
  const lines = Array.from({ length: 400 }, (_, line) => `line ${line}`);
  writeFileSync(join(repository, "src", "big.txt"), `${lines.join("\n")}\n`);
  for (let index = 1; index <= 4; index += 1) {
    lines[index * 50] = `edited by part ${index}`;
    writeFileSync(join(repository, "src", "big.txt"), `${lines.join("\n")}\n`);
    writeFileSync(
      join(repository, "src", "lib", `part-${index}.ts`),
      `${index}\n`,
    );
    commitAll(
      `Add part ${index}\n\nBody ${index}.`,
      `2026-10-0${index + 1}T09:00:00Z`,
    );
  }
  git(repository, "checkout", "-q", "-b", "side");
  writeFileSync(join(repository, "side.txt"), "side\n");
  commitAll("Side work", "2026-10-07T09:00:00Z");
  git(repository, "checkout", "-q", "trunk");
  writeFileSync(join(repository, "CHANGELOG.md"), "1.0\n");
  commitAll("Write the changelog", "2026-10-08T09:00:00Z");
  execFileSync("git", ["merge", "-q", "--no-ff", "-m", "Merge side", "side"], {
    cwd: repository,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Grace Hopper",
      GIT_AUTHOR_EMAIL: "grace@example.test",
      GIT_COMMITTER_NAME: "Grace Hopper",
      GIT_COMMITTER_EMAIL: "grace@example.test",
      GIT_AUTHOR_DATE: "2026-10-09T09:00:00Z",
      GIT_COMMITTER_DATE: "2026-10-09T09:00:00Z",
    },
  });
  symlinkSync("README.md", join(repository, "readme-link"));
  commitAll("Link the readme", "2026-10-10T09:00:00Z");
  mkdirSync(empty);
  git(empty, "init", "-q", "--bare", "-b", "main");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const readerFor = async (fetcher: typeof fetch) => {
  const tip = await readPublicGitTip(URL_BASE, fetcher);
  if (tip.head === undefined) throw new Error("no tip");
  return createPublicGitRepositoryReader({
    cloneUrl: URL_BASE,
    fullName: "acme/app",
    webUrl: "https://github.com/acme/app",
    tip: { ...tip, head: tip.head },
    fetcher,
  });
};

describe("public Git repository over smart HTTP", () => {
  it("reads the default branch and tip, and an empty repository's lack of one", async () => {
    const fetcher = smartHttp({ [URL_BASE]: repository, [EMPTY_URL]: empty });
    expect(await readPublicGitTip(URL_BASE, fetcher)).toEqual({
      head: git(repository, "rev-parse", "HEAD"),
      defaultBranch: "trunk",
      filter: true,
    });
    expect((await readPublicGitTip(EMPTY_URL, fetcher)).head).toBeUndefined();
    await expect(
      readPublicGitTip("https://git.example.test/acme/missing.git", fetcher),
    ).rejects.toBeInstanceOf(PublicGitUnreachable);
  });

  it("lists the newest commits along the first parent, newest first", async () => {
    const reader = await readerFor(smartHttp({ [URL_BASE]: repository }));
    const commits = await reader.commits(5);
    expect(
      commits.map(({ subject, authorName }) => [subject, authorName]),
    ).toEqual([
      ["Link the readme", "Ada Lovelace"],
      ["Merge side", "Grace Hopper"],
      ["Write the changelog", "Ada Lovelace"],
      ["Add part 4", "Ada Lovelace"],
      ["Add part 3", "Ada Lovelace"],
    ]);
    expect(commits[0]).toEqual({
      sha: git(repository, "rev-parse", "HEAD"),
      subject: "Link the readme",
      authorName: "Ada Lovelace",
      committedAt: new Date("2026-10-10T09:00:00Z"),
      url: `https://github.com/acme/app/commit/${git(repository, "rev-parse", "HEAD")}`,
    });
  });

  it("lists the root and nested folders with kinds and host links, and refuses files and missing paths", async () => {
    const reader = await readerFor(smartHttp({ [URL_BASE]: repository }));
    const rootListing = await reader.directory("");
    expect(
      rootListing?.entries.map(({ name, path, kind, url }) => ({
        name,
        path,
        kind,
        url,
      })),
    ).toEqual([
      {
        name: "CHANGELOG.md",
        path: "CHANGELOG.md",
        kind: "file",
        url: "https://github.com/acme/app/blob/trunk/CHANGELOG.md",
      },
      {
        name: "README.md",
        path: "README.md",
        kind: "file",
        url: "https://github.com/acme/app/blob/trunk/README.md",
      },
      {
        name: "readme-link",
        path: "readme-link",
        kind: "symlink",
        url: "https://github.com/acme/app/blob/trunk/readme-link",
      },
      {
        name: "side.txt",
        path: "side.txt",
        kind: "file",
        url: "https://github.com/acme/app/blob/trunk/side.txt",
      },
      {
        name: "src",
        path: "src",
        kind: "directory",
        url: "https://github.com/acme/app/tree/trunk/src",
      },
    ]);
    expect(
      (await reader.directory("src/lib"))?.entries.map(({ path }) => path),
    ).toEqual([
      "src/lib/part-1.ts",
      "src/lib/part-2.ts",
      "src/lib/part-3.ts",
      "src/lib/part-4.ts",
    ]);
    expect(await reader.directory("README.md")).toBeUndefined();
    expect(await reader.directory("src/missing")).toBeUndefined();
    expect(await reader.directory("src/index.ts/deeper")).toBeUndefined();
    expect(reader.commitsUrl(await reader.repository())).toBe(
      "https://github.com/acme/app/commits/trunk",
    );
  });

  it("resolves offset and reference deltas to the objects Git holds", () => {
    for (const offsets of [true, false]) {
      const objects = git(repository, "rev-list", "--objects", "--all")
        .split("\n")
        .map((line) => line.split(" ")[0]);
      const pack = spawnSync(
        "git",
        [
          "pack-objects",
          "--stdout",
          "--window=50",
          offsets ? "--delta-base-offset" : "--no-reuse-delta",
        ],
        { cwd: repository, input: `${objects.join("\n")}\n` },
      ).stdout;
      // The pack really holds deltas of the kind under test.
      const base = join(root, `deltas-${offsets}`);
      spawnSync(
        "git",
        [
          "pack-objects",
          "--window=50",
          offsets ? "--delta-base-offset" : "--no-reuse-delta",
          base,
        ],
        { cwd: repository, input: `${objects.join("\n")}\n` },
      );
      const verified = execFileSync(
        "sh",
        ["-c", `git verify-pack -v ${base}-*.idx`],
        { cwd: repository, encoding: "utf8" },
      );
      expect(verified).toMatch(
        /^[0-9a-f]{40} blob +\d+ \d+ \d+ \d+ [0-9a-f]{40}$/m,
      );
      const unpacked = unpack(new Uint8Array(pack));
      expect(unpacked.size).toBe(objects.length);
      for (const id of objects) {
        const object = unpacked.get(id ?? "");
        expect(object?.type).toBe(git(repository, "cat-file", "-t", id ?? ""));
        const expected: Buffer = execFileSync(
          "git",
          ["cat-file", object?.type ?? "blob", id ?? ""],
          { cwd: repository },
        );
        expect(Buffer.from(object?.data ?? []).equals(expected)).toBe(true);
      }
    }
    // It runs git once per object: about 1.5 s alone, past 5 s when a full
    // verify loads every core.
  }, 20_000);

  it("reads a server without partial clones with one shallow fetch", async () => {
    const requests: string[] = [];
    const server = smartHttp({ [URL_BASE]: repository }, undefined, {
      filter: false,
    });
    const fetcher: typeof fetch = (input, init) => {
      if (init?.method === "POST") requests.push(String(init.body));
      return server(input, init);
    };
    const tip = await readPublicGitTip(URL_BASE, fetcher);
    expect(tip.filter).toBe(false);
    const reader = await readerFor(fetcher);
    const [commits, listing] = await Promise.all([
      reader.commits(5),
      reader.directory("src/lib"),
    ]);
    expect(commits.map(({ subject }) => subject)).toEqual([
      "Link the readme",
      "Merge side",
      "Write the changelog",
      "Add part 4",
      "Add part 3",
    ]);
    expect(listing?.entries.map(({ name }) => name)).toEqual([
      "part-1.ts",
      "part-2.ts",
      "part-3.ts",
      "part-4.ts",
    ]);
    // One fetch, and it asks for no filter the server would refuse.
    expect(requests).toHaveLength(1);
    expect(requests[0]).not.toContain("filter");
  });

  it("reads Bitbucket's advertisement, which has no newline after the service line", async () => {
    const fetcher = smartHttp({ [URL_BASE]: repository }, undefined, {
      serviceNewline: false,
    });
    expect(await readPublicGitTip(URL_BASE, fetcher)).toEqual({
      head: git(repository, "rev-parse", "HEAD"),
      defaultBranch: "trunk",
      filter: true,
    });
  });

  it("fails, rather than listing nothing, when the server refuses or errs", async () => {
    const refusing = await readerFor(
      smartHttp({ [URL_BASE]: repository }, (url) =>
        url.endsWith("/git-upload-pack")
          ? new Response("0026ERR filter 'combine' not supported")
          : undefined,
      ),
    );
    await expect(refusing.commits(5)).rejects.toBeInstanceOf(
      PublicGitUnreachable,
    );
    await expect(refusing.directory("")).rejects.toBeInstanceOf(
      PublicGitUnreachable,
    );
    const failing = await readerFor(
      smartHttp({ [URL_BASE]: repository }, (url) =>
        url.endsWith("/git-upload-pack")
          ? new Response("busy", { status: 503 })
          : undefined,
      ),
    );
    await expect(failing.directory("")).rejects.toMatchObject({
      reason: "unreachable",
    });
  });
});
