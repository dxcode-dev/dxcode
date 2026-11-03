import {
  commitSubject,
  encodePath,
  MAX_DIRECTORY_ENTRIES,
  type RepositoryCommit,
  type RepositoryEntry,
  type RepositoryHostIdentity,
  type RepositoryReader,
} from "../repository-reader.js";
import {
  createGitHubRestClient,
  GitHubProviderError,
} from "./provider-http.js";

const API_ORIGIN = "https://api.github.com";
const GITHUB_FULL_NAME = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA = /^[a-f0-9]{40}$/;
/** GraphQL aliases one `history` per path; past this the query grows costly. */
const MAX_LAST_COMMIT_PATHS = 100;
const LAST_COMMITS_TIMEOUT_MS = 4_000;

const invalid = (): never => {
  throw new GitHubProviderError({ category: "invalid-response" });
};

const text = (value: unknown, maximum = 8_192) =>
  typeof value === "string" && value.length > 0 && value.length <= maximum
    ? value
    : undefined;

const date = (value: unknown) => {
  const parsed = typeof value === "string" ? new Date(value) : undefined;
  return parsed !== undefined && Number.isFinite(parsed.getTime())
    ? parsed
    : undefined;
};

/**
 * Reads a GitHub repository's default branch over REST, and the last commit
 * per path over GraphQL. `target` names the repository by its stable ID (a
 * connected repository, with its restricted installation token) or by its
 * full name (a public repository, read anonymously; GraphQL needs a token, so
 * an anonymous reader reports no last commits).
 */
