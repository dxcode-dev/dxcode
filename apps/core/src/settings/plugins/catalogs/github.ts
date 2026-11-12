import { MAX_PLUGIN_CATALOG_BYTES } from "@dx/domain";
import { Effect } from "effect";
import {
  PluginBundleRejected,
  PluginBundleSourceUnavailable,
} from "../bundles/errors.js";
import { parseGitHubPluginUrl, readCapped } from "../bundles/github.js";

/** Where dx looks for a catalog in a repository, in order. */
export const CATALOG_MANIFEST_PATHS = [
  ".claude-plugin/marketplace.json",
  "marketplace.json",
] as const;

export interface CatalogLocation {
  readonly repository: string;
  readonly ref: string;
  /** A `marketplace.json` path the URL named, or every default path. */
  readonly manifestPaths: ReadonlyArray<string>;
}

/**
 * A catalog URL: a public GitHub repository, a branch of it
 * (`/tree/<ref>`), or the catalog file itself (`/blob/<ref>/<path>`).
 */
export const parseCatalogUrl = (raw: string): CatalogLocation | undefined => {
  const trimmed = raw.trim();
  const blob =
    /^(https:\/\/(?:www\.)?github\.com\/[^/]+\/[^/]+)\/blob\/(.+)$/.exec(
      trimmed,
    );
  if (blob !== null) {
    const location = parseGitHubPluginUrl(`${blob[1]}/tree/${blob[2]}`);
    const [ref, ...path] = location?.treeSegments ?? [];
    if (location === undefined || ref === undefined || path.length === 0) {
      return undefined;
    }
    const manifestPath = path.join("/");
    return manifestPath.endsWith(".json")
      ? {
          repository: location.repository,
          ref,
          manifestPaths: [manifestPath],
        }
      : undefined;
  }
  const location = parseGitHubPluginUrl(trimmed);
  if (location === undefined) return undefined;
  return {
    repository: location.repository,
    ref:
      location.treeSegments.length === 0
        ? "HEAD"
        : location.treeSegments.join("/"),
    manifestPaths: CATALOG_MANIFEST_PATHS,
  };
};

const rawUrl = (repository: string, ref: string, path: string) =>
  `https://raw.githubusercontent.com/${repository}/${[...ref.split("/"), ...path.split("/")].map(encodeURIComponent).join("/")}`;

/** Reads the first catalog file the location has, capped at 1 MiB. */
export const fetchCatalogManifest = Effect.fn("fetchCatalogManifest")(
  function* (location: CatalogLocation) {
    for (const manifestPath of location.manifestPaths) {
      const response = yield* Effect.tryPromise({
        try: () =>
          fetch(rawUrl(location.repository, location.ref, manifestPath), {
            headers: { "user-agent": "dx-plugin-catalog" },
            redirect: "follow",
            signal: AbortSignal.timeout(20_000),
          }),
        catch: () =>
          new PluginBundleSourceUnavailable({
            reason: "GitHub could not be reached. Try again.",
          }),
      });
      if (response.status === 404) {
        yield* Effect.promise(
          () =>
            response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
        );
        continue;
      }
      if (!response.ok) {
        yield* Effect.promise(
          () =>
            response.body?.cancel().catch(() => undefined) ?? Promise.resolve(),
        );
        return yield* new PluginBundleSourceUnavailable({
          reason: `GitHub answered ${response.status}. Try again.`,
        });
      }
      const bytes = yield* Effect.tryPromise({
        try: () => readCapped(response, MAX_PLUGIN_CATALOG_BYTES),
        catch: () =>
          new PluginBundleSourceUnavailable({
            reason: "The download from GitHub was interrupted. Try again.",
          }),
      });
      if (bytes === "too-large") {
        return yield* new PluginBundleRejected({
          reason: "marketplace.json is larger than 1 MiB.",
        });
      }
      return { manifestPath, text: new TextDecoder().decode(bytes) };
    }
    return yield* new PluginBundleRejected({
      reason:
        location.manifestPaths.length === 1
          ? `GitHub has no public file at ${location.manifestPaths[0]} in ${location.repository}.`
          : `${location.repository} has no .claude-plugin/marketplace.json or marketplace.json, or isn't a public repository.`,
    });
  },
);
