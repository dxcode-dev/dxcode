import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  bindings,
  createProductApp,
  createThreadViaApi,
  jsonHeaders,
  otherPrincipal,
} from "./product-route-fixture.js";

type ProjectBody = {
  readonly data: {
    readonly id: string;
    readonly revision: number;
    readonly repository?: Record<string, unknown>;
    readonly remoteAliases?: ReadonlyArray<string>;
  };
};

const createUrlProject = async (name: string, url: string) => {
  const response = await createProductApp().request(
    "/projects",
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name, source: { kind: "public-git-url", url } }),
    },
    bindings,
  );
  expect(response.status).toBe(201);
  return response.json<ProjectBody>();
};

const putSource = (projectId: string, body: object, app = createProductApp()) =>
  app.request(
    `/projects/${projectId}/source`,
    { method: "PUT", headers: jsonHeaders, body: JSON.stringify(body) },
    bindings,
  );

const patch = (projectId: string, body: object) =>
  createProductApp().request(
    `/projects/${projectId}`,
    { method: "PATCH", headers: jsonHeaders, body: JSON.stringify(body) },
    bindings,
  );

const threadCloneUrl = (threadId: string) =>
  env.DB.prepare(
    "SELECT binding_revision, clone_url FROM thread_source_intent WHERE thread_id = ?",
  )
    .bind(threadId)
    .first();

