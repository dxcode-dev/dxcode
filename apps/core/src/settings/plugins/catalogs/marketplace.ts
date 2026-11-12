import {
  MAX_PLUGIN_CATALOG_ENTRIES,
  type PluginCatalogEntry,
  type PluginCatalogEntrySource,
  PluginCatalogName,
  PluginName,
  pluginPublisherDomain,
} from "@dx/domain";
import { Option, Schema } from "effect";
import { isRecord } from "../bundles/bundle-reader.js";
import { parseGitHubPluginUrl } from "../bundles/github.js";

/**
 * Reads a `marketplace.json` in Claude Code's format: a `name`, an `owner`,
 * and `plugins`, each with a `name` and a `source`. dx installs GitHub
 * sources: a path in the catalog's own repository, `github`, `url`, and
 * `git-subdir`. Other entries are listed with the reason dx can't install
 * them. Nothing in the catalog runs.
 */

export interface ParsedCatalog {
  readonly name: PluginCatalogName;
  readonly description: string;
  readonly ownerName?: string;
  readonly entries: ReadonlyArray<PluginCatalogEntry>;
}

export type CatalogReadResult =
  | { readonly ok: true; readonly catalog: ParsedCatalog }
  | { readonly ok: false; readonly reason: string };

const repositoryPattern =
  /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const commitPattern = /^[0-9a-f]{40}$/;

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : undefined;

const unsupported = (reason: string): PluginCatalogEntrySource => ({
  type: "unsupported",
  reason,
});

/** A folder path inside a repository, or undefined when it leaves it. */
const repositoryPath = (raw: string) => {
  const segments = raw
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment !== "" && segment !== ".");
  if (raw.startsWith("/") || segments.some((segment) => segment === "..")) {
    return undefined;
  }
  const path = segments.join("/");
  return path.length > 256 ? undefined : path;
};

/** `owner/repo` from a GitHub URL or shorthand, without `.git`. */
const githubRepository = (raw: unknown) => {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  const shorthand = trimmed.replace(/\.git$/, "");
  if (repositoryPattern.test(shorthand)) {
    const name = shorthand.slice(shorthand.indexOf("/") + 1);
    return name === "." || name === ".." ? undefined : shorthand;
  }
  const location = parseGitHubPluginUrl(trimmed);
  return location === undefined || location.treeSegments.length > 0
    ? undefined
    : location.repository;
};

/** Whether a ref names one ref, with no segment that walks the URL path. */
export const isSafeRef = (ref: string) =>
  ref
    .split("/")
    .every(
      (segment) =>
        segment !== "" &&
        segment !== "." &&
        segment !== ".." &&
        !/[\s\\?#%]/.test(segment),
    );

const refOf = (source: Record<string, unknown>) => {
  const ref = text(source.ref, 255);
  const sha = text(source.sha, 40);
  const chosen = ref === undefined || ref === "" ? "HEAD" : ref;
  return isSafeRef(chosen)
    ? {
        ref: chosen,
        ...(sha !== undefined && commitPattern.test(sha) ? { pin: sha } : {}),
      }
    : undefined;
};

const entrySource = (
  raw: unknown,
  catalog: {
    readonly repository: string;
    readonly ref: string;
    readonly pluginRoot: string;
  },
): PluginCatalogEntrySource => {
  if (typeof raw === "string") {
    const relative = raw.trim();
    const joined =
      relative.startsWith("./") || catalog.pluginRoot === ""
        ? relative
        : `${catalog.pluginRoot}/${relative}`;
    const path = repositoryPath(joined);
    return path === undefined
      ? unsupported("Its path leaves the catalog's repository.")
      : {
          type: "github",
          repository: catalog.repository,
          ref: catalog.ref,
          path,
        };
  }
  if (!isRecord(raw)) return unsupported("It has no source.");
  const kind = typeof raw.source === "string" ? raw.source : "";
  if (kind === "github") {
    const repository = githubRepository(raw.repo);
    const ref = refOf(raw);
    if (ref === undefined) return unsupported("Its ref isn't valid.");
    return repository === undefined
      ? unsupported("Its GitHub repository isn't valid.")
      : { type: "github", repository, path: "", ...ref };
  }
  if (kind === "url" || kind === "git-subdir") {
    const repository = githubRepository(raw.url);
    if (repository === undefined) {
      return unsupported("dx installs catalog plugins from GitHub only.");
    }
    const path =
      kind === "git-subdir" ? repositoryPath(String(raw.path ?? "")) : "";
    const ref = refOf(raw);
    if (ref === undefined) return unsupported("Its ref isn't valid.");
    return path === undefined
      ? unsupported("Its path leaves the repository.")
      : { type: "github", repository, path, ...ref };
  }
  return unsupported(
    kind === ""
      ? "It has no source."
      : `dx can't install plugins from ${kind.slice(0, 32)} sources.`,
  );
};

export const readMarketplace = (
  raw: string,
  location: { readonly repository: string; readonly ref: string },
): CatalogReadResult => {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "marketplace.json isn't valid JSON." };
  }
  if (!isRecord(json)) {
    return { ok: false, reason: "marketplace.json must hold an object." };
  }
  const name = Schema.decodeUnknownOption(PluginCatalogName)(json.name);
  if (Option.isNone(name)) {
    return {
      ok: false,
      reason:
        "The catalog's name must be lowercase letters, digits, hyphens, and periods.",
    };
  }
  if (!Array.isArray(json.plugins)) {
    return { ok: false, reason: "marketplace.json has no plugins list." };
  }
  if (json.plugins.length > MAX_PLUGIN_CATALOG_ENTRIES) {
    return {
      ok: false,
      reason: `The catalog lists more than ${MAX_PLUGIN_CATALOG_ENTRIES} plugins.`,
    };
  }
  const metadata = isRecord(json.metadata) ? json.metadata : {};
  const pluginRoot = repositoryPath(text(metadata.pluginRoot, 256) ?? "") ?? "";
  const owner = isRecord(json.owner) ? text(json.owner.name, 128) : undefined;
  const seen = new Set<string>();
  const entries: Array<PluginCatalogEntry> = [];
  for (const plugin of json.plugins) {
    if (!isRecord(plugin)) continue;
    const entryName = text(plugin.name, 128);
    if (entryName === undefined || entryName === "" || seen.has(entryName)) {
      continue;
    }
    seen.add(entryName);
    const valid = Option.isSome(
      Schema.decodeUnknownOption(PluginName)(entryName),
    );
    const publisher = valid ? pluginPublisherDomain(entryName) : undefined;
    const version = text(plugin.version, 64);
    entries.push({
      name: entryName,
      description: text(plugin.description, 512) ?? "",
      ...(version === undefined || version === "" ? {} : { version }),
      source: valid
        ? entrySource(plugin.source, { ...location, pluginRoot })
        : unsupported(
            "Its name must be lowercase letters, digits, hyphens, and periods.",
          ),
      ...(publisher === undefined ? {} : { publisher }),
    });
  }
  return {
    ok: true,
    catalog: {
      name: name.value,
      description:
        text(json.description, 1_024) ||
        text(metadata.description, 1_024) ||
        "",
      ...(owner === undefined || owner === "" ? {} : { ownerName: owner }),
      entries,
    },
  };
};
