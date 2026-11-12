import { Context, type Effect, Schema } from "effect";
import type { PersistenceUnavailable } from "../persistence/errors.js";
import { Timestamp } from "../persistence/timestamp.js";
import { UserId } from "../users/user-id.js";
import { PluginTarget } from "./plugin.js";
import { PluginBundleGitHubRepository } from "./plugin-bundle.js";
import { PluginCatalogId, PluginCatalogName } from "./plugin-catalog-id.js";

export { PluginCatalogId, PluginCatalogName };

/**
 * A plugin catalog: a `marketplace.json` file in a GitHub repository, in
 * Claude Code's widely used format, that lists plugins and where each one
 * lives. Adding a catalog installs nothing; a person picks an entry and
 * reviews it through the ordinary plugin import.
 *
 * Plugin names in a catalog carry their publisher as a reverse-domain prefix,
 * such as `com.acme.release-helper`. An entry keeps its catalog identity
 * (`name@catalog`) only when the publisher proved the domain is theirs.
 */

export const MAX_PLUGIN_CATALOGS_PER_SCOPE = 10;
export const MAX_PLUGIN_CATALOG_ENTRIES = 500;
export const MAX_PLUGIN_CATALOG_BYTES = 1024 * 1024;
export const MAX_PLUGIN_CATALOG_PUBLISHERS = 50;

/** dx's own publisher domain. `dev.dxcode.<name>` belongs to dx alone. */
export const FIRST_PARTY_PLUGIN_DOMAIN = "dxcode.dev";
/** The GitHub owner whose catalogs may publish dx's own plugins. */
export const FIRST_PARTY_GITHUB_OWNER = "dxcode-dev";

const domainLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The publisher domain a plugin name claims, or undefined for a plain name.
 * A name claims a domain when it has at least three period-separated parts
 * and the first is a top-level domain: everything but the last part, read
 * backwards, is the domain (`com.acme.tool` claims `acme.com`).
 */
export const pluginPublisherDomain = (name: string): string | undefined => {
  const labels = name.split(".");
  if (labels.length < 3) return undefined;
  const [tld] = labels;
  if (tld === undefined || !/^[a-z]{2,63}$/.test(tld)) return undefined;
  const domainLabels = labels.slice(0, -1);
  if (!domainLabels.every((label) => domainLabel.test(label))) {
    return undefined;
  }
  return domainLabels.reverse().join(".");
};

/** Whether a domain is dx's own, or one under it. */
export const isFirstPartyPluginDomain = (domain: string) =>
  domain === FIRST_PARTY_PLUGIN_DOMAIN ||
  domain.endsWith(`.${FIRST_PARTY_PLUGIN_DOMAIN}`);

/** Whether a plugin name uses the prefix reserved for dx's own plugins. */
export const isReservedPluginName = (name: string) => {
  const domain = pluginPublisherDomain(name);
  return domain !== undefined && isFirstPartyPluginDomain(domain);
};

const PublisherDomain = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(253),
);

/** Where an entry's plugin lives, or why dx can't install it. */
export const PluginCatalogEntrySource = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("github"),
    repository: PluginBundleGitHubRepository,
    /** The branch, tag, or commit to read; `HEAD` for the default branch. */
    ref: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
    /** The plugin's folder in the repository; empty for its root. */
    path: Schema.String.check(Schema.isMaxLength(256)),
    /** The commit the catalog pins, when it pins one. */
    pin: Schema.optional(
      Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/)),
    ),
  }),
  Schema.Struct({
    type: Schema.Literal("unsupported"),
    reason: Schema.String.check(Schema.isMaxLength(256)),
  }),
]);

export type PluginCatalogEntrySource = typeof PluginCatalogEntrySource.Type;

export const PluginCatalogEntry = Schema.Struct({
  /** The name the catalog gives, as written; it may not be a valid name. */
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  description: Schema.String.check(Schema.isMaxLength(512)),
  version: Schema.optional(Schema.String.check(Schema.isMaxLength(64))),
  source: PluginCatalogEntrySource,
  /** The publisher domain the name claims, when it claims one. */
  publisher: Schema.optional(PublisherDomain),
});

