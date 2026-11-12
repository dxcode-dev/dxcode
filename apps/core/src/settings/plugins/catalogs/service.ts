import {
  MAX_PLUGIN_CATALOGS_PER_SCOPE,
  PluginCatalogId,
  PluginCatalogRepository,
  type PluginCatalogSource,
  type PluginTarget,
  StoredPluginCatalog,
  type UserId,
} from "@dx/domain";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { SettingsAudit } from "../../audit.js";
import { PluginBundleRejected } from "../bundles/errors.js";
import type { PluginBundleInput } from "../bundles/service.js";
import { fetchCatalogManifest, parseCatalogUrl } from "./github.js";
import { readMarketplace } from "./marketplace.js";
import { provePublishers } from "./proof.js";

interface AuditContext {
  readonly userId: UserId;
  readonly requestId: string;
}

const rejected = (reason: string) => new PluginBundleRejected({ reason });

/** Reads a catalog from GitHub and proves its publishers. */
const read = Effect.fn("PluginCatalogService.read")(function* (location: {
  readonly repository: string;
  readonly ref: string;
  readonly manifestPaths: ReadonlyArray<string>;
}) {
  const fetched = yield* fetchCatalogManifest(location);
  const parsed = readMarketplace(fetched.text, location);
  if (!parsed.ok) return yield* rejected(parsed.reason);
  const publishers = yield* provePublishers(
    parsed.catalog.entries,
    location.repository,
  );
  return {
    ...parsed.catalog,
    publishers,
    source: {
      repository: location.repository,
      ref: location.ref,
      manifestPath: fetched.manifestPath,
    } satisfies PluginCatalogSource,
  };
});

interface PluginCatalogServiceShape {
  readonly add: (
    target: PluginTarget,
    url: string,
    audit: AuditContext,
  ) => Effect.Effect<StoredPluginCatalog, unknown>;
  /** Reads the catalog again from its repository and proves it again. */
  readonly refresh: (
    target: PluginTarget,
    id: PluginCatalogId,
    audit: AuditContext,
  ) => Effect.Effect<StoredPluginCatalog, unknown>;
  readonly remove: (
    target: PluginTarget,
    id: PluginCatalogId,
    audit: AuditContext,
  ) => Effect.Effect<void, unknown>;
  /**
   * What the plugin import reads for one entry. It carries the catalog only
   * when the catalog proved the publisher domain in the entry's name;
   * otherwise the entry imports as a plain GitHub plugin.
   */
  readonly entryInput: (
    target: PluginTarget,
    id: PluginCatalogId,
    name: string,
  ) => Effect.Effect<PluginBundleInput, unknown>;
}

export class PluginCatalogService extends Context.Service<
  PluginCatalogService,
  PluginCatalogServiceShape
>()("@dx/core/settings/plugins/PluginCatalogService") {
  static readonly layer = Layer.effect(
    PluginCatalogService,
    Effect.gen(function* () {
      const catalogs = yield* PluginCatalogRepository;
      const settingsAudit = yield* SettingsAudit;
      const audit = (
        action: string,
        target: PluginTarget,
        context: AuditContext,
      ) =>
        settingsAudit.record({
          action,
          scope: target.scope,
          outcome: "success",
          requestId: context.requestId,
          userId: context.userId,
        });

      return PluginCatalogService.of({
        add: Effect.fn("PluginCatalogService.add")(
          function* (target, url, auditContext) {
            const location = parseCatalogUrl(url);
            if (location === undefined) {
              return yield* rejected(
                "Use a GitHub URL such as https://github.com/owner/repo.",
              );
            }
            const existing = yield* catalogs.list(target);
            if (existing.length >= MAX_PLUGIN_CATALOGS_PER_SCOPE) {
              return yield* rejected(
                `This scope already has ${MAX_PLUGIN_CATALOGS_PER_SCOPE} catalogs.`,
              );
            }
            if (
              existing.some(
                ({ source }) =>
                  source.repository.toLowerCase() ===
                  location.repository.toLowerCase(),
              )
            ) {
              return yield* rejected(
                `The catalog in ${location.repository} is already added here.`,
              );
            }
            const latest = yield* read(location);
            if (existing.some(({ name }) => name === latest.name)) {
              return yield* rejected(
                `A catalog named ${latest.name} is already added here.`,
              );
            }
            const now = yield* DateTime.now;
            const catalog = yield* Schema.decodeUnknownEffect(
              Schema.toType(StoredPluginCatalog),
            )({
              ...latest,
              id: yield* Schema.decodeEffect(PluginCatalogId)(
                `pcat_${crypto.randomUUID()}`,
              ),
              target,
              addedAt: now,
              addedByUserId: auditContext.userId,
              refreshedAt: now,
            });
            yield* catalogs.insert(catalog).pipe(
              Effect.catchTag("PluginCatalogTaken", () =>
                Effect.fail(rejected("This catalog is already added here.")),
              ),
              Effect.catchTag("PluginCatalogLimitReached", () =>
                Effect.fail(
                  rejected(
                    `This scope already has ${MAX_PLUGIN_CATALOGS_PER_SCOPE} catalogs.`,
                  ),
                ),
              ),
            );
            yield* audit("plugin_catalog.add", target, auditContext);
            return catalog;
          },
        ),
        refresh: Effect.fn("PluginCatalogService.refresh")(
          function* (target, id, auditContext) {
            const current = yield* catalogs.find(target, id);
            const latest = yield* read({
              repository: current.source.repository,
              ref: current.source.ref,
              manifestPaths: [current.source.manifestPath],
            });
            const catalog = yield* Schema.decodeUnknownEffect(
              Schema.toType(StoredPluginCatalog),
            )({
              ...current,
              ...latest,
              refreshedAt: yield* DateTime.now,
            });
            yield* catalogs
              .replace(catalog)
              .pipe(
                Effect.catchTag("PluginCatalogTaken", () =>
                  Effect.fail(
                    rejected(
                      `The catalog is now named ${catalog.name}, which another catalog here already uses.`,
                    ),
                  ),
                ),
              );
            yield* audit("plugin_catalog.refresh", target, auditContext);
            return catalog;
          },
        ),
        remove: Effect.fn("PluginCatalogService.remove")(
          function* (target, id, auditContext) {
            yield* catalogs.remove(target, id);
            yield* audit("plugin_catalog.remove", target, auditContext);
          },
        ),
        entryInput: Effect.fn("PluginCatalogService.entryInput")(
          function* (target, id, name) {
            const catalog = yield* catalogs.find(target, id);
            const entry = catalog.entries.find((item) => item.name === name);
            if (entry === undefined) {
              return yield* rejected(
                `${catalog.name} doesn't list a plugin named ${name}.`,
              );
            }
            if (entry.source.type === "unsupported") {
              return yield* rejected(entry.source.reason);
            }
            const proven =
              entry.publisher !== undefined &&
              catalog.publishers.some(
                ({ domain, proof }) =>
                  domain === entry.publisher && proof !== "none",
              );
            return {
              type: "github-location",
              repository: entry.source.repository,
              ref: entry.source.ref,
              path: entry.source.path,
              ...(entry.source.pin === undefined
                ? {}
                : { pin: entry.source.pin }),
              ...(proven
                ? { catalog: { id: catalog.id, name: catalog.name } }
                : {}),
            } satisfies PluginBundleInput;
          },
        ),
      });
    }),
  );
}
