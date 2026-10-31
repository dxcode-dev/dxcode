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

const readCapped = async (
  response: Response,
): Promise<Uint8Array | "too-large"> => {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_PLUGIN_ARCHIVE_BYTES) {
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
    if (total > MAX_PLUGIN_ARCHIVE_BYTES) {
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
