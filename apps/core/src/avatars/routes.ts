import { Hono } from "hono";
import type { AppEnv } from "../http/types.js";

const avatarFile = /^[0-9a-f-]{36}\.(?:png|jpg|webp)$/;

const notFound = (requestId: string) =>
  Response.json(
    {
      status: "error",
      data: {
        code: "AVATAR_NOT_FOUND",
        message: "Avatar not found.",
        requestId,
      },
    },
    { status: 404 },
  );

const serve = async (
  storage: R2Bucket | undefined,
  key: string,
  requestId: string,
) => {
  const object = await storage?.get(key);
  if (object === null || object === undefined) return notFound(requestId);
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "image/png",
      // Each upload gets a new URL, so a URL's bytes never change.
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      etag: object.httpEtag,
    },
  });
};

/**
 * Serves uploaded pictures. A person's picture is visible to anyone signed
 * in, like the identity provider image it replaces; a workspace's only to its
 * members. Only the current picture is served.
 */
export const avatarRoutes = new Hono<AppEnv>();

avatarRoutes.get("/users/:userId/:file", async (context) => {
  const requestId = context.get("requestId");
  const { userId, file } = context.req.param();
  if (!avatarFile.test(file)) return notFound(requestId);
  const key = `avatars/users/${userId}/${file}`;
  const current = await context.env.DB?.prepare(
    "SELECT 1 FROM personal_account WHERE user_id = ? AND avatar_key = ?",
  )
    .bind(userId, key)
    .first();
  if (current === null || current === undefined) return notFound(requestId);
  return serve(context.env.DX_STORAGE, key, requestId);
});

avatarRoutes.get("/workspaces/:workspaceId/:file", async (context) => {
  const requestId = context.get("requestId");
  const { workspaceId, file } = context.req.param();
  if (!avatarFile.test(file)) return notFound(requestId);
  const key = `avatars/workspaces/${workspaceId}/${file}`;
  const current = await context.env.DB?.prepare(
    `SELECT 1 FROM organization
       JOIN member ON member.organizationId = organization.id
      WHERE organization.id = ? AND organization.avatar_key = ?
        AND member.userId = ?`,
  )
    .bind(workspaceId, key, context.get("principal").userId)
    .first();
  if (current === null || current === undefined) return notFound(requestId);
  return serve(context.env.DX_STORAGE, key, requestId);
});
