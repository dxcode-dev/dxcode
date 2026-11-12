import {
  FeedbackWidgetInvalidRequestResponseSchema,
  FeedbackWidgetInvalidScriptResponseSchema,
  GetPersonalFeedbackWidgetEmbedResponseSchema,
  UpdatePersonalFeedbackWidgetEmbedRequestSchema,
} from "@dx/api";
import { parseFeedbackWidgetScriptUrl } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import { readBoundedJson } from "../http/bounded-body.js";
import type { AppEnv } from "../http/types.js";
import { feedbackWidgetLogger } from "../logging.js";
import { activeMemberSql } from "../settings/members/membership-sql.js";
import { appOrigin } from "./settings-routes.js";

/**
 * Personal Settings → Feedback Widget on dx: which
 * widget this dx app loads for the person. Any dx host's widget may be
 * chosen; the app's Content-Security-Policy decides which hosts load.
 */

const errorJson = (
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
  status: 400 | 403,
) =>
  context.json(
    {
      status: "error",
      data: {
        code: schema.fields.data.fields.code.literal,
        message: schema.fields.data.fields.message.literal,
        requestId: context.get("requestId"),
      },
    },
    status,
  );

/** Projects on this dx with the widget on, that the person can reach. */
const availableProjects = async (db: D1Database, userId: string) =>
  (
    await db
      .prepare(
        `SELECT widget.project_id, widget.client_id, project.name AS project_name,
                COALESCE(workspace.name, owner.name) AS owner_name
           FROM project_feedback_widget AS widget
           JOIN projects AS project ON project.id = widget.project_id
           LEFT JOIN organization AS workspace ON workspace.id = project.workspace_id
           LEFT JOIN "user" AS owner ON owner.id = project.owner_user_id
          WHERE widget.client_id IS NOT NULL AND project.deleted_at IS NULL
            AND ((project.workspace_id IS NULL AND project.owner_user_id = ?1)
              OR (project.workspace_id IS NOT NULL
                AND ${activeMemberSql("project.workspace_id", "?1")}))
          ORDER BY project.name COLLATE NOCASE`,
      )
      .bind(userId)
      .all<{
        project_id: string;
        client_id: string;
        project_name: string;
        owner_name: string | null;
      }>()
  ).results;

const respond = async (context: Context<AppEnv>) => {
  const db = context.env.DB as D1Database;
  const userId = context.get("principal").userId;
  const [row, projects, origin] = await Promise.all([
    db
      .prepare(
        "SELECT script_url FROM personal_feedback_widget_embed WHERE user_id = ?",
      )
      .bind(userId)
      .first<{ script_url: string }>(),
    availableProjects(db, userId),
    appOrigin(context.env),
  ]);
  return context.json(
    Schema.encodeUnknownSync(GetPersonalFeedbackWidgetEmbedResponseSchema)({
      status: "success",
      data: {
        ...(row === null ? {} : { scriptUrl: row.script_url }),
        projects: projects.map((project) => ({
          projectId: project.project_id,
          projectLabel:
            project.owner_name === null
              ? project.project_name
              : `${project.owner_name}/${project.project_name}`,
          scriptUrl: `${origin}/api/feedback-widget/${project.client_id}.js`,
        })),
      },
    }),
    200,
  );
};

export const feedbackWidgetEmbedRoutes = new Hono<AppEnv>()
  .get("/", (context) => respond(context))
  .put("/", async (context) => {
    const decoded = Schema.decodeUnknownOption(
      UpdatePersonalFeedbackWidgetEmbedRequestSchema,
    )(await readBoundedJson(context.req.raw).catch(() => undefined));
    if (Option.isNone(decoded))
      return errorJson(
        context,
        FeedbackWidgetInvalidRequestResponseSchema,
        400,
      );
    const db = context.env.DB as D1Database;
    const userId = context.get("principal").userId;
    if (decoded.value.scriptUrl === null) {
      await db
        .prepare("DELETE FROM personal_feedback_widget_embed WHERE user_id = ?")
        .bind(userId)
        .run();
    } else {
      const parsed = parseFeedbackWidgetScriptUrl(decoded.value.scriptUrl);
      if (parsed === undefined)
        return errorJson(
          context,
          FeedbackWidgetInvalidScriptResponseSchema,
          400,
        );
      await db
        .prepare(
          `INSERT INTO personal_feedback_widget_embed (user_id, script_url, updated_at)
           VALUES (?1, ?2, ?3)
           ON CONFLICT (user_id) DO UPDATE SET
             script_url = excluded.script_url, updated_at = excluded.updated_at`,
        )
        .bind(userId, parsed.scriptUrl, new Date().toISOString())
        .run();
    }
    feedbackWidgetLogger.info("Feedback Widget on dx changed.", {
      event: "feedback_widget_embed_change",
      userId,
      host:
        decoded.value.scriptUrl === null
          ? undefined
          : parseFeedbackWidgetScriptUrl(decoded.value.scriptUrl)?.host,
      requestId: context.get("requestId"),
    });
    return respond(context);
  });
