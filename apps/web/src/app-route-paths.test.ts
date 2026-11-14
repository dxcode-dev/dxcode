// @vitest-environment happy-dom

import { APP_ROUTE_PATHS, isAppRoutePath } from "@dx/api";
import { UserId } from "@dx/domain";
import { createMemoryHistory } from "@tanstack/react-router";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { createPublicRouter } from "./features/authentication/public-router.js";
import { createAppRouter } from "./router.js";
import { createQueryClient } from "./shared/query/query-client.js";

const userId = Schema.decodeUnknownSync(UserId)("user-1");

// A page the router opens but Core does not list answers a reload or a
// shared link with 404; a listed path the router has not answers 200.
const routerPaths = () => {
  const history = () => createMemoryHistory({ initialEntries: ["/"] });
  const routers = [
    createAppRouter({ queryClient: createQueryClient(), userId }, history()),
    createPublicRouter(createQueryClient()),
  ];
  return new Set(
    routers
      .flatMap((router) => Object.keys(router.routesByPath))
      // The signed-out catch-all only sends any other URL to sign-in.
      .filter((path) => path !== "/$"),
  );
};

describe("App pages Core answers with 200", () => {
  it("cover every page the web app's routers open, and only those", () => {
    const paths = routerPaths();
    for (const path of paths)
      expect(isAppRoutePath(path.replaceAll(/\$\w+/g, "x")), path).toBe(true);
    for (const path of APP_ROUTE_PATHS)
      expect(paths.has(path), path).toBe(true);
  });

  it("match a page's URL and nothing else", () => {
    for (const path of [
      "/",
      "/threads/thr_1",
      "/threads/thr_1/",
      "/workspaces/acme/members",
      "/bug-reports/all",
      "/plugins/com.acme.board/board",
      "/plugins/com.acme.board/board/",
      "/plugins/com.acme.board/board/a/b",
    ])
      expect(isAppRoutePath(path), path).toBe(true);
    for (const path of [
      "/no-such-page",
      "/threads",
      "/threads/thr_1/no-such-tab",
      "/threads//thr_1",
      "/docs/no-such-page",
      "/plugins/com.acme.board",
    ])
      expect(isAppRoutePath(path), path).toBe(false);
  });
});

describe("Signed-out URLs", () => {
  const landOn = async (path: string) => {
    const router = createPublicRouter(
      createQueryClient(),
      createMemoryHistory({ initialEntries: [path] }),
    );
    await router.load();
    return router.state.location.pathname;
  };

  it("send a dx page to sign-in, and keep any other URL to say it is not found", async () => {
    expect(await landOn("/threads/thr_1")).toBe("/signin");
    expect(await landOn("/workspaces/acme/members")).toBe("/signin");
    expect(await landOn("/no-such-page")).toBe("/no-such-page");
    expect(await landOn("/threads/thr_1/no-such-tab")).toBe(
      "/threads/thr_1/no-such-tab",
    );
  });
});