export type PluginCatalogEntry = typeof PluginCatalogEntry.Type;

/**
 * How a publisher domain was proven for one catalog:
 * - `first-party`: dx's own domain, in a catalog under dx's GitHub owner.
 * - `github`: `<owner>.github.io`, in a catalog under that GitHub owner.
 * - `dns`: a TXT record at `_dx-plugins.<domain>` naming the catalog.
 * - `none`: not proven.
 */
export const PluginCatalogProof = Schema.Literals([
  "first-party",
  "github",
  "dns",
  "none",
]);

export type PluginCatalogProof = typeof PluginCatalogProof.Type;

export const PluginCatalogPublisher = Schema.Struct({
  domain: PublisherDomain,
  proof: PluginCatalogProof,
});

export type PluginCatalogPublisher = typeof PluginCatalogPublisher.Type;

export const PluginCatalogSource = Schema.Struct({
  repository: PluginBundleGitHubRepository,
  /** The branch, tag, or commit asked for; `HEAD` for the default branch. */
  ref: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  /** Where `marketplace.json` was found in the repository. */
  manifestPath: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
});

export type PluginCatalogSource = typeof PluginCatalogSource.Type;

export const StoredPluginCatalog = Schema.Struct({
  id: PluginCatalogId,
  target: PluginTarget,
  name: PluginCatalogName,
  description: Schema.String.check(Schema.isMaxLength(1_024)),
  ownerName: Schema.optional(Schema.String.check(Schema.isMaxLength(128))),
  source: PluginCatalogSource,
  entries: Schema.Array(PluginCatalogEntry).check(
    Schema.isMaxLength(MAX_PLUGIN_CATALOG_ENTRIES),
  ),
  publishers: Schema.Array(PluginCatalogPublisher).check(
    Schema.isMaxLength(MAX_PLUGIN_CATALOG_PUBLISHERS),
  ),
  addedAt: Timestamp,
  addedByUserId: UserId,
  refreshedAt: Timestamp,
});

export type StoredPluginCatalog = typeof StoredPluginCatalog.Type;

export class PluginCatalogNotFound extends Schema.TaggedError<PluginCatalogNotFound>()(
  "PluginCatalogNotFound",
  {},
) {}

/** The scope already has a catalog with this name or repository. */
export class PluginCatalogTaken extends Schema.TaggedError<PluginCatalogTaken>()(
  "PluginCatalogTaken",
  {},
) {}

/** The scope already holds MAX_PLUGIN_CATALOGS_PER_SCOPE catalogs. */
export class PluginCatalogLimitReached extends Schema.TaggedError<PluginCatalogLimitReached>()(
  "PluginCatalogLimitReached",
  {},
) {}

type CatalogRepositoryFailure = PersistenceUnavailable | Schema.SchemaError;

export interface PluginCatalogRepositoryShape {
  readonly list: (
    target: PluginTarget,
  ) => Effect.Effect<
    ReadonlyArray<StoredPluginCatalog>,
    CatalogRepositoryFailure
  >;
  readonly find: (
    target: PluginTarget,
    id: PluginCatalogId,
  ) => Effect.Effect<
    StoredPluginCatalog,
    CatalogRepositoryFailure | PluginCatalogNotFound
  >;
  /** Inserts only while the scope is under its catalog limit. */
  readonly insert: (
    catalog: StoredPluginCatalog,
  ) => Effect.Effect<
    void,
    CatalogRepositoryFailure | PluginCatalogTaken | PluginCatalogLimitReached
  >;
  /** Replaces a catalog's contents after reading it again. */
  readonly replace: (
    catalog: StoredPluginCatalog,
  ) => Effect.Effect<
    void,
    CatalogRepositoryFailure | PluginCatalogNotFound | PluginCatalogTaken
  >;
  readonly remove: (
    target: PluginTarget,
    id: PluginCatalogId,
  ) => Effect.Effect<void, CatalogRepositoryFailure | PluginCatalogNotFound>;
}

export class PluginCatalogRepository extends Context.Service<
  PluginCatalogRepository,
  PluginCatalogRepositoryShape
>()("@dx/domain/settings/PluginCatalogRepository") {}
