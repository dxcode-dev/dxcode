/**
 * Every page the web app serves, in its router's path syntax: a `$name`
 * segment matches any one segment. Core answers these with the app and
 * status 200 on a reload or deep link, and any other unknown path with
 * status 404, so search engines index only real pages.
 */
export const APP_ROUTE_PATHS = [
  "/",
  "/new",
  "/signin",
  "/signup",
  "/join/$token",
  "/huddle/$workspace/$code",
  "/projects",
  "/projects/$projectId",
  "/projects/$projectId/settings",
  "/projects/$projectId/settings/$section",
  "/threads/$threadId",
  "/threads/$threadId/tree",
  "/artifacts",
  "/artifacts/$artifactId",
  "/bug-reports",
  "/bug-reports/$reportId",
  "/bug-reports/all",
  "/bug-reports/all/$reportId",
  "/settings",
  "/settings/$section",
  "/workspaces",
  "/workspaces/$workspaceSlug",
  "/workspaces/$workspaceSlug/$section",
] as const;

const segmentsOf = (path: string) =>
  path.split("/").filter((segment) => segment !== "");

const routeSegments = APP_ROUTE_PATHS.map(segmentsOf);

/** Whether a URL path, with or without a trailing slash, is an app page. */
export const isAppRoutePath = (pathname: string): boolean => {
  if (pathname.includes("//")) return false;
  const segments = segmentsOf(pathname);
  return routeSegments.some(
    (route) =>
      route.length === segments.length &&
      route.every(
        (segment, index) =>
          segment.startsWith("$") || segment === segments[index],
      ),
  );
};
