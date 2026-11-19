import { env } from "cloudflare:test";
import { generateKeyPairSync } from "node:crypto";
import type { ListProjectsResponse } from "@dx/api";
import { Principal, UserId } from "@dx/domain";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/http/types.js";
import { loadConfigEncryptionKeyring } from "../../src/settings/environment-variables/encryption.js";
import {
  IntegrationCredentialVault,
  IntegrationCredentialVaultD1,
} from "../../src/settings/integrations/credential-vault.js";
import { listGitHubGrants } from "../../src/source-control/github/control-plane.js";
import {
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_GITHUB_APP_CONFIGURATION,
} from "../../src/testing/bindings.js";
import {
  createProductApp,
  createProjectViaApi,
  jsonHeaders,
  owner,
  bindings as productBindings,
} from "./product-route-fixture.js";

/**
 * A workspace member who collaborates on a teammate's GitHub repository
 * starts Threads in the teammate's Project, through the real routes, D1, and
 * source admission against a fake GitHub (production, 18 November 2026:
 * every POST /v1/threads from such a member answered 409
 * SOURCE_AUTHORIZATION_DENIED, and the picker showed "No GitHub access").
 *
 * Ways it could fail: the member is still refused; the member reaches the
 * creator's other repositories they do not collaborate on; a member who is
 * no longer a collaborator keeps access; the collaborator's grant shows the
 * creator's whole installation in their repository list.
 */
const bindings: Bindings = {
  ...productBindings,
  DX_ENV: "local",
  DX_AUTH_URL: "https://dx.test",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_INTEGRATION_GITHUB_APP: JSON.stringify({
    ...JSON.parse(TEST_GITHUB_APP_CONFIGURATION),
    privateKeyPem: generateKeyPairSync("rsa", { modulusLength: 2048 })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString(),
  }),
};

const api = "https://api.github.com";
const member = Schema.decodeUnknownSync(UserId)("collaborator-member");
const memberPrincipal = Schema.decodeUnknownSync(Principal)({
  userId: member,
  credentialScopes: ["personal", "workspace"],
});
const workspaceId = "collaborator-workspace";
/** The creator's installation on their own GitHub account. */
const creatorInstallation = "9401";
/** The member's installation on their own GitHub account. */
const memberInstallation = "9402";
const shared = { id: "7401", fullName: "creator/infinity" };
const notShared = { id: "7402", fullName: "creator/secret" };
const memberOwn = { id: "7403", fullName: "member/own" };

afterEach(() => vi.unstubAllGlobals());

const githubRepository = (repository: { id: string; fullName: string }) => ({
  id: Number(repository.id),
  full_name: repository.fullName,
  html_url: `https://github.com/${repository.fullName}`,
  clone_url: `https://github.com/${repository.fullName}.git`,
  visibility: "private",
  archived: false,
  default_branch: "main",
});

const githubInstallation = (id: string, login: string) => ({
  id: Number(id),
  account: { id: Number(id) + 1000, login, type: "User" },
  repository_selection: "selected",
  permissions: { contents: "write", metadata: "read" },
});

/**
 * GitHub as the member's user token sees it: both installations, and in the
 * creator's one only the repositories in `collaboratorOn`.
 */
const fakeGitHub = (collaboratorOn: { current: string[] }) => {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push(`${method} ${url}`);
      const auth = new Headers(init?.headers).get("authorization");
      if (url === `${api}/user/installations?per_page=100`) {
        expect(auth).toBe("Bearer ghu_member");
        return Response.json({
          total_count: 2,
          installations: [
            githubInstallation(creatorInstallation, "creator"),
            githubInstallation(memberInstallation, "member"),
          ],
        });
      }
      const listed = url.match(
        /^https:\/\/api\.github\.com\/user\/installations\/(\d+)\/repositories\?per_page=100$/,
      );
      if (listed !== null) {
        expect(auth).toBe("Bearer ghu_member");
        const repositories =
          listed[1] === creatorInstallation
            ? [shared, notShared].filter((repository) =>
                collaboratorOn.current.includes(repository.id),
              )
            : [memberOwn];
        return Response.json({
          total_count: repositories.length,
          repositories: repositories.map(githubRepository),
        });
      }
      if (url === `${api}/app/installations/${creatorInstallation}`)
        return Response.json(
          githubInstallation(creatorInstallation, "creator"),
        );
      if (
        url === `${api}/app/installations/${creatorInstallation}/access_tokens`
      )
        return Response.json({
          token: "lease-token",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        });
      if (url === `${api}/installation/token` && method === "DELETE")
        return new Response(null, { status: 204 });
      for (const repository of [shared, notShared]) {
        if (url === `${api}/repositories/${repository.id}`)
          return Response.json(githubRepository(repository));
        if (url === `${api}/repositories/${repository.id}/commits/main`)
          return Response.json({ sha: "a".repeat(40) });
      }
      return Response.json({ message: "unexpected" }, { status: 500 });
    }),
  );
  return requests;
};

