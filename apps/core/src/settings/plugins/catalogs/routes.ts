import {
  AddPluginCatalogRequestSchema,
  AddPluginCatalogResponseSchema,
  ListPluginCatalogsResponseSchema,
  PluginCatalogNotFoundResponseSchema,
  PluginCatalogParamsSchema,
  PreviewPluginBundleResponseSchema,
  PreviewPluginCatalogEntryRequestSchema,
  RefreshPluginCatalogResponseSchema,
  RemovePluginCatalogResponseSchema,
} from "@dx/api";
import {
  PluginCatalogNotFound,
  PluginCatalogRepository,
  SettingsScopeForbidden,
  type StoredPluginCatalog,
} from "@dx/domain";
import { Effect, Layer, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import {
  decodeJsonBody,
  decodeRequestInput,
} from "../../../http/request-decoding.js";
import type { AppEnv } from "../../../http/types.js";
import { decodeD1Binding } from "../../../persistence/d1-binding.js";
import { SettingsAudit } from "../../audit.js";
import { PluginBundleRejected } from "../bundles/errors.js";
import { pluginBundleLayers } from "../bundles/layers.js";
import {
  authorizePluginBundles,
  type BundleAccess,
  pluginBundleFailureResponse,
  type RouteScope,
} from "../bundles/routes.js";
import { PluginBundleService } from "../bundles/service.js";
import { previewSignature } from "../bundles/signature.js";
import { PluginCatalogService } from "./service.js";

const layers = (db: D1Database, storage: R2Bucket | undefined) => {
  const base = pluginBundleLayers(db, storage);
  return Layer.mergeAll(
    base,
    PluginCatalogService.layer.pipe(Layer.provide(base)),
  ).pipe(Layer.provide(SettingsAudit.layer));
};

const catalogData = (catalog: StoredPluginCatalog) => ({
  id: catalog.id,
  scope: catalog.target.scope,
  name: catalog.name,
  description: catalog.description,
  ...(catalog.ownerName === undefined ? {} : { ownerName: catalog.ownerName }),
  source: catalog.source,
  entries: catalog.entries,
  publishers: catalog.publishers,
  addedAt: catalog.addedAt,
  refreshedAt: catalog.refreshedAt,
});

const rejected = (reason: string) => new PluginBundleRejected({ reason });

/** The bundle routes' answers, plus a missing catalog. */
const failureResponse = (context: Context<AppEnv>, failure: unknown) =>
  failure instanceof PluginCatalogNotFound
    ? context.json(
        Schema.encodeUnknownSync(PluginCatalogNotFoundResponseSchema)({
          status: "error",
          data: {
            code: "PLUGIN_CATALOG_NOT_FOUND",
            message: "Catalog not found.",
            requestId: context.get("requestId"),
          },
        }),
        404,
      )
    : pluginBundleFailureResponse(context, failure);

const run = async <A, E>(
  context: Context<AppEnv>,
  operation: Effect.Effect<A, E>,
  status: 200 | 201 = 200,
) => {
  const result = await Effect.runPromise(Effect.result(operation));
  return Result.isSuccess(result)
    ? context.json(result.success, status)
    : failureResponse(context, result.failure);
};

const registerRoutes = (
  router: Hono<AppEnv>,
  routeFor: (context: Context<AppEnv>) => RouteScope,
) => {
  const operation = <A, E, R>(
    context: Context<AppEnv>,
    use: (access: BundleAccess) => Effect.Effect<A, E, R>,
    options: { readonly mutate: boolean },
  ) =>
    Effect.gen(function* () {
      const db = yield* decodeD1Binding(context.env.DB);
      return yield* Effect.gen(function* () {
        const access = yield* authorizePluginBundles(
          routeFor(context),
          context.get("principal"),
        );
        if (options.mutate && !access.canMutate) {
          return yield* new SettingsScopeForbidden({ scope: "workspace" });
        }
        return yield* use(access);
      }).pipe(Effect.provide(layers(db, context.env.DX_STORAGE)));
    });
  const audit = (context: Context<AppEnv>) => ({
    userId: context.get("principal").userId,
    requestId: context.get("requestId"),
  });
  const parseId = (context: Context<AppEnv>) =>
    decodeRequestInput(
      PluginCatalogParamsSchema,
      { catalogId: context.req.param("catalogId") },
      () => new PluginCatalogNotFound(),
    ).pipe(Effect.map(({ catalogId }) => catalogId));

  router.get("/", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const catalogs = yield* PluginCatalogRepository;
            const items = yield* catalogs.list(access.target);
            return yield* Schema.encodeUnknownEffect(
              ListPluginCatalogsResponseSchema,
            )({
              status: "success",
              data: {
                items: items.map(catalogData),
                canMutate: access.canMutate,
              },
            });
          }),
        { mutate: false },
      ),
    ),
  );

  router.post("/", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const { url } = yield* decodeJsonBody(
              context.req,
              AddPluginCatalogRequestSchema,
              () => rejected("Send the catalog's GitHub URL."),
            );
            const service = yield* PluginCatalogService;
            const added = yield* service.add(
              access.target,
              url,
              audit(context),
            );
            return yield* Schema.encodeUnknownEffect(
              AddPluginCatalogResponseSchema,
            )({ status: "success", data: catalogData(added) });
          }),
        { mutate: true },
      ),
      201,
    ),
  );

  router.post("/:catalogId/refresh", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const id = yield* parseId(context);
            const service = yield* PluginCatalogService;
            const refreshed = yield* service.refresh(
              access.target,
              id,
              audit(context),
            );
            return yield* Schema.encodeUnknownEffect(
              RefreshPluginCatalogResponseSchema,
            )({ status: "success", data: catalogData(refreshed) });
          }),
        { mutate: true },
      ),
    ),
  );

  // Reads one entry through the plugin import; installs nothing. Installing
  // sends the previewed source to the plugin bundle install route.
  router.post("/:catalogId/entries/preview", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const id = yield* parseId(context);
            const { name } = yield* decodeJsonBody(
              context.req,
              PreviewPluginCatalogEntryRequestSchema,
              () => rejected("Send the plugin's name."),
            );
            const catalogs = yield* PluginCatalogService;
            const input = yield* catalogs.entryInput(access.target, id, name);
            const bundles = yield* PluginBundleService;
            const preview = yield* bundles.preview(access.target, input);
            return yield* Schema.encodeUnknownEffect(
              PreviewPluginBundleResponseSchema,
            )({
              status: "success",
              data: {
                manifest: preview.bundle.manifest,
                source: preview.source,
                integrity: preview.bundle.integrity,
                conflicts: preview.conflicts,
                ...(yield* previewSignature(
                  preview.signature,
                  context.get("principal").userId,
                )),
              },
            });
          }),
        { mutate: true },
      ),
    ),
  );

  router.delete("/:catalogId", (context) =>
    run(
      context,
      operation(
        context,
        (access) =>
          Effect.gen(function* () {
            const id = yield* parseId(context);
            const service = yield* PluginCatalogService;
            yield* service.remove(access.target, id, audit(context));
            return yield* Schema.encodeUnknownEffect(
              RemovePluginCatalogResponseSchema,
            )({ status: "success", data: { removedCatalogId: id } });
          }),
        { mutate: true },
      ),
    ),
  );
};

export const personalPluginCatalogRoutes = new Hono<AppEnv>();
registerRoutes(personalPluginCatalogRoutes, () => ({ mode: "personal" }));

export const workspacePluginCatalogRoutes = new Hono<AppEnv>();
registerRoutes(workspacePluginCatalogRoutes, (context) => ({
  mode: "workspace",
  workspaceSlug: context.req.param("workspaceSlug") ?? "",
}));
