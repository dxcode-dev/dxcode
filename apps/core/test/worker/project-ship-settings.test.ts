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
  LOADER: (env as unknown as { LOADER: WorkerLoader }).LOADER,
};

const sha256 = async (value: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");

/** A personal install of a plugin whose code handles changes.prompt. */
const installPromptPlugin = async (name: string, source: string) => {
  const entry = "dev.dxcode/index.js";
  const moduleIntegrity = await sha256(source);
  const integrity = await sha256(`${name}:${moduleIntegrity}`);
  const version = `1.0.0+${integrity.slice(0, 12)}`;
  const pluginId = `plg_${crypto.randomUUID()}`;
  const at = "2026-11-11T00:00:00.000Z";
  const manifest = {
    format: "agent-plugins",
    name,
    displayName: name,
    description: "Shapes the Ship prompt.",
    skills: [],
    mcpServers: [],
    code: {
      apiVersion: 1,
      host: "worker",
      entry,
      modules: [
        {
          path: entry,
          bytes: new TextEncoder().encode(source).byteLength,
          integrity: moduleIntegrity,
        },
      ],
      permissions: {
        events: ["changes.prompt"],
        network: [],
        secrets: [],
        tools: [],
        ai: false,
      },
      settings: [],
    },
    skipped: [],
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO trusted_plugin (id, scope, target_id, name, enabled,
         active_version, health_status, created_at, updated_at, kind)
       VALUES (?, 'personal', ?, ?, 1, ?, 'unchecked', ?, ?, 'bundle')`,
    ).bind(pluginId, owner, name, version, at, at),
    env.DB.prepare(
      `INSERT INTO trusted_plugin_version (plugin_id, version, manifest_json,
         grants_json, source_json, integrity, trusted, trusted_at,
         trusted_by_user_id)
       VALUES (?, ?, ?, '{}', ?, ?, 1, ?, ?)`,
    ).bind(
      pluginId,
      version,
      JSON.stringify(manifest),
      JSON.stringify({ type: "zip", label: `${name}.zip` }),
      integrity,
      at,
      owner,
    ),
    env.DB.prepare(
      `INSERT INTO trusted_plugin_file (plugin_id, version, path, media_type,
         content, size_bytes, integrity)
       VALUES (?, ?, ?, 'text/javascript', ?, ?, ?)`,
    ).bind(
      pluginId,
      version,
      entry,
      source,
      new TextEncoder().encode(source).byteLength,
      moduleIntegrity,
    ),
  ]);
  return pluginId;
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

  it("lets installed plugins that handle changes.prompt rewrite the prompt, in order, skipping one that fails or never answers", {
    timeout: 60_000,
  }, async () => {
    const { threadId } = await createProject("ship-plugins", "trunk");
    // Plugin names sort the order: "a-" asks for tests, "b-" fails, "c-"
    // signs off on what the first one returned.
    const plugins = [
      await installPromptPlugin(
        "a-tests-first",
        `export default (dx) => dx.on("changes.prompt", (event) => ({
  prompt: event.prompt + "\\n\\nRun the test suite before you push to " + event.baseBranch + " (" + event.action + ").",
}));`,
      ),
      await installPromptPlugin(
        "b-broken",
        `export default (dx) => dx.on("changes.prompt", () => { throw new Error("broken"); });`,
      ),
      await installPromptPlugin(
        "d-never-answers",
        `export default (dx) => dx.on("changes.prompt", () => new Promise(() => {}));`,
      ),
      await installPromptPlugin(
        "c-sign-off",
        `export default (dx) => dx.on("changes.prompt", (event) => ({
  prompt: event.prompt.includes("Run the test suite") ? event.prompt + "\\nSigned-off-by: plugins" : event.prompt,
}));`,
      ),
    ];
    try {
      const response = await shipPlan(threadId);
      expect(response.status).toBe(200);
      const { data } = await response.json<{
        data: { action: string; prompt: string; shapedBy?: string[] };
      }>();
      // The pane names who changed the prompt, so it shows it before sending.
      expect(data.shapedBy).toEqual(["a-tests-first", "c-sign-off"]);
      expect(data.prompt).toBe(
        `${builtInShipPrompt("ship", "trunk")}\n\nRun the test suite before you push to trunk (ship).\nSigned-off-by: plugins`,
      );
    } finally {
      // The other cases expect dx's own prompt.
      for (const id of plugins)
        await env.DB.prepare(
          "UPDATE trusted_plugin SET enabled = 0 WHERE id = ?",
        )
          .bind(id)
          .run();
    }
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
