import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { dispatch, setProvider } from "@flue/runtime";
import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";
import { authenticate } from "../../../src/auth/authenticate.js";
import { authorizeThread } from "../../../src/auth/authorize-thread.js";
import {
  errorHandler,
  notFoundHandler,
} from "../../../src/http/http-errors.js";
import { requestId } from "../../../src/http/request-id.js";
import { requestLogging } from "../../../src/http/request-logging.js";
import type { AppEnv } from "../../../src/http/types.js";
import { installFlueObservation } from "../../../src/observability/flue.js";
import { projectRoutes } from "../../../src/projects/routes.js";
import { settingsRoutes } from "../../../src/settings/routes.js";
import { createThreadRoutes } from "../../../src/threads/routes.js";
import { FixtureLifecycleAgent } from "./agents/fixture-lifecycle-agent.js";
import { settleDelayedCommand } from "./sandbox.js";

const faux = fauxProvider();
faux.setResponses([
  fauxAssistantMessage(
    [
      fauxToolCall("write", {
        path: "/home/user/dx-reference-marker.txt",
        content: "reference-lifecycle",
      }),
    ],
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage("first-complete"),
  fauxAssistantMessage(
    [
      fauxToolCall("read", { path: "/home/user/dx-reference-marker.txt" }),
      fauxToolCall("read", { path: "/.dx/initialization-count" }),
      fauxToolCall("read", { path: "/.dx/instance-id" }),
    ],
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage("continuation-complete"),
  fauxAssistantMessage(
    [fauxToolCall("bash", { command: "delayed-reference-command" })],
    { stopReason: "toolUse" },
  ),
  fauxAssistantMessage([fauxToolCall("read", { path: "/.dx/orphan-state" })], {
    stopReason: "toolUse",
  }),
  fauxAssistantMessage([fauxToolCall("read", { path: "/.dx/orphan-state" })], {
    stopReason: "toolUse",
  }),
  fauxAssistantMessage([fauxText("post-abort-complete")]),
  fauxAssistantMessage("retry-admission-complete"),
  fauxAssistantMessage("follow-up-image-complete"),
]);
setProvider(faux.provider);
installFlueObservation();

const observedReferenceHeaders: string[] = [];
const observedUpdateOffsets: string[] = [];
const nativeAdmissionStatuses: number[] = [];
let injectedUpdatesFailure = false;
let rejectNextInitialDispatch = false;
const initialThreadRows = new Map<string, unknown>();
const fixtureDb = (bindings: AppEnv["Bindings"]) => {
  if (bindings.DB === undefined)
    throw new Error("Fixture D1 binding is missing.");
  return bindings.DB;
};
const fixtureAi = { run: async () => ({}) } as unknown as Ai;
const threadRoutes = createThreadRoutes(
  (request) => {
    if (rejectNextInitialDispatch) {
      rejectNextInitialDispatch = false;
      return Promise.reject(new Error("Fixture rejected initial admission."));
    }
    return dispatch(FixtureLifecycleAgent, request);
  },
  // The reference lifecycle makes no model calls beyond its faux provider.
  async () => undefined,
);
const app = new Hono<AppEnv>();
app.use("*", async (context, next) => {
  (context.env as { AI?: Ai }).AI ??= fixtureAi;
  await next();
});
app.use("*", requestId);
app.use("*", requestLogging);
app.use("*", async (context, next) => {
  const sequence = context.req.header("x-dx-reference-request");
  if (sequence !== undefined) observedReferenceHeaders.push(sequence);
  const url = new URL(context.req.url);
  if (url.searchParams.get("view") === "updates") {
    const offset = url.searchParams.get("offset");
    if (offset !== null) observedUpdateOffsets.push(offset);
  }
  if (
    !injectedUpdatesFailure &&
    url.searchParams.get("view") === "updates" &&
    sequence !== undefined
  ) {
    injectedUpdatesFailure = true;
    return context.json({ fixture: "injected_updates_failure" }, 503);
  }
  await next();
  const nativeAbortThreadId = /^\/v1\/agents\/dx\/([^/]+)\/abort$/.exec(
    url.pathname,
  )?.[1];
  if (
    context.req.method === "POST" &&
    /^\/v1\/agents\/dx\/[^/]+$/.test(url.pathname)
  ) {
    nativeAdmissionStatuses.push(context.res.status);
  }
  if (
    context.req.method === "POST" &&
    context.res.status === 200 &&
    nativeAbortThreadId !== undefined
  ) {
    // Release the signal-deaf command only after Flue has produced the abort receipt.
    settleDelayedCommand(nativeAbortThreadId);
  }
  if (
    context.req.method === "POST" &&
    url.pathname === "/v1/threads" &&
    context.res.status === 201
  ) {
    const body = await context.res.clone().json<{ data: { id: string } }>();
    const row = await fixtureDb(context.env)
      .prepare(
        "SELECT id, project_id, owner_user_id, created_at, updated_at, last_activity_at, activity_status FROM threads WHERE id = ?",
      )
      .bind(body.data.id)
      .first();
    initialThreadRows.set(body.data.id, row);
  }
});
app.get("/__fixture/reference-headers", (context) =>
  context.json({
    sequences: observedReferenceHeaders,
    updateOffsets: observedUpdateOffsets,
    nativeAdmissionStatuses,
    injectedUpdatesFailure,
  }),
);
app.get("/__fixture/state/:threadId", async (context) => {
  const threadId = context.req.param("threadId");
  const currentThreadRow = await fixtureDb(context.env)
    .prepare(
      "SELECT id, project_id, owner_user_id, created_at, updated_at, last_activity_at, activity_status FROM threads WHERE id = ?",
    )
    .bind(threadId)
    .first();
  const activities = await fixtureDb(context.env)
    .prepare(
      "SELECT kind, occurred_at FROM thread_activity WHERE thread_id = ? ORDER BY sequence",
    )
    .bind(threadId)
    .all<{ kind: string; occurred_at: string }>();
  const submissions = await fixtureDb(context.env)
    .prepare(
      "SELECT state FROM thread_activity_submission WHERE thread_id = ? ORDER BY submission_id",
    )
    .bind(threadId)
    .all<{ state: string }>();
  const matchingThreadCount = await fixtureDb(context.env)
    .prepare("SELECT count(*) AS count FROM threads WHERE id = ?")
    .bind(threadId)
    .first<{ count: number }>();
  const startupPhases = await fixtureDb(context.env)
    .prepare(
      "SELECT journey, phase, submission_id FROM startup_phase_event WHERE thread_id = ? ORDER BY ordinal",
    )
    .bind(threadId)
    .all<{ journey: string; phase: string; submission_id: string }>();
  const schema = await fixtureDb(context.env)
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all<{ name: string }>();
  return context.json({
    initialThreadRow: initialThreadRows.get(threadId),
    currentThreadRow,
    activities: activities.results,
    submissionStates: submissions.results.map(({ state }) => state),
    matchingThreadCount: matchingThreadCount?.count ?? 0,
    startupPhases: startupPhases.results,
    tables: schema.results.map(({ name }) => name),
  });
});
app.post("/__fixture/reject-next-initial-admission", (context) => {
  rejectNextInitialDispatch = true;
  return context.body(null, 204);
});
app.post("/__fixture/seed-cross-owner", async (context) => {
  const projectId = "prj_00000000-0000-4000-8000-000000000098";
  const threadId = "thr_00000000-0000-4000-8000-000000000098";
  const ownerUserId = "00000000-0000-4000-8000-000000000002";
  const timestamp = "2026-08-20T00:00:00.000Z";
  await fixtureDb(context.env)
    .prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(projectId, ownerUserId, "Other", timestamp, timestamp)
    .run();
  await fixtureDb(context.env)
    .prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(threadId, projectId, ownerUserId, timestamp, timestamp)
    .run();
  return context.json({ threadId });
});
app.use("/v1/*", authenticate);
app.route("/v1/projects", projectRoutes);
app.route("/v1/settings", settingsRoutes);
app.route("/v1/threads", threadRoutes);
app.use("/v1/agents/dx/:threadId", authorizeThread);
app.use("/v1/agents/dx/:threadId/:subpath{.+}", authorizeThread);
app.route("/v1/agents/dx", createAgentRouter(FixtureLifecycleAgent));
app.notFound(notFoundHandler);
app.onError(errorHandler);

export default app;