export const createGitHubRepositoryReader = (input: {
  readonly target:
    | { readonly repositoryId: string }
    | { readonly fullName: string };
  readonly token?: string;
  readonly fetcher?: typeof fetch;
}): RepositoryReader => {
  const client = createGitHubRestClient(input.fetcher);
  const headers = client.apiHeaders(input.token);
  const base =
    "repositoryId" in input.target
      ? /^[1-9][0-9]{0,30}$/.test(input.target.repositoryId)
        ? `${API_ORIGIN}/repositories/${input.target.repositoryId}`
        : invalid()
      : GITHUB_FULL_NAME.test(input.target.fullName)
        ? `${API_ORIGIN}/repos/${input.target.fullName}`
        : invalid();
  let identity: Promise<RepositoryHostIdentity> | undefined;
  const repository = () => {
    identity ??= client.json(base, { headers }).then(({ value }) => {
      const item = value as Record<string, unknown>;
      const fullName = text(item?.full_name, 201);
      const defaultBranch = text(item?.default_branch, 256);
      if (
        fullName === undefined ||
        !GITHUB_FULL_NAME.test(fullName) ||
        defaultBranch === undefined ||
        ("fullName" in input.target &&
          fullName.toLowerCase() !== input.target.fullName.toLowerCase())
      )
        return invalid();
      return {
        fullName,
        webUrl: `https://github.com/${fullName}`,
        defaultBranch,
      };
    });
    return identity;
  };
  const commitUrl = (webUrl: string, sha: string) => `${webUrl}/commit/${sha}`;
  return {
    provider: "github",
    repository,
    commitsUrl: (host) =>
      `${host.webUrl}/commits/${encodePath(host.defaultBranch)}`,
    commits: async (limit) => {
      const [{ value }, host] = await Promise.all([
        client.json(`${base}/commits?per_page=${limit}`, { headers }),
        repository(),
      ]);
      if (!Array.isArray(value)) return invalid();
      return value.slice(0, limit).map((raw): RepositoryCommit => {
        const item = raw as Record<string, unknown>;
        const commit = item?.commit as Record<string, unknown> | undefined;
        const author = commit?.author as Record<string, unknown> | undefined;
        const committer = commit?.committer as
          | Record<string, unknown>
          | undefined;
        const sha = text(item?.sha, 40);
        const message =
          typeof commit?.message === "string" ? commit.message : "";
        const committedAt = date(committer?.date) ?? date(author?.date);
        if (sha === undefined || !SHA.test(sha) || committedAt === undefined)
          return invalid();
        return {
          sha,
          subject: commitSubject(message),
          authorName:
            text(author?.name, 256) ?? text(committer?.name, 256) ?? "Unknown",
          committedAt,
          url: commitUrl(host.webUrl, sha),
        };
      });
    },
    directory: async (path) => {
      const contentsUrl = `${base}/contents${path === "" ? "" : `/${encodePath(path)}`}`;
      let value: unknown;
      let host: RepositoryHostIdentity;
      try {
        [{ value }, host] = await Promise.all([
          client.json(contentsUrl, { headers }),
          repository(),
        ]);
      } catch (cause) {
        if (
          cause instanceof GitHubProviderError &&
          cause.category === "not-found" &&
          path !== ""
        )
          return undefined;
        throw cause;
      }
      // A file answers an object, a directory an array.
      if (!Array.isArray(value)) return undefined;
      const branch = encodePath(host.defaultBranch);
      const entries = value
        .slice(0, MAX_DIRECTORY_ENTRIES)
        .map((raw): RepositoryEntry => {
          const item = raw as Record<string, unknown>;
          const name = text(item?.name, 1_024);
          const entryPath = text(item?.path, 4_096);
          const kind =
            item?.type === "dir"
              ? "directory"
              : item?.type === "file" ||
                  item?.type === "symlink" ||
                  item?.type === "submodule"
                ? item.type
                : undefined;
          if (
            name === undefined ||
            entryPath === undefined ||
            kind === undefined ||
            entryPath !== (path === "" ? name : `${path}/${name}`)
          )
            return invalid();
          return {
            name,
            path: entryPath,
            kind,
            url: `${host.webUrl}/${kind === "file" || kind === "symlink" ? "blob" : "tree"}/${branch}/${encodePath(entryPath)}`,
          };
        });
      return {
        entries,
        truncated: value.length >= MAX_DIRECTORY_ENTRIES,
      };
    },
    lastCommits: async (head, paths) => {
      const found = new Map<string, RepositoryCommit>();
      if (input.token === undefined || !SHA.test(head) || paths.length === 0)
        return found;
      const host = await repository();
      const [owner, name] = host.fullName.split("/");
      const asked = paths.slice(0, MAX_LAST_COMMIT_PATHS);
      const variables: Record<string, string> = {
        owner: owner ?? "",
        name: name ?? "",
        head,
      };
      asked.forEach((path, index) => {
        variables[`p${index}`] = path;
      });
      const query = `query(${[
        "$owner:String!",
        "$name:String!",
        "$head:GitObjectID!",
        ...asked.map((_, index) => `$p${index}:String!`),
      ].join(
        ",",
      )}){repository(owner:$owner,name:$name){object(oid:$head){...on Commit{${asked
        .map(
          (_, index) =>
            `e${index}:history(first:1,path:$p${index}){nodes{oid messageHeadline committedDate}}`,
        )
        .join(" ")}}}}}`;
      const { value } = await client.json(`${API_ORIGIN}/graphql`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(LAST_COMMITS_TIMEOUT_MS),
      });
      const object = (
        (value as Record<string, unknown>)?.data as
          | Record<string, Record<string, unknown> | undefined>
          | undefined
      )?.repository?.object as Record<string, unknown> | undefined;
      if (object === undefined || object === null) return found;
      asked.forEach((path, index) => {
        const node = (
          (object[`e${index}`] as Record<string, unknown> | undefined)?.nodes as
            | ReadonlyArray<Record<string, unknown>>
            | undefined
        )?.[0];
        const sha = text(node?.oid, 40);
        const committedAt = date(node?.committedDate);
        if (sha === undefined || !SHA.test(sha) || committedAt === undefined)
          return;
        found.set(path, {
          sha,
          subject: commitSubject(
            typeof node?.messageHeadline === "string"
              ? node.messageHeadline
              : "",
          ),
          authorName: "",
          committedAt,
          url: commitUrl(host.webUrl, sha),
        });
      });
      return found;
    },
  };
};
