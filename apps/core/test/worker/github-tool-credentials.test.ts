import { env } from "cloudflare:test";
import {
  type ProjectId,
  ProjectRepository,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import { createAutomationTools } from "../../src/automations/agent-tools.js";
import type { Bindings } from "../../src/http/types.js";
import { muteSpanLogRecords } from "../../src/observability/tracing.js";
import { loadConfigEncryptionKeyring } from "../../src/settings/environment-variables/encryption.js";
import {
  IntegrationCredentialVault,
  IntegrationCredentialVaultD1,
} from "../../src/settings/integrations/credential-vault.js";
import { readGitHubUserAccessToken } from "../../src/source-control/github/control-plane.js";
import { threadToken } from "../../src/source-control/github/thread-token-cache.js";
import { createTestBindings } from "../../src/testing/bindings.js";
import { countD1Calls, summarizeD1Calls } from "./d1-call-counter.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * The GitHub tools and native Git keep a Thread's GitHub token in memory
 * between calls (#1495), inside workerd with real D1, the real credential
 * vault, the real tools, and the real revoke route. GitHub's REST API is
 * stood in for; every request records which token it carried.
 *
 * What must hold: a reused token is the one this Thread, its owner, and
 * their current grant would resolve now. Revoking GitHub, rotating the
 * token, changing GITHUB_TOKEN, leaving the workspace, or archiving the
 * Thread stops the very next call from using the old one, even within one
 * turn; and no Thread is ever served another Thread's token.
 *
 * DX_RECORD_D1_CALLS=<name> (with -u) writes the round trips per tool call to
 * artifacts/github-tool-credentials/<name>.json.
 */

declare const __DX_RECORD_D1_CALLS__: string;

muteSpanLogRecords();

const origin = "https://dx.test";
const REPO = "acme/widgets";
const counter = countD1Calls(env.DB);
const bindings: Bindings = createTestBindings({
  DB: counter.db,
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_SIGN_IN_PROVIDERS: "email-password",
  BETTER_AUTH_SECRET: "github-tool-credentials-secret-000000",
});

// Settings writes run without the Orb bindings the test stubs.
const settingsBindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: bindings.DX_CONFIG_ENCRYPTION_KEYS,
  BETTER_AUTH_SECRET: bindings.BETTER_AUTH_SECRET,
};

/** Every request to GitHub, with the token it carried. */
let github: Array<{ method: string; path: string; token: string }> = [];

beforeEach(() => {
  github = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input as RequestInfo, init);
    const url = new URL(request.url);
    if (url.origin !== "https://api.github.com")
      throw new Error(`Unexpected request: ${request.url}`);
    github.push({
      method: request.method,
      path: url.pathname,
      token: (request.headers.get("authorization") ?? "").replace(
        /^(Bearer|Basic) /,
        "",
      ),
    });
    if (request.method === "DELETE") return new Response(null, { status: 204 });
    const item = /^\/repos\/acme\/widgets\/issues\/(\d+)$/.exec(url.pathname);
    if (item === null) return new Response("{}", { status: 404 });
    const number = Number(item[1]);
    // As GitHub's issues API answers: a pull request carries merged_at.
    return Response.json({
      number,
      title: `Item ${number}`,
      body: "",
      state: number === 7 ? "closed" : "open",
      created_at: "2026-10-01T00:00:00Z",
      closed_at: number === 7 ? "2026-10-02T00:00:00Z" : null,
      ...(number === 7
        ? { pull_request: { merged_at: "2026-10-02T00:00:00Z" } }
        : {}),
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

let runs = 0;
const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const put = (
  userId: string,
  purpose: "access-token" | "refresh-token",
  value: string,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const keyring = yield* loadConfigEncryptionKeyring(bindings);
      const vault = yield* IntegrationCredentialVault;
      return yield* vault.put(
        keyring,
        { scope: "personal", id: userId as never },
        purpose,
        value,
      );
    }).pipe(Effect.provide(IntegrationCredentialVaultD1(env.DB))),
  );

/** Connects GitHub for the user, with eight hours left on the token. */
const connect = async (userId: string, accessToken: string) => {
  const [access, refresh] = await Promise.all([
    put(userId, "access-token", accessToken),
    put(userId, "refresh-token", `${accessToken}-refresh`),
  ]);
  await env.DB.prepare(`
    INSERT INTO github_user_authorization (
      id, user_id, provider_account_id, provider_account_login, status,
      access_token_reference_id, refresh_token_reference_id, expires_at,
      refresh_expires_at, created_at, updated_at
    ) VALUES (?, ?, '42', 'octo', 'active', ?, ?, ?, NULL, ?, ?)
  `)
    .bind(
      `auth-${userId}`,
      userId,
      access.id,
      refresh.id,
      new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
    )
    .run();
};

/** A person signed up through Better Auth, so routes accept their cookie. */
const signUp = async () => {
  runs += 1;
  const email = `gh-credentials-${runs}-${Date.now()}@example.test`;
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `198.51.100.${runs}`,
      },
      body: JSON.stringify({
        name: "Credential Owner",
        email,
        password: "gh-credentials-password-123",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const id = (await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<string>("id")) as UserId;
  return { id, cookie };
};

const addProjectAndThread = async (owner: UserId, n: number) => {
  const p = project(`prj_${uuid(n)}`, owner, `Project ${n}`);
  const t = thread(`thr_${uuid(n)}`, p.id as ProjectId, owner);
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(p);
      yield* (yield* ThreadRepository).insert(t);
    }),
  );
  return { projectId: p.id as string, threadId: t.id as string };
};

