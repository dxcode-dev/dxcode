import { observeExternal } from "../../observability/boundaries.js";
import {
  commitSubject,
  encodePath,
  MAX_DIRECTORY_ENTRIES,
  type RepositoryCommit,
  type RepositoryEntry,
  type RepositoryReader,
} from "../repository-reader.js";
import {
  DELIMITER,
  FLUSH,
  fetchResponsePack,
  type GitObject,
  GitWireError,
  packetLine,
  parseCommit,
  parseTree,
  unpack,
} from "./pack.js";

/**
 * A public repository read over Git's smart HTTP protocol, as `git clone`
 * reads it, with no API and no credential: the ref advertisement names the
 * default branch and its tip, and two protocol-v2 fetches run together, one
 * for the newest commits without trees (`filter tree:0`), one for the tip's
 * trees without file contents (`filter blob:none`). GitHub, GitLab, Bitbucket,
 * and Forgejo all serve it, and no REST rate limit counts it.
 */

const USER_AGENT = "git/2.47.0 (dx)";
/** A tip's trees alone stay well under this for all but the largest repositories. */
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const ZERO_SHA = "0".repeat(40);

export class PublicGitUnreachable extends Error {
  constructor(readonly reason: "unreachable" | "too-large" | "malformed") {
    super(`Public Git repository ${reason}`);
    this.name = "PublicGitUnreachable";
  }
}

const repositoryUrl = (cloneUrl: string) => cloneUrl.replace(/\/+$/, "");

