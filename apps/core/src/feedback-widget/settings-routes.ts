import {
  FeedbackWidgetForbiddenResponseSchema,
  FeedbackWidgetInvalidOriginResponseSchema,
  FeedbackWidgetInvalidRequestResponseSchema,
  FeedbackWidgetNotFoundResponseSchema,
  FeedbackWidgetOriginRequestSchema,
  FeedbackWidgetParamsSchema,
  FeedbackWidgetTooManyOriginsResponseSchema,
  GetFeedbackWidgetResponseSchema,
} from "@dx/api";
import {
  normalizeFeedbackWidgetOrigin,
  type Principal,
  type ProjectId,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Option, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import { loadAuthenticationRequirements } from "../auth/requirements.js";
import { readBoundedJson } from "../http/bounded-body.js";
import type { AppEnv } from "../http/types.js";
import { feedbackWidgetLogger } from "../logging.js";
import { ProjectRepositoryD1 } from "../projects/repository-d1.js";
import { ProjectService } from "../projects/service.js";
import {
  addOrigin,
  canManageProject,
  disableWidget,
  enableWidget,
  readProjectWidget,
  removeOrigin,
} from "./store.js";

/**
 * Project Settings → Feedback Widget. Reading it takes reaching the Project;
 * turning it on or off and changing its origins takes managing the Project.
 * Every route refuses people without the experimental flag.
 */

const errorBody = (code: string, message: string, requestId: string) => ({
  status: "error" as const,
  data: { code, message, requestId },
});

/** Answers with one of the error responses `@dx/api` declares for these routes. */
const fail = (
  context: Context<AppEnv>,
  schema: {
    readonly fields: {
      readonly data: {
        readonly fields: {
          readonly code: { readonly literal: string };
          readonly message: { readonly literal: string };
        };
      };
    };
  },
  status: 400 | 403 | 404,
) =>
  context.json(
    errorBody(
      schema.fields.data.fields.code.literal,
      schema.fields.data.fields.message.literal,
      context.get("requestId"),
    ),
    status,
  );

export const reachableProject = (
  db: D1Database,
  principal: Principal,
  projectId: ProjectId,
) =>
  Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        return yield* (yield* ProjectService).get(principal, projectId);
      }).pipe(
        Effect.provide(
          ProjectService.layer.pipe(
            Layer.provide(
              ProjectRepositoryD1.pipe(Layer.provide(D1Client.layer({ db }))),
            ),
          ),
        ),
      ),
    ),
  ).then((result) => (Result.isSuccess(result) ? result.success : undefined));

export const appOrigin = async (bindings: AppEnv["Bindings"]) =>
  new URL(
    (await Effect.runPromise(loadAuthenticationRequirements(bindings))).authUrl,
  ).origin;

const widgetData = async (
  context: Context<AppEnv>,
  db: D1Database,
  projectId: ProjectId,
) => {
  const widget = await readProjectWidget(db, projectId);
  const origin = await appOrigin(context.env);
  return context.json(
    Schema.encodeUnknownSync(GetFeedbackWidgetResponseSchema)({
      status: "success",
      data: {
        enabled: widget.clientId !== undefined,
        ...(widget.clientId === undefined
          ? {}
          : {
              clientId: widget.clientId,
              scriptUrl: `${origin}/api/feedback-widget/${widget.clientId}.js`,
            }),
        allowedOrigins: widget.origins,
      },
    }),
    200,
  );
};

type Access = "read" | "manage";

/** Runs a route after the flag, the Project, and the access it needs. */
const withProject =
  (
    access: Access,
    handle: (
      context: Context<AppEnv>,
      db: D1Database,
      projectId: ProjectId,
    ) => Promise<Response>,
  ) =>
  async (context: Context<AppEnv>) => {
    const params = Schema.decodeUnknownOption(FeedbackWidgetParamsSchema)({
      projectId: context.req.param("projectId"),
    });
    if (Option.isNone(params))
      return fail(context, FeedbackWidgetInvalidRequestResponseSchema, 400);
    const principal = context.get("principal");
    const db = context.env.DB as D1Database;
    const projectId = params.value.projectId;
    if ((await reachableProject(db, principal, projectId)) === undefined)
      return fail(context, FeedbackWidgetNotFoundResponseSchema, 404);
    if (
      access === "manage" &&
      !(await canManageProject(db, projectId, principal.userId))
    )
      return fail(context, FeedbackWidgetForbiddenResponseSchema, 403);
    return handle(context, db, projectId);
  };

const originBody = async (context: Context<AppEnv>) => {
  const body = await readBoundedJson(context.req.raw).catch(() => undefined);
  const decoded = Schema.decodeUnknownOption(FeedbackWidgetOriginRequestSchema)(
    body,
  );
  if (Option.isNone(decoded)) return undefined;
  return normalizeFeedbackWidgetOrigin(decoded.value.origin) ?? null;
};

const audit = (
  context: Context<AppEnv>,
  projectId: ProjectId,
  action: string,
  origin?: string,
) =>
  feedbackWidgetLogger.info("Feedback Widget changed.", {
    event: "feedback_widget_change",
    action,
    projectId,
    ...(origin === undefined ? {} : { origin }),
    actorUserId: context.get("principal").userId,
    requestId: context.get("requestId"),
  });

export const feedbackWidgetSettingsRoutes = new Hono<AppEnv>()
  .get(
    "/:projectId/feedback-widget",
    withProject("read", (context, db, projectId) =>
      widgetData(context, db, projectId),
    ),
  )
  .post(
    "/:projectId/feedback-widget/enable",
    withProject("manage", async (context, db, projectId) => {
      await enableWidget(db, projectId, context.get("principal").userId);
      audit(context, projectId, "enable");
      return widgetData(context, db, projectId);
    }),
  )
  .post(
    "/:projectId/feedback-widget/disable",
    withProject("manage", async (context, db, projectId) => {
      await disableWidget(db, projectId);
      audit(context, projectId, "disable");
      return widgetData(context, db, projectId);
    }),
  )
  .post(
    "/:projectId/feedback-widget/origins",
    withProject("manage", async (context, db, projectId) => {
      const origin = await originBody(context);
      if (origin === undefined)
        return fail(context, FeedbackWidgetInvalidRequestResponseSchema, 400);
      if (origin === null)
        return fail(context, FeedbackWidgetInvalidOriginResponseSchema, 400);
      if ((await addOrigin(db, projectId, origin)) === "too-many")
        return fail(context, FeedbackWidgetTooManyOriginsResponseSchema, 400);
      audit(context, projectId, "add-origin", origin);
      return widgetData(context, db, projectId);
    }),
  )
  .post(
    "/:projectId/feedback-widget/origins/remove",
    withProject("manage", async (context, db, projectId) => {
      const origin = await originBody(context);
      if (origin === undefined || origin === null)
        return fail(context, FeedbackWidgetInvalidRequestResponseSchema, 400);
      await removeOrigin(db, projectId, origin);
      audit(context, projectId, "remove-origin", origin);
      return widgetData(context, db, projectId);
    }),
  );