const setVariable = async (cookie: string, body: Record<string, unknown>) => {
  const response = await app.request(
    "/v1/settings/personal/environment-variables",
    {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({ kind: "secret", ...body }),
    },
    settingsBindings,
  );
  expect(response.status).toBe(201);
};

/** One turn's tools: the same instance answers every call in the turn. */
const turn = (threadId: string) => {
  const tools = Object.fromEntries(
    createAutomationTools(
      threadId,
      () => ({ db: counter.db, bindings }),
      `sub_${threadId}`,
    ).map((tool) => [tool.name, tool]),
  );
  return async (name: string, data: Record<string, unknown>) =>
    (
      (await (
        tools[name] as {
          run: (input: unknown) => Promise<{ output: unknown }>;
        }
      ).run({ data, toolCallId: crypto.randomUUID(), signal: undefined })) as {
        output: Record<string, unknown>;
      }
    ).output;
};

/** The token each GitHub request since the last call carried. */
const tokensSince = (start: number) =>
  github.slice(start).map(({ token }) => token);

/** Native Git's credential for github.com, as `ThreadExecutionObject` asks. */
const gitCredential = (threadId: string) =>
  threadToken(
    counter.db,
    threadId,
    "connection",
    (ownerUserId) =>
      readGitHubUserAccessToken(bindings, counter.db, ownerUserId),
    { activeOnly: true },
  );

