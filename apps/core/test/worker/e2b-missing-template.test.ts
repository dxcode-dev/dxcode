import { env } from "cloudflare:test";
import {
  type ProjectId,
  ProjectRepository,
  ThreadRepository,
  type UserId,
} from "@dx/domain";
import { SandboxError } from "e2b";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeExecutionActivation } from "../../src/execution/activation.js";
import { makeE2BExecutionProvider } from "../../src/execution/e2b/provider.js";
import type { E2BResolverApi } from "../../src/execution/e2b/resolver.js";
import type { Bindings } from "../../src/http/types.js";
import { composeExecutionWorkspaces } from "../../src/plugins/execution/provider.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * #1936: an E2B account without dx's Orb template refuses every create with
 * `404: template '…' not found`. The Thread must say which provider lacks
 * its template and what fixes it, instead of settling as "internal error",
 * and the Thread's workspace must stay ready for a create once it is fixed.
 * The real composition, activation pipeline, and E2B provider run over real
 * D1; only the E2B control plane is faked.
 */

const owner = "missing-template-owner" as UserId;
const ownerProject = project(
  "prj_00000000-0000-4000-8000-000000001936",
  owner,
  "missing-template-owner-personal",
);
const workerEnv = env as unknown as Record<string, unknown>;

/** An E2B team with no Orb templates: every create is refused. */
const templatelessE2B = (creates: Array<string>) =>
  ({
    list: () => ({ hasNext: false, nextItems: async () => [] }),
    getInfo: async () => {
      throw new Error("no sandbox");
    },
    connect: async () => {
      throw new Error("no sandbox");
    },
    create: async (options: { readonly template?: string }) => {
      creates.push(options.template ?? "");
      throw new SandboxError(`404: template '${options.template}' not found`);
    },
    kill: async () => true,
    pause: async () => true,
    isNotFound: () => false,
  }) as unknown as E2BResolverApi;

const startTurn = async (threadId: string, creates: Array<string>) => {
  Object.assign(workerEnv, {
    E2B_API_KEY: "test-e2b-key",
    DX_ENV: "test",
    DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
    THREAD_EXECUTION: undefined,
    DX_STORAGE: undefined,
  });
  await env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  )
    .bind(owner, "Ada Owner", `${owner}@example.com`)
    .run();
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(ownerProject);
      yield* (yield* ThreadRepository).insert(
        thread(threadId, ownerProject.id as ProjectId, owner),
      );
    }),
  );
  await env.DB.prepare(
    "UPDATE projects SET runner_profile_id = 'a1.medium'",
  ).run();
  const workspaces = composeExecutionWorkspaces(
    workerEnv as unknown as Bindings,
    { e2b: makeE2BExecutionProvider(templatelessE2B(creates)) },
    makeExecutionActivation(),
  );
  return workspaces.sandboxFactory.createSandbox({ id: threadId }).then(
    () => {
      throw new Error("The Orb started without a template.");
    },
    (error: unknown) => error,
  );
};

describe("An E2B account without dx's Orb template (#1936)", () => {
  it("fails the turn naming E2B and the fix, and leaves the workspace ready to create", async () => {
    const threadId = "thr_00000000-0000-4000-8000-000000193601";
    const creates: Array<string> = [];
    const error = await startTurn(threadId, creates);

    expect(creates).toEqual(["base"]);
    expect(error).toMatchObject({
      type: "orb_template_missing",
      meta: { code: "ORB_TEMPLATE_MISSING" },
    });
    const { message, details } = error as {
      readonly message: string;
      readonly details: string;
    };
    expect(message).toMatch(/E2B/);
    expect(message).toMatch(/template/i);
    expect(details).toMatch(/base/);
    expect(details).toMatch(/another Orb provider|redeploy/i);

    // No sandbox was made, so the next turn creates instead of reconciling.
    const workspace = await env.DB.prepare(
      "SELECT state, provider_sandbox_id FROM execution_workspace WHERE thread_id = ?",
    )
      .bind(threadId)
      .first();
    expect(workspace).toMatchObject({
      state: "uninitialized",
      provider_sandbox_id: null,
    });
  });
});
