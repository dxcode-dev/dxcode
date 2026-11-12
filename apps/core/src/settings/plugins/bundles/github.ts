import { MAX_PLUGIN_ARCHIVE_BYTES } from "@dx/domain";
import { Effect } from "effect";
import {
  PluginBundleRejected,
  PluginBundleSourceUnavailable,
} from "./errors.js";

/**
 * Fetches a public GitHub repository as a ZIP archive from codeload, never
 * reading more than the archive limit. GitHub writes the commit SHA into the
 * archive comment, which pins what the person reviewed.
 */

export interface GitHubPluginLocation {
  readonly repository: string;
  /** Segments after `/tree/`: a ref, then the plugin's folder. */
  readonly treeSegments: ReadonlyArray<string>;
}

const owner = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const repositoryName = /^[A-Za-z0-9._-]{1,100}$/;

export const parseGitHubPluginUrl = (
  raw: string,
): GitHubPluginLocation | undefined => {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    (url.hostname !== "github.com" && url.hostname !== "www.github.com") ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return undefined;
  }
  const segments = url.pathname
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return "\0";
      }
    });
  const [user, rawRepository, kind, ...rest] = segments;
  if (user === undefined || rawRepository === undefined) return undefined;
  const name = rawRepository.replace(/\.git$/, "");
  if (
    !owner.test(user) ||
    !repositoryName.test(name) ||
    name === "." ||
    name === ".."
  ) {
    return undefined;
  }
  if (kind !== undefined && kind !== "tree") return undefined;
  if (kind === "tree" && rest.length === 0) return undefined;
  if (rest.some((segment) => segment === ".." || segment.includes("\0"))) {
    return undefined;
  }
  return { repository: `${user}/${name}`, treeSegments: rest };
};

/** Reads a response body, stopping once it passes `limit` bytes. */
export const readCapped = async (
  response: Response,
  limit: number = MAX_PLUGIN_ARCHIVE_BYTES,
): Promise<Uint8Array | "too-large"> => {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    return "too-large";
  }
  const reader = response.body?.getReader();
  if (reader === undefined) return new Uint8Array();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => undefined);
      return "too-large";
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let position = 0;
  for (const chunk of chunks) {
    output.set(chunk, position);
    position += chunk.byteLength;
  }
  return output;
};

/** The archive of one ref, or undefined when GitHub has no such ref. */
export const fetchGitHubArchive = Effect.fn("fetchGitHubArchive")(function* (
  repository: string,
  ref: string,
) {
  // A `.` or `..` segment would walk the URL to another repository.
  if (
    repository.split("/").some((part) => part === "." || part === "..") ||
    ref.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    return yield* new PluginBundleRejected({
      reason: "That GitHub repository or ref isn't valid.",
    });
  }
  const path = ref
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(`https://codeload.github.com/${repository}/zip/${path}`, {
        headers: { "user-agent": "dx-plugin-import" },
        redirect: "follow",
      }),
    catch: () =>
      new PluginBundleSourceUnavailable({
        reason: "GitHub could not be reached. Try again.",
      }),
  });
  if (response.status === 404) {
    yield* Effect.promise(
      () => response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
    );
    return undefined;
  }
  if (!response.ok) {
    yield* Effect.promise(
      () => response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
    );
    return yield* new PluginBundleSourceUnavailable({
      reason: `GitHub answered ${response.status}. Try again.`,
    });
  }
  const bytes = yield* Effect.tryPromise({
    try: () => readCapped(response),
    catch: () =>
      new PluginBundleSourceUnavailable({
        reason: "The download from GitHub was interrupted. Try again.",
      }),
  });
  if (bytes === "too-large") {
    return yield* new PluginBundleRejected({
      reason: `The repository archive is larger than ${MAX_PLUGIN_ARCHIVE_BYTES.toLocaleString("en-US")} bytes. Download the plugin folder as a ZIP and import that.`,
    });
  }
  return bytes;
});

/**
 * Splits a tree URL into its ref and folder. A ref may contain slashes, so it
 * asks GitHub for the shortest ref first: `main`, then `feature/x`, and so on.
 */
export const fetchGitHubPlugin = Effect.fn("fetchGitHubPlugin")(function* (
  location: GitHubPluginLocation,
) {
  const candidates =
    location.treeSegments.length === 0
      ? [{ ref: "HEAD", path: "" }]
      : Array.from(
          { length: Math.min(4, location.treeSegments.length) },
          (_, index) => ({
            ref: location.treeSegments.slice(0, index + 1).join("/"),
            path: location.treeSegments.slice(index + 1).join("/"),
          }),
        );
  for (const candidate of candidates) {
    const bytes = yield* fetchGitHubArchive(location.repository, candidate.ref);
    if (bytes !== undefined) return { ...candidate, bytes };
  }
  return yield* new PluginBundleRejected({
    reason:
      "GitHub has no public repository or branch at that URL. dx imports public repositories only.",
  });
});

/**
 * Whether the plugin's folder changed on its ref since the installed commit,
 * from GitHub's compare API: one request per plugin, no download. Undefined
 * when GitHub can't say (rate limited, gone, or unreachable), so the caller
 * shows no notice rather than a wrong one.
 */
export const gitHubFolderChanged = async (source: {
  readonly repository: string;
  readonly ref: string;
  readonly path: string;
  readonly commit: string;
}): Promise<boolean | undefined> => {
  const ref = source.ref
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  let response: Response;
  try {
    response = await fetch(
      `https://api.github.com/repos/${source.repository}/compare/${source.commit}...${ref}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "user-agent": "dx-plugin-update-check",
        },
        signal: AbortSignal.timeout(5_000),
      },
    );
  } catch {
    return undefined;
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  const body = (await response.json().catch(() => undefined)) as
    | {
        readonly status?: unknown;
        readonly files?: ReadonlyArray<{ readonly filename?: unknown }>;
      }
    | undefined;
  if (body === undefined) return undefined;
  if (body.status === "identical" || body.status === "behind") return false;
  if (!Array.isArray(body.files)) return undefined;
  // GitHub lists at most 300 files; a full list may hide the folder's.
  if (body.files.length >= 300) return true;
  const prefix = source.path === "" ? "" : `${source.path}/`;
  return body.files.some(
    ({ filename }) =>
      typeof filename === "string" && filename.startsWith(prefix),
  );
};