const seed = async () => {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
    ).bind(member, "Collaborator Member", "collaborator@example.test"),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Infinity Team', 'infinity-team', 1)",
    ).bind(workspaceId),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('cm-owner', ?1, ?2, 'owner', 1), ('cm-member', ?1, ?3, 'member', 2)`,
    ).bind(workspaceId, owner, member),
    ...[
      [creatorInstallation, "creator"],
      [memberInstallation, "member"],
    ].map(([id, login]) =>
      env.DB.prepare(`
        INSERT INTO github_installation (
          installation_id, app_id, provider_account_id, provider_account_type,
          provider_account_login, repository_selection, status,
          permissions_version, created_at, updated_at
        ) VALUES (?, '12345', ?, 'user', ?, 'selected', 'active', 1, ?, ?)
      `).bind(id, String(Number(id) + 1000), login, now, now),
    ),
    env.DB.prepare(`
      INSERT INTO github_owner_grant (
        id, owner_scope, owner_id, installation_id, status,
        created_by_user_id, created_at, updated_at
      ) VALUES ('grant-creator', 'personal', ?1, ?3, 'active', ?1, ?5, ?5),
               ('grant-member-own', 'personal', ?2, ?4, 'active', ?2, ?5, ?5)
    `).bind(owner, member, creatorInstallation, memberInstallation, now),
    ...[
      [creatorInstallation, shared],
      [creatorInstallation, notShared],
      [memberInstallation, memberOwn],
    ].map(([installation, repository]) => {
      const { id, fullName } = repository as typeof shared;
      return env.DB.prepare(`
        INSERT INTO github_installation_repository (
          installation_id, provider_repository_id, full_name, web_url,
          visibility, entitled, last_reconciled_at
        ) VALUES (?, ?, ?, ?, 'private', 1, ?)
      `).bind(
        installation,
        id,
        fullName,
        `https://github.com/${fullName}`,
        now,
      );
    }),
  ]);
  // The member signed in to GitHub: an unexpired user token `ghu_member`.
  const put = (purpose: "access-token" | "refresh-token", value: string) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const keyring = yield* loadConfigEncryptionKeyring(bindings);
        const vault = yield* IntegrationCredentialVault;
        return yield* vault.put(
          keyring,
          { scope: "personal", id: member },
          purpose,
          value,
        );
      }).pipe(Effect.provide(IntegrationCredentialVaultD1(env.DB))),
    );
  const [access, refresh] = await Promise.all([
    put("access-token", "ghu_member"),
    put("refresh-token", "ghr_member"),
  ]);
  await env.DB.prepare(`
    INSERT INTO github_user_authorization (
      id, user_id, provider_account_id, provider_account_login, status,
      access_token_reference_id, refresh_token_reference_id, expires_at,
      refresh_expires_at, created_at, updated_at
    ) VALUES ('auth-member', ?, '52', 'member', 'active', ?, ?, ?, NULL, ?, ?)
  `)
    .bind(
      member,
      access.id,
      refresh.id,
      new Date(Date.now() + 4 * 60 * 60 * 1_000).toISOString(),
      now,
      now,
    )
    .run();
};

/** A workspace Project the creator bound to `repository` through their grant. */
const workspaceProject = async (
  name: string,
  repository: { id: string; fullName: string },
) => {
  const projectId = (await createProjectViaApi(name)).data.id;
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE projects SET workspace_id = ? WHERE id = ?").bind(
      workspaceId,
      projectId,
    ),
    env.DB.prepare(`
      INSERT INTO project_repository (
        project_id, provider, binding_revision, full_name, web_url, clone_url,
        created_at, updated_at
      ) VALUES (?, 'github', 1, ?, ?, ?, ?, ?)
    `).bind(
      projectId,
      repository.fullName,
      `https://github.com/${repository.fullName}`,
      `https://github.com/${repository.fullName}.git`,
      now,
      now,
    ),
    env.DB.prepare(`
      INSERT INTO project_source_authority (
        project_id, provider, owner_scope, owner_id, owner_grant_id,
        installation_id, provider_repository_id, binding_revision, provenance,
        default_branch, source_health, authorization_epoch,
        installation_epoch, policy_revision, created_at, updated_at
      ) VALUES (?, 'github', 'personal', ?, 'grant-creator', ?, ?, 1,
        'live-grant', 'main', 'available', 1, 1, 0, ?, ?)
    `).bind(projectId, owner, creatorInstallation, repository.id, now, now),
  ]);
  return projectId;
};

