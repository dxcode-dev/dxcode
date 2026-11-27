import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { useAgentAdmission } from "../../src/agents/admission.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { withStoredIds } from "../../src/http/public-ids.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv } from "../../src/http/types.js";
import {
  bindings,
  createProjectViaApi,
  createThreadViaApi,
  principal,
} from "./product-route-fixture.js";

/**
 * Flue names a Thread's Durable Object from the `:id` its router sees, after
 * Hono decodes the path. Every spelling of a Thread's ID must reach it as the
 * stored `thr_<uuid>`, or turns run as the Thread while its transcript goes
 * to an object the owner never reads or deletes (#2622).
 */
const agentApp = () => {
  const named: string[] = [];
  // Flue's router names the Thread `:id`, as `createAgentRouter` does.
  const flue = new Hono<AppEnv>();
  flue.get("/:id", (context) => {
    named.push(context.req.param("id"));
    return context.json({ entries: [] }, 200);
  });
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set("principal", principal);
    await next();
  });
  app.route(
    "/v1/agents/dx",
    useAgentAdmission(new Hono<AppEnv>()).route("/", flue),
  );
  app.onError(errorHandler);
  const fetch = withStoredIds(app.fetch);
  const request = (path: string) =>
    fetch(new Request(`http://dx.test${path}`), bindings);
  return { request, named };
};

describe("Public Thread IDs in agent paths", () => {
  it("reach Flue as the stored ID however the path spells them", async () => {
    const project = (await createProjectViaApi("public-thread-ids")).data;
    const thread = (await createThreadViaApi(project.id)).data;
    const uuid = thread.id.slice("thr_".length);
    const { request, named } = agentApp();

    const paths = [
      `/v1/agents/dx/${thread.id}`,
      `/v1/agents/dx/t-${uuid}`,
      `/v1/agents/dx/T-${uuid.toUpperCase()}`,
      `/v1/agents/dx/%74-${uuid}`,
      `/v1/agents/dx/%54%2d${uuid}`,
      `/v1/%61gents/dx/%74-${uuid}`,
    ];
    const reached: Record<string, unknown> = {};
    for (const path of paths) {
      named.length = 0;
      const response = (await request(path)) as Response;
      reached[path] = { status: response.status, flueId: named[0] };
    }
    expect(reached).toEqual(
      Object.fromEntries(
        paths.map((path) => [path, { status: 200, flueId: thread.id }]),
      ),
    );
  });
});
