import { createSign } from "node:crypto";

/**
 * Checks the deployment's GitHub App against what dx needs: the events in
 * GITHUB_APP_EVENTS (packages/domain/src/source-control/
 * github-app-configuration.ts, kept equal by settings.test.mjs) and the
 * repository permissions those events need, at least read. With the App's
 * JSON it signs a ten-minute App JWT and reads `GET /app`; the key and the JWT
 * are never printed. With only the App's slug it reads the public
 * `GET /apps/<slug>`.
 */

/** dx's events, in the words GitHub's "Subscribe to events" list uses. */
export const GITHUB_APP_EVENT_NAMES = Object.freeze({
  repository: "Repository",
  check_run: "Check run",
  check_suite: "Check suite",
  status: "Status",
  workflow_run: "Workflow run",
  pull_request: "Pull request",
  pull_request_review: "Pull request review",
  pull_request_review_comment: "Pull request review comment",
  issue_comment: "Issue comment",
  issues: "Issues",
});

/** Repository permissions those events need, as GitHub's settings name them. */
export const GITHUB_APP_EVENT_PERMISSIONS = Object.freeze({
  actions: "Actions",
  checks: "Checks",
  statuses: "Commit statuses",
  issues: "Issues",
  pull_requests: "Pull requests",
});

const base64Url = (value) => Buffer.from(value).toString("base64url");

export const githubAppJwt = ({ appId, privateKeyPem, now = Date.now() }) => {
  const seconds = Math.floor(now / 1000);
  const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(
    JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }),
  )}`;
  const signature = createSign("RSA-SHA256")
    .update(unsigned)
    .sign(privateKeyPem, "base64url");
  return `${unsigned}.${signature}`;
};

/** What the App lacks, from `GET /app`'s `events` and `permissions`. */
export const githubAppGaps = (app) => {
  const events = new Set(app.events ?? []);
  const permissions = app.permissions ?? {};
  return {
    events: Object.entries(GITHUB_APP_EVENT_NAMES)
      .filter(([event]) => !events.has(event))
      .map(([, name]) => name),
    permissions: Object.entries(GITHUB_APP_EVENT_PERMISSIONS)
      .filter(
        ([permission]) =>
          permissions[permission] !== "read" &&
          permissions[permission] !== "write",
      )
      .map(([, name]) => name),
  };
};

/** Exactly what to change in GitHub, with the click path; empty when none. */
export const githubAppGapReport = ({ slug, gaps }) => {
  if (gaps.events.length === 0 && gaps.permissions.length === 0) return [];
  const lines = [
    `The GitHub App ${slug} is missing what dx needs. In GitHub:`,
    `1. Open the App's settings. For a personal App: your avatar → Settings → Developer settings → GitHub Apps → Edit next to ${slug}. For an organization's App: the org's Settings → Developer settings → GitHub Apps → Edit.`,
  ];
  let step = 2;
  if (gaps.permissions.length > 0)
    lines.push(
      `${step++}. Click Permissions & events. Under Repository permissions, set each of these to at least Read-only: ${gaps.permissions.join(", ")}. GitHub shows an event's checkbox only once its permission is set.`,
    );
  if (gaps.events.length > 0)
    lines.push(
      `${step++}. ${gaps.permissions.length > 0 ? "Scroll" : "Click Permissions & events and scroll"} to Subscribe to events and tick: ${gaps.events.join(", ")}.`,
    );
  lines.push(
    `${step++}. Click Save changes.`,
    `${step}. If GitHub says the installations must accept new permissions: your avatar (or the org) → Settings → Applications → Installed GitHub Apps → ${slug} → Review request → Accept new permissions.`,
  );
  return lines;
};

/** The `appSlug` in an App's JSON, without reading anything else from it. */
export const appSlugOf = (appJson) => {
  try {
    const { appSlug } = JSON.parse(appJson);
    return typeof appSlug === "string" ? appSlug : undefined;
  } catch {
    return undefined;
  }
};

const GITHUB_API_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "dx-configure",
  "X-GitHub-Api-Version": "2022-11-28",
};

const SLUG = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * Reads the App and returns the report lines (empty when nothing is
 * missing). With `appJson` (the DX_INTEGRATION_GITHUB_APP value) it signs in
 * as the App, which works for a private App too. With only `slug` it reads
 * GitHub's public `GET /apps/<slug>`, which needs no key but sees only a
 * public App.
 */
export const checkGitHubApp = async ({
  appJson,
  slug,
  fetch: fetchImpl = fetch,
}) => {
  if (appJson === undefined) {
    if (typeof slug !== "string" || !SLUG.test(slug))
      throw new Error(
        "Give the App's slug: the name in github.com/apps/<slug>.",
      );
    const response = await fetchImpl(`https://api.github.com/apps/${slug}`, {
      headers: GITHUB_API_HEADERS,
    });
    if (response.status === 404)
      throw new Error(
        `GitHub has no public App named ${slug}. A private App is checked with its JSON instead.`,
      );
    if (!response.ok)
      throw new Error(
        `GitHub did not return the App (HTTP ${response.status}).`,
      );
    const body = await response.json();
    return githubAppGapReport({
      slug: body.slug ?? slug,
      gaps: githubAppGaps(body),
    });
  }
  let app;
  try {
    app = JSON.parse(appJson);
  } catch {
    throw new Error("The GitHub App JSON is not valid JSON.");
  }
  if (typeof app.appId !== "string" || typeof app.privateKeyPem !== "string")
    throw new Error("The GitHub App JSON has no appId or privateKeyPem.");
  const response = await fetchImpl("https://api.github.com/app", {
    headers: {
      ...GITHUB_API_HEADERS,
      Authorization: `Bearer ${githubAppJwt(app)}`,
    },
  });
  if (!response.ok)
    throw new Error(
      `GitHub did not accept the App's credentials (HTTP ${response.status}); check appId and privateKeyPem.`,
    );
  const body = await response.json();
  return githubAppGapReport({
    slug: body.slug ?? app.appSlug ?? "dx",
    gaps: githubAppGaps(body),
  });
};