const startThread = async (projectId: string) => {
  const response = await createProductApp(memberPrincipal).request(
    "/threads",
    {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ projectId, title: "Collaborator thread" }),
    },
    bindings,
    {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
      props: {},
    },
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      data: { id?: string; code?: string; reason?: string };
    },
  };
};

const memberProjects = async () => {
  const response = await createProductApp(memberPrincipal).request(
    "/projects",
    {},
    bindings,
  );
  expect(response.status).toBe(200);
  const body = await response.json<ListProjectsResponse>();
  return new Map(
    body.data.items.map((project) => [project.id, project.viewerAccess]),
  );
};

describe("a workspace member who collaborates on the creator's repository", () => {
  it("starts Threads in its Project and reaches only the repositories GitHub lists for them", async () => {
    await seed();
    const collaboratorOn = { current: [shared.id] };
    const requests = fakeGitHub(collaboratorOn);
    const infinity = await workspaceProject("Infinity", shared);
    const secret = await workspaceProject("Secret", notShared);

    // The picker offers the shared Project and not the other one.
    const access = await memberProjects();
    expect(access.get(infinity)?.threads).toEqual({ status: "available" });
    expect(access.get(secret)?.threads).toEqual({
      status: "no-repository-access",
      provider: "github",
    });

    // The member starts a Thread, cloning through a grant of their own.
    const started = await startThread(infinity);
    expect(started.status).toBe(201);
    const threadId = started.body.data.id;
    expect(
      await env.DB.prepare(
        "SELECT owner_grant_id, installation_id, provider_repository_id FROM thread_source_authority WHERE thread_id = ?",
      )
        .bind(threadId)
        .first(),
    ).toEqual({
      owner_grant_id: `ghg_personal_${member}_${creatorInstallation}`,
      installation_id: creatorInstallation,
      provider_repository_id: shared.id,
    });
    // The lease is the creator's installation, limited to the one repository.
    expect(requests).toContain(
      `POST ${api}/app/installations/${creatorInstallation}/access_tokens`,
    );

    // The creator's repository the member does not collaborate on stays out
    // of reach: no Thread, and not in the member's repository list.
    const refused = await startThread(secret);
    expect(refused.status).toBe(409);
    expect(refused.body.data.code).toBe("SOURCE_AUTHORIZATION_DENIED");
    const grants = await listGitHubGrants(env.DB, {
      scope: "personal",
      id: member,
    });
    expect(
      grants.map((grant) => ({
        installationId: grant.installationId,
        repositories: grant.repositories.map((repository) => repository.id),
      })),
    ).toEqual([
      { installationId: creatorInstallation, repositories: [shared.id] },
      { installationId: memberInstallation, repositories: [memberOwn.id] },
    ]);

    // Removed as a collaborator, the member is refused again once dx checks
    // GitHub (at most a minute after the last check; the test skips the wait).
    collaboratorOn.current = [];
    await env.DB.prepare(
      "UPDATE github_user_authorization SET collaborator_grants_synced_at = NULL WHERE user_id = ?",
    )
      .bind(member)
      .run();
    const removed = await startThread(infinity);
    expect(removed.status).toBe(409);
    expect(removed.body.data.code).toBe("SOURCE_AUTHORIZATION_DENIED");
    expect(
      await env.DB.prepare("SELECT status FROM github_owner_grant WHERE id = ?")
        .bind(`ghg_personal_${member}_${creatorInstallation}`)
        .first(),
    ).toEqual({ status: "disconnected" });
    // The creator's own grant and installation are untouched.
    expect(
      await env.DB.prepare(
        "SELECT grant_row.status, installation.status AS installation_status FROM github_owner_grant AS grant_row JOIN github_installation AS installation USING (installation_id) WHERE grant_row.id = 'grant-creator'",
      ).first(),
    ).toEqual({ status: "active", installation_status: "active" });
    expect(
      requests.filter((request) => request.startsWith("DELETE ")),
    ).not.toContain(`DELETE ${api}/app/installations/${creatorInstallation}`);
  });
});
