import { env } from "cloudflare:test";
import type { CreateProjectResponse, CreateThreadResponse } from "@dx/api";
import { Principal, UserId } from "@dx/domain";
import { Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, expect } from "vitest";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { projectRoutes } from "../../src/projects/routes.js";
import { threadRoutes } from "../../src/threads/routes.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";

export const owner = Schema.decodeUnknownSync(UserId)("product-route-owner");
const otherOwner = Schema.decodeUnknownSync(UserId)("product-route-other");
export const principal = Schema.decodeUnknownSync(Principal)({
  userId: owner,
  credentialScopes: ["personal", "workspace"],
});
export const otherPrincipal = Schema.decodeUnknownSync(Principal)({
  userId: otherOwner,
  credentialScopes: ["personal", "workspace"],
});

export const bindings: Bindings = {
  DB: env.DB,
  AI: { run: async () => ({}) } as unknown as Ai,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
};
export const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "x-request-id": "product-route-test",
};

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(owner, "Product Owner", "product-owner@example.com", 1, 1),
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(
      otherOwner,
      "Other Product Owner",
      "product-other@example.com",
      1,
      1,
    ),
  ]);
});

export const createProductApp = (requestPrincipal = principal) => {
  const productApp = new Hono<AppEnv>();
  productApp.use("*", requestId);
  productApp.use("*", async (context, next) => {
    context.set("principal", requestPrincipal);
    await next();
  });
  productApp.route("/projects", projectRoutes);
  productApp.route("/threads", threadRoutes);
  productApp.use("/agents/:threadId", authorizeThread);
  productApp.use("/agents/:threadId/:subpath{.+}", authorizeThread);
  productApp.all("/agents/:threadId/*", (context) =>
    context.json({ native: true }),
  );
  productApp.onError(errorHandler);
  return productApp;
};

export const createProjectViaApi = async (name = "Product") => {
  const response = await createProductApp().request(
    "/projects",
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name }),
    },
    bindings,
  );
  expect(response.status).toBe(201);
  return response.json<CreateProjectResponse>();
};

export const createThreadViaApi = async (projectId: string) => {
  const response = await createProductApp().request(
    "/threads",
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ projectId, title: "Test thread" }),
    },
    bindings,
  );
  expect(response.status).toBe(201);
  return response.json<CreateThreadResponse>();
};
