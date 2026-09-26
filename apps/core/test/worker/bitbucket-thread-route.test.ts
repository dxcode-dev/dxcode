import { env } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import * as admission from "../../src/source-control/admission.js";
import {
  createProjectViaApi,
  createThreadViaApi,
  owner,
} from "./product-route-fixture.js";

it("persists the authorized Bitbucket provider through the thread creation route", async () => {
  const project = await createProjectViaApi("bitbucket-thread-route");
  const grantId = "bitbucket-route-grant";
  const workspaceId = "{11111111-1111-4111-8111-111111111111}";
  const repositoryId = "{22222222-2222-4222-8222-222222222222}";
  await env.DB.prepare(`
    INSERT INTO bitbucket_connection (
      id, user_id, provider_account_id, account_name, status,
      authorization_epoch, created_at, updated_at
    ) VALUES (?, ?, ?, 'reviewer', 'active', 1, ?, ?)
  `)
    .bind(
      grantId,
      owner,
      workspaceId,
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO bitbucket_repository (
        connection_id, repository_id, workspace_id, full_name, web_url,
        clone_url, default_branch, visibility
      ) VALUES (?, ?, ?, 'team/shield', 'https://bitbucket.org/team/shield',
        'https://bitbucket.org/team/shield.git', 'main', 'private')
    `).bind(grantId, repositoryId, workspaceId),
    env.DB.prepare(`
      INSERT INTO project_repository (
        project_id, provider, binding_revision, full_name, web_url, clone_url, created_at, updated_at
      ) VALUES (?, 'bitbucket', 1, 'team/shield', 'https://bitbucket.org/team/shield',
        'https://bitbucket.org/team/shield.git', ?, ?)
    `).bind(project.data.id, now, now),
    env.DB.prepare(`
      INSERT INTO project_source_authority (
        project_id, provider, owner_scope, owner_id, owner_grant_id,
        provider_workspace_id, provider_repository_id, binding_revision, provenance,
        default_branch, source_health, authorization_epoch, installation_epoch,
        policy_revision, created_at, updated_at
      ) VALUES (?, 'bitbucket', 'personal', ?, ?, ?, ?, 1, 'live-grant',
        'main', 'available', 1, 0, 0, ?, ?)
    `).bind(
      project.data.id,
      owner,
      grantId,
      workspaceId,
      repositoryId,
      now,
      now,
    ),
  ]);
  const authorize = vi
    .spyOn(admission, "authorizeProjectSource")
    .mockResolvedValue({
      kind: "authorized",
      provider: "bitbucket",
      owner: { scope: "personal", id: owner },
      grantId,
      providerWorkspaceId: workspaceId,
      providerRepositoryId: repositoryId,
      fullName: "team/shield",
      webUrl: "https://bitbucket.org/team/shield",
      cloneUrl: "https://bitbucket.org/team/shield.git",
      defaultBranch: "main",
      commitSha: "a".repeat(40),
      visibility: "private",
      authorizationEpoch: 1,
      installationEpoch: 0,
      policyRevision: 0,
      bindingRevision: 1,
    });
  try {
    const thread = await createThreadViaApi(project.data.id);
    expect(thread.data.projectId).toBe(project.data.id);
    await expect(
      env.DB.prepare(`
      SELECT snapshot.provider, snapshot.clone_url, authority.provider_workspace_id,
             authority.provider_repository_id, authority.installation_id
      FROM thread_source_snapshot AS snapshot
      JOIN thread_source_authority AS authority ON authority.thread_id = snapshot.thread_id
      WHERE snapshot.thread_id = ?
    `)
        .bind(thread.data.id)
        .first(),
    ).resolves.toEqual({
      provider: "bitbucket",
      clone_url: "https://bitbucket.org/team/shield.git",
      provider_workspace_id: workspaceId,
      provider_repository_id: repositoryId,
      installation_id: null,
    });
  } finally {
    authorize.mockRestore();
    await env.DB.prepare(
      "DELETE FROM bitbucket_repository WHERE connection_id = ?",
    )
      .bind(grantId)
      .run();
    await env.DB.prepare("DELETE FROM bitbucket_connection WHERE id = ?")
      .bind(grantId)
      .run();
  }
});