describe("GitHub tool credentials", () => {
  it("revoking GitHub mid-turn stops the next tool call and git credential from using the token", async () => {
    const owner = await signUp();
    await connect(owner.id, "ghu_owner");
    const { threadId } = await addProjectAndThread(owner.id, 100 + runs);
    const call = turn(threadId);

    await call("link_github_issue", { repository: REPO, number: 5 });
    await call("link_github_issue", { repository: REPO, number: 7 });
    expect(tokensSince(0)).toEqual(["ghu_owner", "ghu_owner"]);
    expect((await gitCredential(threadId))?.token).toBe("ghu_owner");
    expect((await gitCredential(threadId))?.cached).toBe(true);

    // The owner revokes dx's GitHub authorization in Settings.
    const revoked = await app.request(
      "/v1/integrations/github/personal/authorization",
      { method: "DELETE", headers: { cookie: owner.cookie, origin } },
      bindings,
    );
    expect(revoked.status).toBe(204);

    const before = github.length;
    const output = await call("link_github_issue", {
      repository: REPO,
      number: 5,
    });
    expect(output.note).toMatch(/No GitHub credentials/);
    expect(tokensSince(before)).toEqual([]);
    await expect(gitCredential(threadId)).rejects.toThrow();
    await expect(
      call("create_github_subscription", {
        title: "PR",
        repository: REPO,
        filter_kind: "pr-comments",
        pr_number: 7,
      }),
    ).rejects.toThrow(/No GitHub credentials/);
    expect(tokensSince(before)).toEqual([]);
  });

  it("never serves one Thread's token to another, whoever owns them", async () => {
    const alice = await signUp();
    const bob = await signUp();
    await connect(alice.id, "ghu_alice");
    await connect(bob.id, "ghu_bob");
    const n = 200 + runs * 3;
    const withProjectToken = await addProjectAndThread(alice.id, n);
    const plain = await addProjectAndThread(alice.id, n + 1);
    const bobs = await addProjectAndThread(bob.id, n + 2);
    // Only the first Project has its own GITHUB_TOKEN.
    await setVariable(alice.cookie, {
      scope: "project",
      projectId: withProjectToken.projectId,
      name: "GITHUB_TOKEN",
      value: "ghp_project_one",
    });

    const expected = [
      [withProjectToken.threadId, "ghp_project_one"],
      [plain.threadId, "ghu_alice"],
      [bobs.threadId, "ghu_bob"],
    ] as const;
    // Interleaved, three rounds: every call after the first is warm.
    for (let round = 0; round < 3; round += 1)
      for (const [threadId, token] of expected) {
        const start = github.length;
        await turn(threadId)("link_github_issue", {
          repository: REPO,
          number: 5,
        });
        expect(tokensSince(start)).toEqual([token]);
        const git = await gitCredential(threadId);
        expect(git?.token).toBe(
          threadId === bobs.threadId ? "ghu_bob" : "ghu_alice",
        );
      }
  });

  it("follows GITHUB_TOKEN, a rotated token, and the owner leaving the workspace at the next call", async () => {
    const owner = await signUp();
    await connect(owner.id, "ghu_first");
    const { threadId, projectId } = await addProjectAndThread(
      owner.id,
      300 + runs,
    );
    const call = turn(threadId);
    const link = async () => {
      const start = github.length;
      await call("link_github_issue", { repository: REPO, number: 5 });
      return tokensSince(start);
    };
    expect(await link()).toEqual(["ghu_first"]);

    // GITHUB_TOKEN set mid-turn wins at the next call.
    await setVariable(owner.cookie, {
      scope: "personal",
      name: "GITHUB_TOKEN",
      value: "ghp_personal",
    });
    expect(await link()).toEqual(["ghp_personal"]);

    // A refresh elsewhere rotates the connection's token.
    expect((await gitCredential(threadId))?.token).toBe("ghu_first");
    const next = await put(owner.id, "access-token", "ghu_second");
    await env.DB.prepare(
      "UPDATE github_user_authorization SET access_token_reference_id = ?, updated_at = ? WHERE user_id = ?",
    )
      .bind(next.id, new Date().toISOString(), owner.id)
      .run();
    expect(await gitCredential(threadId)).toMatchObject({
      token: "ghu_second",
      cached: false,
    });

    // A token entering its refresh window is never served from memory.
    expect((await gitCredential(threadId))?.cached).toBe(true);
    await env.DB.prepare(
      "UPDATE github_user_authorization SET expires_at = ? WHERE user_id = ?",
    )
      .bind(new Date(Date.now() + 30 * 60_000).toISOString(), owner.id)
      .run();
    vi.mocked(fetch).mockImplementationOnce(async () =>
      Response.json({
        access_token: "ghu_refreshed",
        refresh_token: "ghr_refreshed",
        expires_in: 28_800,
        token_type: "bearer",
        scope: "",
      }),
    );
    expect(await gitCredential(threadId)).toMatchObject({
      token: "ghu_refreshed",
      cached: false,
    });

    // The Project moves into a workspace the owner then leaves.
    const workspaceId = `org-gh-credentials-${runs}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Team', ?, 1)",
      ).bind(workspaceId, workspaceId),
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', 1)",
      ).bind(`${workspaceId}-owner`, workspaceId, owner.id),
      env.DB.prepare("UPDATE projects SET workspace_id = ? WHERE id = ?").bind(
        workspaceId,
        projectId,
      ),
    ]);
    expect((await gitCredential(threadId))?.cached).toBe(false);
    expect((await gitCredential(threadId))?.cached).toBe(true);
    await env.DB.prepare("DELETE FROM member WHERE organizationId = ?")
      .bind(workspaceId)
      .run();
    expect((await gitCredential(threadId))?.cached).toBe(false);
    expect((await gitCredential(threadId))?.cached).toBe(false);
  });

  it("gives an archived Thread no git credential, even right after a warm one", async () => {
    const owner = await signUp();
    await connect(owner.id, "ghu_archived");
    const { threadId } = await addProjectAndThread(owner.id, 400 + runs);
    await gitCredential(threadId);
    expect((await gitCredential(threadId))?.cached).toBe(true);
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(threadId)
      .run();
    expect((await gitCredential(threadId))?.token).toBeUndefined();
  });

  it("answers a warm link_github_issue in 2 serial D1 round trips and one GitHub request", async () => {
    const owner = await signUp();
    await connect(owner.id, "ghu_budget");
    const { threadId } = await addProjectAndThread(owner.id, 500 + runs);
    const call = turn(threadId);
    const measure = async (name: string, data: Record<string, unknown>) => {
      counter.reset();
      const start = github.length;
      await call(name, data);
      const summary = summarizeD1Calls(counter.calls);
      return {
        tool: name,
        roundTrips: summary.roundTrips,
        sequential: summary.sequential,
        githubRequests: github.length - start,
      };
    };
    const cold = await measure("link_github_issue", {
      repository: REPO,
      number: 7,
    });
    const warm = await measure("link_github_issue", {
      repository: REPO,
      number: 7,
    });
    await gitCredential(threadId);
    counter.reset();
    await gitCredential(threadId);
    const git = summarizeD1Calls(counter.calls);
    expect(warm).toMatchObject({ sequential: 2, githubRequests: 1 });
    expect(git.sequential).toBe(1);
    if (__DX_RECORD_D1_CALLS__ === "") return;
    await expect(
      `${JSON.stringify(
        {
          source:
            "apps/core/test/worker/github-tool-credentials.test.ts (local workerd, real D1)",
          notes: [
            "roundTrips: D1 calls (a batch is one); sequential: longest chain of non-overlapping calls.",
            "cold: the first call in the Thread; warm: the next one.",
          ],
          calls: {
            cold,
            warm,
            warmGitCredential: {
              roundTrips: git.roundTrips,
              sequential: git.sequential,
            },
          },
        },
        null,
        2,
      )}\n`,
    ).toMatchFileSnapshot(
      `../../../../artifacts/github-tool-credentials/${__DX_RECORD_D1_CALLS__}.json`,
    );
  });
});