/** The bytes of `response`, refusing more than `limit`. */
const readBounded = async (response: Response, limit: number) => {
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new PublicGitUnreachable("too-large");
    }
    chunks.push(part.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

export interface PublicGitTip {
  /** `undefined` for a repository without commits. */
  readonly head: string | undefined;
  readonly defaultBranch: string;
}

/**
 * The default branch and its tip from the smart HTTP ref advertisement. Only
 * its first ref line is read, which carries `HEAD` and its symref.
 */
export const readPublicGitTip = async (
  cloneUrl: string,
  fetcher: typeof fetch,
): Promise<PublicGitTip> => {
  const url = `${repositoryUrl(cloneUrl)}/info/refs?service=git-upload-pack`;
  let response: Response;
  try {
    response = await observeExternal("git", "info-refs", url, () =>
      fetcher(url, {
        headers: { "user-agent": USER_AGENT },
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      }),
    );
  } catch {
    throw new PublicGitUnreachable("unreachable");
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    throw new PublicGitUnreachable("unreachable");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let value = "";
  try {
    while (value.length < 64 * 1024) {
      const part = await reader.read();
      if (part.done) break;
      value += decoder.decode(part.value, { stream: true });
      if (
        /^[0-9a-f]{4}# service=git-upload-pack\n0000(?:0000|[0-9a-f]{4}[^\n]*\n)/.test(
          value,
        )
      ) {
        const line = value.match(
          /^[0-9a-f]{4}# service=git-upload-pack\n0000(?:[0-9a-f]{4}([0-9a-f]{40}) ([^\0\n]+)\0?([^\n]*))?/,
        );
        const sha = line?.[1];
        const branch =
          line?.[3]?.match(/(?:^| )symref=HEAD:refs\/heads\/(\S+)/)?.[1] ??
          "HEAD";
        return sha === undefined || sha === ZERO_SHA
          ? { head: undefined, defaultBranch: branch }
          : { head: sha, defaultBranch: branch };
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  throw new PublicGitUnreachable("malformed");
};

/** Links to a commit, file, folder, and branch history on known hosts. */
const hostLinks = (webUrl: string) => {
  const host = (() => {
    try {
      return new URL(webUrl).hostname;
    } catch {
      return "";
    }
  })();
  const at = (branch: string, path: string) =>
    `${encodePath(branch)}/${encodePath(path)}`;
  if (host === "github.com")
    return {
      commit: (sha: string) => `${webUrl}/commit/${sha}`,
      file: (branch: string, path: string) =>
        `${webUrl}/blob/${at(branch, path)}`,
      folder: (branch: string, path: string) =>
        `${webUrl}/tree/${at(branch, path)}`,
      commits: (branch: string) => `${webUrl}/commits/${encodePath(branch)}`,
    };
  if (host === "gitlab.com")
    return {
      commit: (sha: string) => `${webUrl}/-/commit/${sha}`,
      file: (branch: string, path: string) =>
        `${webUrl}/-/blob/${at(branch, path)}`,
      folder: (branch: string, path: string) =>
        `${webUrl}/-/tree/${at(branch, path)}`,
      commits: (branch: string) => `${webUrl}/-/commits/${encodePath(branch)}`,
    };
  if (host === "bitbucket.org")
    return {
      commit: (sha: string) => `${webUrl}/commits/${sha}`,
      file: (branch: string, path: string) =>
        `${webUrl}/src/${at(branch, path)}`,
      folder: (branch: string, path: string) =>
        `${webUrl}/src/${at(branch, path)}`,
      commits: (branch: string) =>
        `${webUrl}/commits/branch/${encodeURIComponent(branch)}`,
    };
  if (host === "codeberg.org")
    return {
      commit: (sha: string) => `${webUrl}/commit/${sha}`,
      file: (branch: string, path: string) =>
        `${webUrl}/src/branch/${at(branch, path)}`,
      folder: (branch: string, path: string) =>
        `${webUrl}/src/branch/${at(branch, path)}`,
      commits: (branch: string) =>
        `${webUrl}/commits/branch/${encodePath(branch)}`,
    };
  return {
    commit: () => webUrl,
    file: () => webUrl,
    folder: () => webUrl,
    commits: () => webUrl,
  };
};

export const createPublicGitRepositoryReader = (input: {
  readonly cloneUrl: string;
  readonly fullName: string;
  readonly webUrl: string;
  readonly tip: PublicGitTip & { readonly head: string };
  readonly fetcher: typeof fetch;
}): RepositoryReader => {
  const links = hostLinks(input.webUrl);
  const branch = input.tip.defaultBranch;
  const fetchObjects = async (
    operation: string,
    args: ReadonlyArray<string>,
  ): Promise<ReadonlyMap<string, GitObject>> => {
    const url = `${repositoryUrl(input.cloneUrl)}/git-upload-pack`;
    const body = [
      packetLine("command=fetch\n"),
      packetLine("object-format=sha1\n"),
      DELIMITER,
      packetLine(`want ${input.tip.head}\n`),
      ...args.map((arg) => packetLine(`${arg}\n`)),
      packetLine("no-progress\n"),
      packetLine("done\n"),
      FLUSH,
    ].join("");
    let response: Response;
    try {
      response = await observeExternal("git", operation, url, () =>
        input.fetcher(url, {
          method: "POST",
          headers: {
            "content-type": "application/x-git-upload-pack-request",
            accept: "application/x-git-upload-pack-result",
            "git-protocol": "version=2",
            "user-agent": USER_AGENT,
          },
          body,
          redirect: "manual",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        }),
      );
    } catch {
      throw new PublicGitUnreachable("unreachable");
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new PublicGitUnreachable("unreachable");
    }
    try {
      return unpack(
        fetchResponsePack(await readBounded(response, MAX_RESPONSE_BYTES)),
      );
    } catch (cause) {
      if (cause instanceof PublicGitUnreachable) throw cause;
      throw new PublicGitUnreachable(
        cause instanceof GitWireError && cause.reason === "too-large"
          ? "too-large"
          : "malformed",
      );
    }
  };
  let trees: Promise<ReadonlyMap<string, GitObject>> | undefined;
  return {
    provider: "git",
    repository: async () => ({
      fullName: input.fullName,
      webUrl: input.webUrl,
      defaultBranch: branch,
    }),
    commitsUrl: (host) => links.commits(host.defaultBranch),
    commits: async (limit) => {
      const objects = await fetchObjects("fetch-commits", [
        `deepen ${limit}`,
        "filter tree:0",
      ]);
      const commits: RepositoryCommit[] = [];
      // The first-parent line from the tip, as far as the shallow fetch goes.
      let id: string | undefined = input.tip.head;
      while (id !== undefined && commits.length < limit) {
        const object = objects.get(id);
        if (object?.type !== "commit") break;
        const commit = parseCommit(object.data);
        commits.push({
          sha: id,
          subject: commitSubject(commit.message),
          authorName: commit.authorName,
          committedAt: commit.committedAt,
          url: links.commit(id),
        });
        id = commit.parents[0];
      }
      if (commits.length === 0) throw new PublicGitUnreachable("malformed");
      return commits;
    },
    directory: async (path) => {
      trees ??= fetchObjects("fetch-trees", ["deepen 1", "filter blob:none"]);
      const objects = await trees;
      const head = objects.get(input.tip.head);
      if (head?.type !== "commit") throw new PublicGitUnreachable("malformed");
      let tree = objects.get(parseCommit(head.data).tree);
      for (const segment of path === "" ? [] : path.split("/")) {
        if (tree?.type !== "tree") return undefined;
        const entry = parseTree(tree.data).find(
          (candidate) => candidate.name === segment,
        );
        if (entry === undefined || entry.mode !== "40000") return undefined;
        tree = objects.get(entry.id);
      }
      if (tree?.type !== "tree") return undefined;
      const all = parseTree(tree.data);
      const entries = all
        .slice(0, MAX_DIRECTORY_ENTRIES)
        .map((entry): RepositoryEntry => {
          const entryPath = path === "" ? entry.name : `${path}/${entry.name}`;
          const kind =
            entry.mode === "40000"
              ? "directory"
              : entry.mode === "120000"
                ? "symlink"
                : entry.mode === "160000"
                  ? "submodule"
                  : "file";
          return {
            name: entry.name,
            path: entryPath,
            kind,
            url:
              kind === "directory" || kind === "submodule"
                ? links.folder(branch, entryPath)
                : links.file(branch, entryPath),
          };
        });
      return { entries, truncated: all.length > MAX_DIRECTORY_ENTRIES };
    },
    lastCommits: async () => new Map(),
  };
};