describe("a URL-bound Project's Git Repository", () => {
  it("points new Threads at an edited URL and leaves existing Threads on the old one", async () => {
    const project = await createUrlProject(
      "edit-repository-url",
      "https://github.com/octocat/Hello-World",
    );
    const before = await createThreadViaApi(project.data.id);

    const response = await putSource(project.data.id, {
      revision: project.data.revision,
      url: "https://GitHub.com/octocat/Spoon-Knife.git",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        revision: project.data.revision + 1,
        repository: {
          provider: "git",
          bindingRevision: 2,
          fullName: "octocat/Spoon-Knife",
          webUrl: "https://github.com/octocat/Spoon-Knife",
          cloneUrl: "https://github.com/octocat/Spoon-Knife.git",
        },
      },
    });
    await expect(threadCloneUrl(before.data.id)).resolves.toEqual({
      binding_revision: 1,
      clone_url: "https://github.com/octocat/Hello-World.git",
    });
    const after = await createThreadViaApi(project.data.id);
    await expect(threadCloneUrl(after.data.id)).resolves.toEqual({
      binding_revision: 2,
      clone_url: "https://github.com/octocat/Spoon-Knife.git",
    });
  });

  it("refuses a URL that is not a credential-free HTTPS Git URL, a stale revision, and another person", async () => {
    const project = await createUrlProject(
      "refuse-repository-url",
      "https://github.com/octocat/Hello-World",
    );
    for (const url of [
      "https://token@github.com/octocat/Spoon-Knife",
      "http://github.com/octocat/Spoon-Knife",
      "git@github.com:octocat/Spoon-Knife.git",
      "https://github.com/octocat",
      "",
    ]) {
      const refused = await putSource(project.data.id, {
        revision: project.data.revision,
        url,
      });
      expect(refused.status, url).toBe(400);
    }
    const stale = await putSource(project.data.id, {
      revision: project.data.revision + 5,
      url: "https://github.com/octocat/Spoon-Knife",
    });
    expect(stale.status).toBe(404);
    const stranger = await putSource(
      project.data.id,
      {
        revision: project.data.revision,
        url: "https://github.com/octocat/Spoon-Knife",
      },
      createProductApp(otherPrincipal),
    );
    expect(stranger.status).toBe(404);

    const read = await createProductApp().request(
      `/projects/${project.data.id}`,
      {},
      bindings,
    );
    await expect(read.json()).resolves.toMatchObject({
      data: {
        revision: project.data.revision,
        repository: {
          bindingRevision: 1,
          webUrl: "https://github.com/octocat/Hello-World",
        },
      },
    });
  });

  it("keeps canonical Git remote aliases, HTTPS or SSH, and replaces them on update", async () => {
    const project = await createUrlProject(
      "remote-aliases",
      "https://github.com/octocat/Hello-World",
    );
    expect(project.data.remoteAliases).toEqual([]);

    const updated = await patch(project.data.id, {
      revision: project.data.revision,
      remoteAliases: [
        " git@github.com:octocat/Hello-World.git ",
        "https://mirror.example.test/octocat/hello-world.git",
        "https://MIRROR.example.test/octocat/hello-world",
        "ssh://git@GitHub.com:22/octocat/Hello-World",
        "https://github.com/octocat/Hello-World.git",
      ],
    });
    expect(updated.status).toBe(200);
    const aliases = [
      "git@github.com:octocat/Hello-World.git",
      "https://mirror.example.test/octocat/hello-world",
      "ssh://git@github.com:22/octocat/Hello-World.git",
    ];
    await expect(updated.json()).resolves.toMatchObject({
      data: { revision: project.data.revision + 1, remoteAliases: aliases },
    });
    const read = await createProductApp().request(
      `/projects/${project.data.id}`,
      {},
      bindings,
    );
    await expect(read.json()).resolves.toMatchObject({
      data: { remoteAliases: aliases },
    });

    for (const remoteAliases of [
      ["https://user:secret@github.com/octocat/Hello-World"],
      ["http://github.com/octocat/Hello-World"],
      ["not a url"],
      Array.from(
        { length: 11 },
        (_, index) => `https://mirror.example.test/team/repo-${index}`,
      ),
    ]) {
      const refused = await patch(project.data.id, {
        revision: project.data.revision + 1,
        remoteAliases,
      });
      expect(refused.status, String(remoteAliases[0])).toBe(400);
    }

    const cleared = await patch(project.data.id, {
      revision: project.data.revision + 1,
      remoteAliases: [],
    });
    await expect(cleared.json()).resolves.toMatchObject({
      data: { remoteAliases: [] },
    });
  });

  it("reads every project_read_model column back, so a redefined view cannot drop one", async () => {
    // Any migration that recreates the view must keep each of these. When a
    // migration adds a column to it, add the column here.
    const project = await createUrlProject(
      "read-model-columns",
      "https://github.com/octocat/Hello-World",
    );
    const updated = await patch(project.data.id, {
      revision: project.data.revision,
      description: "Every column",
      additionalRepositories: ["https://github.com/octocat/Spoon-Knife"],
      remoteAliases: ["git@github.com:octocat/Hello-World.git"],
    });
    expect(updated.status).toBe(200);

    const row = await env.DB.prepare(
      "SELECT * FROM project_read_model WHERE id = ?",
    )
      .bind(project.data.id)
      .first<Record<string, unknown>>();
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        "additional_repositories_json",
        "commit_author_email",
        "commit_author_name",
        "commit_author_preference",
        "created_at",
        "deleted_at",
        "description",
        "dx_co_author",
        "icon_key",
        "id",
        "name",
        "owner_user_id",
        "public_code_enabled",
        "remote_aliases_json",
        "repository_binding_revision",
        "repository_clone_url",
        "repository_full_name",
        "repository_provider",
        "repository_web_url",
        "revision",
        "runner_profile_id",
        "ship_behavior",
        "ship_prompt",
        "signing_preference",
        "updated_at",
        "workspace_id",
      ].sort(),
    );
    expect(row).toMatchObject({
      id: project.data.id,
      name: "read-model-columns",
      description: "Every column",
      revision: project.data.revision + 1,
      repository_provider: "git",
      repository_binding_revision: 1,
      repository_full_name: "octocat/Hello-World",
      repository_web_url: "https://github.com/octocat/Hello-World",
      repository_clone_url: "https://github.com/octocat/Hello-World.git",
      deleted_at: null,
    });
    expect(JSON.parse(String(row?.additional_repositories_json))).toEqual([
      {
        provider: "github",
        fullName: "octocat/Spoon-Knife",
        webUrl: "https://github.com/octocat/Spoon-Knife",
        cloneUrl: "https://github.com/octocat/Spoon-Knife.git",
      },
    ]);
    expect(JSON.parse(String(row?.remote_aliases_json))).toEqual([
      "git@github.com:octocat/Hello-World.git",
    ]);
    for (const column of [
      "owner_user_id",
      "ship_behavior",
      "commit_author_preference",
      "commit_author_name",
      "commit_author_email",
      "signing_preference",
      "runner_profile_id",
      "public_code_enabled",
      "dx_co_author",
      "created_at",
      "updated_at",
    ])
      expect(row?.[column], column).not.toBeNull();
  });
});
