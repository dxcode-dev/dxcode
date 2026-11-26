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

const served = new Set(
  app.routes
    .filter(({ method, path }) => method !== "ALL" && path.startsWith("/v1/"))
    .map(({ method, path }) => `${method} ${path}`),
);
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

  it("publishes no private deployment path in OpenAPI", () => {
    const paths = Object.keys(
      toOpenApiDocument(dxEndpoints, { version: "test" }).paths,
    );
    // Private endpoints belong in deploymentEndpoints, never dxEndpoints.
    expect(
      paths.filter(
        (path) =>
          path.startsWith("/v1/deployment-admin") ||
          path.startsWith("/v1/deployment/cloud"),
      ),
    ).toEqual([]);
  });

  it("serves every endpoint defined in @dx/api", () => {
    expect(defined.filter((route) => !served.has(route))).toEqual([]);
  });

  it("defines an endpoint for every new /v1 route", () => {
    const known = new Set([...defined, ...legacy, ...nonClient]);
    // A route here needs `defineEndpoint` in @dx/api and a line in
    // packages/api/src/endpoints.ts, or a line in non-client-routes.txt if
    // no dx UI calls it.
    expect([...served].filter((route) => !known.has(route)).sort()).toEqual([]);
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
