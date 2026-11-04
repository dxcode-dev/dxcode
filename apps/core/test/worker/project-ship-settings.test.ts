import { env } from "cloudflare:test";
import { builtInShipPrompt, Principal, type UserId } from "@dx/domain";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { projectRoutes } from "../../src/projects/routes.js";
import { resolveExecutionSigningPlan } from "../../src/settings/keys/execution.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";
import { threadChangesRoutes } from "../../src/thread-changes/routes.js";

/**
 * Project Settings → General: a project's own Ship Behavior (#1196), Commit
 * Author, and dx co-author switch (#1197). Each starts from the defaults it
 * was created with, changes for this project alone, and reaches the Threads
 * the project already has: the next commit's identity and the next Ship.
 */

const owner = "ship-settings-owner" as UserId;
const stranger = "ship-settings-stranger" as UserId;

const bindings: Bindings = {
  DB: env.DB,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
};

const createApp = (userId: UserId) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId,
        credentialScopes: ["personal", "workspace"],
      }),
    );
    await next();
  });
  app.route("/projects", projectRoutes);
  app.use("/threads/:threadId/changes/*", authorizeThread);
  app.route("/threads", threadChangesRoutes);
  app.onError(errorHandler);
  return app;
};

type ProjectBody = {
  readonly id: string;
  readonly revision: number;
  readonly configuration: Record<string, unknown>;
};

let threadCount = 0;

/** A new project with one Thread, which started from `baseBranch`. */
const createProject = async (name: string, baseBranch?: string) => {
  const app = createApp(owner);
  const response = await app.request(
    "/projects",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    },
    bindings,
  );
  expect(response.status).toBe(201);
  const project = (await response.json<{ data: ProjectBody }>()).data;
  threadCount += 1;
  const threadId = `thr_00000000-0000-4000-8000-${String(1196_0000_0000 + threadCount)}`;
  const now = "2026-10-31T00:00:00.000Z";
  await env.DB.prepare(
    `INSERT INTO threads (
      id, project_id, owner_user_id, runner_profile_id, created_at, updated_at
    ) VALUES (?, ?, ?, 'a1.medium', ?, ?)`,
  )
    .bind(threadId, project.id, owner, now, now)
    .run();
  if (baseBranch !== undefined)
    await env.DB.prepare(
      `INSERT INTO thread_source_snapshot (
        thread_id, project_id, binding_revision, provider,
        repository_full_name, clone_url, default_branch, initial_ref,
        initial_commit_sha, created_at
      ) VALUES (?, ?, 1, 'git', 'example/ship', 'https://git.example.com/example/ship.git',
        ?, ?, ?, ?)`,
    )
      .bind(
        threadId,
        project.id,
        baseBranch,
        `refs/heads/${baseBranch}`,
        "a".repeat(40),
        now,
      )
      .run();
  return { project, threadId };
};

const patch = async (projectId: string, body: Record<string, unknown>) =>
  createApp(owner).request(
    `/projects/${projectId}`,
    {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    bindings,
  );

const saved = async (projectId: string, body: Record<string, unknown>) => {
  const response = await patch(projectId, body);
  expect(response.status).toBe(200);
  return (await response.json<{ data: ProjectBody }>()).data;
};

const commitIdentity = async (threadId: string) => {
  const plan = await Effect.runPromise(
    resolveExecutionSigningPlan(bindings, threadId),
  );
  return { author: plan.author, dxCoAuthor: plan.dxCoAuthor };
};

const shipPlan = (threadId: string, userId: UserId = owner) =>
  createApp(userId).request(`/threads/${threadId}/changes/ship`, {}, bindings);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(owner, "Ship Owner", "ship-owner@example.com", 1, 1),
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(stranger, "Stranger", "stranger@example.com", 1, 1),
  ]);
});

