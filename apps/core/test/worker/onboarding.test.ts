import { Principal, type UserId } from "@dx/domain";
import { Schema } from "effect";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv } from "../../src/http/types.js";
import { onboardingRoutes } from "../../src/onboarding/routes.js";
import { bindings } from "./product-route-fixture.js";

const app = (userId: UserId) => {
  const routes = new Hono<AppEnv>();
  routes.use("*", requestId);
  routes.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId,
        credentialScopes: ["personal", "workspace"],
      }),
    );
    await next();
  });
  routes.route("/onboarding", onboardingRoutes);
  routes.onError(errorHandler);
  return routes;
};

interface Progress {
  readonly setupFinishedAt: string | null;
  readonly tourFinishedAt: string | null;
  readonly checklistHiddenAt: string | null;
}

const progress = async (userId: UserId) => {
  const response = await app(userId).request("/onboarding", {}, bindings);
  expect(response.status).toBe(200);
  return (await response.json<{ data: Progress }>()).data;
};

const mark = (userId: UserId, body: unknown) =>
  app(userId).request(
    "/onboarding",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    bindings,
  );

describe("Onboarding progress", () => {
  it("starts empty for a new account and records each milestone once", async () => {
    const person = "onboarding-new" as UserId;
    const other = "onboarding-other" as UserId;
    expect(await progress(person)).toEqual({
      setupFinishedAt: null,
      tourFinishedAt: null,
      checklistHiddenAt: null,
    });

    const setup = await mark(person, { done: "setup" });
    expect(setup.status).toBe(200);
    // The response is the whole progress, so a client can replace its copy.
    const afterSetup = (await setup.json<{ data: Progress }>()).data;
    expect(afterSetup.setupFinishedAt).toEqual(expect.any(String));
    expect(afterSetup.tourFinishedAt).toBeNull();
    expect(afterSetup.checklistHiddenAt).toBeNull();

    // Marking again keeps the first time.
    await mark(person, { done: "setup" });
    expect((await progress(person)).setupFinishedAt).toBe(
      afterSetup.setupFinishedAt,
    );

    await mark(person, { done: "tour" });
    await mark(person, { done: "checklist" });
    const done = await progress(person);
    expect(done.setupFinishedAt).toBe(afterSetup.setupFinishedAt);
    expect(done.tourFinishedAt).toEqual(expect.any(String));
    expect(done.checklistHiddenAt).toEqual(expect.any(String));

    // Nobody else's progress moved.
    expect(await progress(other)).toEqual({
      setupFinishedAt: null,
      tourFinishedAt: null,
      checklistHiddenAt: null,
    });
  });

  it("rejects an unknown milestone without recording anything", async () => {
    const person = "onboarding-invalid" as UserId;
    const response = await mark(person, { done: "everything" });
    expect(response.status).toBe(400);
    expect((await response.json<{ data: { code: string } }>()).data.code).toBe(
      "INVALID_REQUEST",
    );
    expect((await progress(person)).setupFinishedAt).toBeNull();
  });
});
