import { readdirSync, readFileSync } from "node:fs";
import {
  deploymentEndpoints,
  dxEndpoints,
  openApiProblems,
  toOpenApiDocument,
} from "@dx/api";
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
  RpcTarget: class {},
  WorkerEntrypoint: class {},
  env: { DX_RUNTIME_MODE: "deployed" },
}));

import app from "../app.js";

/**
 * The headless contract (wiki/headless-client.md): every endpoint a client
 * calls is defined in @dx/api and served here, and every /v1 route Core
 * serves is either such an endpoint or listed as legacy or non-client.
 */
const routeList = (file: URL) =>
  readFileSync(file, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

const routes = app.routes
  .filter(({ method }) => method !== "ALL")
  .map(({ method, path }) => `${method} ${path}`);
/** The /v1 routes, each an endpoint or listed as non-client. */
const served = new Set(routes.filter((route) => route.includes(" /v1/")));
/** The public endpoints, and those only dx's own deployment serves. */
const endpoints = [...dxEndpoints, ...deploymentEndpoints];
const defined = endpoints.map(({ method, path }) => `${method} ${path}`);
// Routes served only by private code are listed in another
// legacy-client-routes.txt and non-client-routes.txt, in a folder the public
// export leaves out, so the public tree checks only the routes it serves.
const coreSource = new URL("../", import.meta.url);
const coreFiles = readdirSync(coreSource, {
  recursive: true,
  encoding: "utf8",
}).map((path) => new URL(path, coreSource));
/** The public list `name` beside this test, then every private one. */
const routeLists = (name: string) => {
  const publicFile = new URL(`./${name}`, import.meta.url);
  return [
    ...routeList(publicFile),
    ...coreFiles
      .filter(
        (file) =>
          file.pathname.endsWith(`/${name}`) && file.href !== publicFile.href,
      )
      .flatMap(routeList),
  ];
};
const legacy = routeLists("legacy-client-routes.txt");
const nonClient = routeLists("non-client-routes.txt");

describe("headless endpoint contract", () => {
  it("gives every endpoint a unique id and route", () => {
    const ids = endpoints.map(({ id }) => id);
    expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
    // One route may be defined once per upload kind, such as a JSON body
    // and raw ZIP bytes; OpenAPI lists them as one operation.
    const variants = endpoints.map(
      ({ method, path, upload }) => `${method} ${path} (${upload})`,
    );
    expect(
      variants.filter((route, index) => variants.indexOf(route) !== index),
    ).toEqual([]);
  });

  it("describes every endpoint in OpenAPI", () => {
    // Each line names the endpoint, what is wrong, and how to fix it. The
    // deployment's own endpoints are checked too, and together with the
    // public ones, so an id is unique across both, though only dxEndpoints
    // are published.
    expect(openApiProblems(endpoints)).toEqual([]);
  });

  it("publishes no private deployment endpoint in OpenAPI", () => {
    // Private endpoints belong in deploymentEndpoints, never dxEndpoints.
    // Public Core serves a few deployment-admin routes (the admin status,
    // user lookup), so the test names the private endpoints, not a prefix.
    const publicRoutes = new Set(
      dxEndpoints.map(({ method, path }) => `${method} ${path}`),
    );
    expect(
      deploymentEndpoints
        .filter(({ method, path }) => publicRoutes.has(`${method} ${path}`))
        .map(({ id }) => id),
    ).toEqual([]);
    const { paths } = toOpenApiDocument(dxEndpoints, { version: "test" });
    const operations = paths as Record<string, Record<string, unknown>>;
    expect(
      deploymentEndpoints
        .filter(
          ({ method, path }) =>
            operations[path.replace(/:([A-Za-z0-9_]+)(\{[^}]*\})?/g, "{$1}")]?.[
              method.toLowerCase()
            ] !== undefined,
        )
        .map(({ id }) => id),
    ).toEqual([]);
    // The hosted offer's billing routes are private, whatever lists them.
    expect(
      Object.keys(paths).filter((path) =>
        path.startsWith("/v1/deployment/cloud"),
      ),
    ).toEqual([]);
  });

  it("serves every endpoint defined in @dx/api", () => {
    // An endpoint may sit outside /v1, such as the signed-out invite
    // preview at /api/invites/:token.
    const all = new Set(routes);
    expect(defined.filter((route) => !all.has(route))).toEqual([]);
  });

  it("defines an endpoint for every new /v1 route", () => {
    const known = new Set([...defined, ...legacy, ...nonClient]);
    // A route here needs `defineEndpoint` in @dx/api and a line in
    // packages/api/src/endpoints.ts, or a line in non-client-routes.txt if
    // no dx UI calls it.
    expect([...served].filter((route) => !known.has(route)).sort()).toEqual([]);
  });

  it("leaves no legacy client route", () => {
    // The migration is done: a new route gets an endpoint, or a line in
    // non-client-routes.txt when no dx UI calls it (wiki/headless-client.md).
    expect(legacy).toEqual([]);
  });

  it("keeps the legacy and non-client lists to routes that need them", () => {
    const definedRoutes = new Set(defined);
    // Delete these lines: the route has an endpoint now, or is gone.
    expect(
      [...legacy, ...nonClient].filter(
        (route) => definedRoutes.has(route) || !served.has(route),
      ),
    ).toEqual([]);
    expect(legacy.filter((route) => nonClient.includes(route))).toEqual([]);
    // A route sits in one list once, public or private.
    for (const list of [legacy, nonClient])
      expect(
        list.filter((route, index) => list.indexOf(route) !== index),
      ).toEqual([]);
  });
});