describe("a project's own Commit Author and dx co-author (#1197)", () => {
  it("changes who authors its existing Threads' commits and whether dx is credited", async () => {
    const { project, threadId } = await createProject("author-settings");
    // The deployment default: dx authors, so dx is never also co-author.
    expect(project.configuration).toMatchObject({
      commitAuthor: { preference: "dx" },
      dxCoAuthor: true,
    });
    await expect(commitIdentity(threadId)).resolves.toEqual({
      author: { name: "dxcodeagent", email: "agent@dxcode.dev" },
      dxCoAuthor: false,
    });

    const you = await saved(project.id, {
      revision: project.revision,
      commitAuthor: "user",
    });
    expect(you.configuration).toMatchObject({
      commitAuthor: {
        preference: "user",
        name: "Ship Owner",
        email: "ship-owner@example.com",
      },
      dxCoAuthor: true,
    });
    await expect(commitIdentity(threadId)).resolves.toEqual({
      author: { name: "Ship Owner", email: "ship-owner@example.com" },
      dxCoAuthor: true,
    });

    const uncredited = await saved(project.id, {
      revision: you.revision,
      dxCoAuthor: false,
    });
    expect(uncredited.configuration).toMatchObject({
      commitAuthor: { preference: "user" },
      dxCoAuthor: false,
    });
    await expect(commitIdentity(threadId)).resolves.toEqual({
      author: { name: "Ship Owner", email: "ship-owner@example.com" },
      dxCoAuthor: false,
    });

    const credited = await saved(project.id, {
      revision: uncredited.revision,
      dxCoAuthor: true,
    });
    await expect(commitIdentity(threadId)).resolves.toMatchObject({
      dxCoAuthor: true,
    });

    const dxAgain = await saved(project.id, {
      revision: credited.revision,
      commitAuthor: "dx",
    });
    expect(dxAgain.configuration).toMatchObject({
      commitAuthor: {
        preference: "dx",
        name: "dxcodeagent",
        email: "agent@dxcode.dev",
      },
    });
    await expect(commitIdentity(threadId)).resolves.toEqual({
      author: { name: "dxcodeagent", email: "agent@dxcode.dev" },
      dxCoAuthor: false,
    });
  });

  it("leaves other projects as they were", async () => {
    const changed = await createProject("author-changed");
    const untouched = await createProject("author-untouched");
    await saved(changed.project.id, {
      revision: changed.project.revision,
      commitAuthor: "user",
      dxCoAuthor: false,
    });
    await expect(commitIdentity(untouched.threadId)).resolves.toEqual({
      author: { name: "dxcodeagent", email: "agent@dxcode.dev" },
      dxCoAuthor: false,
    });
  });
});

describe("a project's own Ship Behavior (#1196)", () => {
  it("defaults to Ship and sends the built-in prompt for the Thread's base branch", async () => {
    const { project, threadId } = await createProject("ship-default", "trunk");
    expect(project.configuration).toMatchObject({ shipAction: "ship" });
    expect(project.configuration.shipPrompt).toBeUndefined();
    const response = await shipPlan(threadId);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "success",
      data: {
        action: "ship",
        baseBranch: "trunk",
        prompt: builtInShipPrompt("ship", "trunk"),
      },
    });
    expect(builtInShipPrompt("ship", "trunk")).toContain("Push to `trunk`.");
  });

  it("switches existing Threads to Push to Branch and Custom Ship, and keeps the custom prompt", async () => {
    const { project, threadId } = await createProject("ship-switch", "main");
    const push = await saved(project.id, {
      revision: project.revision,
      shipAction: "push",
    });
    expect(push.configuration).toMatchObject({ shipAction: "push" });
    await expect((await shipPlan(threadId)).json()).resolves.toMatchObject({
      data: {
        action: "push",
        baseBranch: "main",
        prompt: builtInShipPrompt("push", "main"),
      },
    });

    const prompt =
      "Commit everything, push a branch, and open a PR with `gh pr create --fill`. Do not merge.";
    const custom = await saved(project.id, {
      revision: push.revision,
      shipAction: "custom",
      shipPrompt: prompt,
    });
    expect(custom.configuration).toMatchObject({
      shipAction: "custom",
      shipPrompt: prompt,
    });
    // Sent exactly as saved: no template variables.
    await expect((await shipPlan(threadId)).json()).resolves.toMatchObject({
      data: { action: "custom", prompt },
    });

    // Back to Ship keeps the prompt for the next Custom Ship.
    const back = await saved(project.id, {
      revision: custom.revision,
      shipAction: "ship",
    });
    expect(back.configuration).toMatchObject({
      shipAction: "ship",
      shipPrompt: prompt,
    });
    await expect((await shipPlan(threadId)).json()).resolves.toMatchObject({
      data: { action: "ship", prompt: builtInShipPrompt("ship", "main") },
    });
    const again = await saved(project.id, {
      revision: back.revision,
      shipAction: "custom",
    });
    expect(again.configuration).toMatchObject({
      shipAction: "custom",
      shipPrompt: prompt,
    });
  });

  it("refuses Custom Ship without a prompt, a blank prompt, or one over 10,000 characters", async () => {
    const { project } = await createProject("ship-invalid");
    for (const body of [
      { shipAction: "custom" },
      { shipAction: "custom", shipPrompt: "" },
      { shipAction: "custom", shipPrompt: "  \n\t " },
      { shipAction: "custom", shipPrompt: "x".repeat(10_001) },
      { shipAction: "commit" },
    ]) {
      const response = await patch(project.id, {
        revision: project.revision,
        ...body,
      });
      expect(response.status, JSON.stringify(body).slice(0, 80)).toBe(400);
    }
    const longest = await saved(project.id, {
      revision: project.revision,
      shipAction: "custom",
      shipPrompt: "x".repeat(10_000),
    });
    expect(longest.configuration).toMatchObject({ shipAction: "custom" });
  });

  it("names no base branch for a Thread without a repository, and hides the plan from others", async () => {
    const { threadId } = await createProject("ship-no-repository");
    await expect((await shipPlan(threadId)).json()).resolves.toEqual({
      status: "success",
      data: { action: "ship", prompt: builtInShipPrompt("ship") },
    });
    expect((await shipPlan(threadId, stranger)).status).toBe(404);
  });
});
