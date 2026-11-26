import {
  InfiniteQueryObserver,
  MutationObserver,
  QueryClient,
} from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listSkills: vi.fn(),
  previewSkill: vi.fn(),
  removeSkill: vi.fn(),
}));

vi.mock("../../../shared/api/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/api/client.js")>()),
  ...api,
}));
// The skills API lives with the Skills settings, not the shared client.
vi.mock("../skills/skills-queries.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skills/skills-queries.js")>()),
  listSkills: api.listSkills,
  previewSkill: api.previewSkill,
  removeSkill: api.removeSkill,
}));

import { mcpServersMutationOptions } from "../integrations/mcp-mutations.js";
import { mcpServerKeys } from "../integrations/mcp-queries.js";
import { projectDefaultsMutationOptions } from "../project-defaults/project-defaults-mutations.js";
import { projectDefaultsKeys } from "../project-defaults/project-defaults-queries.js";
import {
  skillPreviewMutationOptions,
  skillsMutationOptions,
} from "../skills/skills-mutations.js";
import { skillKeys } from "../skills/skills-queries.js";
import {
  type TriggerCapabilityAction,
  triggerCapabilityMutationOptions,
  triggersMutationOptions,
} from "../triggers/triggers-mutations.js";
import { triggerKeys } from "../triggers/triggers-queries.js";
import {
  createEnvironmentVariableMutationOptions,
  environmentVariablesMutationOptions,
  environmentVariablesPreviewMutationOptions,
} from "./environment-variables-mutations.js";
import {
  environmentVariableHistoryQueryOptions,
  environmentVariableKeys,
} from "./environment-variables-queries.js";

/**
 * dx's answers by method and path, in order; environment variables call
 * dx through `dxClient`, so the test answers its requests, not its functions.
 */
const answers: Array<{
  readonly method: string;
  readonly path: string;
  readonly answer: () => Response;
}> = [];
const requests: Array<{ readonly method: string; readonly url: string }> = [];

const answer = (method: string, path: string, data: unknown) =>
  answers.push({
    method,
    path,
    answer: () =>
      new Response(JSON.stringify({ status: "success", data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

const fail = (method: string, path: string, error: Error) =>
  answers.push({
    method,
    path,
    answer: () => {
      throw error;
    },
  });

const environmentPath = "/v1/settings/personal/environment-variables";

const environmentVariable = (name: string) => ({
  reference: { version: 1, kind: "environment-variable", id: "env_test" },
  name,
  kind: "secret",
  enabled: true,
  scope: "personal",
  source: "personal",
  value: "••••••••",
  hidden: true,
  createdAt: "2026-08-25T10:00:00.000Z",
  updatedAt: "2026-08-25T10:00:00.000Z",
  rotatedAt: "2026-08-25T10:00:00.000Z",
});

const historyEvent = (id: string) => ({
  id,
  variableId: "env_test",
  name: "TOKEN",
  kind: "secret",
  action: "create",
  actorUserId: "usr_test",
  actorName: "Test User",
  requestId: `request-${id}`,
  occurredAt: "2026-08-25T10:00:00.000Z",
});

const triggerId = "trg_00000000-0000-4000-8000-000000000000";

const pluginTrigger = {
  id: triggerId,
  pluginId: "plg_00000000-0000-4000-8000-000000000000",
  pluginName: "deploys",
  pluginDisplayName: "Deploys",
  pluginVersion: "1.0.0",
  source: "webhook",
  sourceLabel: "Webhook",
  capabilityName: "deploy",
  event: "deploy.finished",
  action: "deploy",
  permission: "trigger-delivery",
  idempotent: true,
  status: "active",
  hmacConfigured: false,
  createdAt: "2026-08-25T10:00:00.000Z",
  updatedAt: "2026-08-25T10:00:00.000Z",
  rotatedAt: "2026-08-25T10:00:00.000Z",
  deliverySummary: {
    pending: 0,
    inFlight: 0,
    succeeded: 0,
    deadLetter: 0,
    cancelled: 0,
  },
  deliveries: [],
};

const userId = "usr_test" as never;
const personal = { scope: "personal" } as const;
const projectDefaultOverrides = {
  shipAction: null,
  commitAuthor: null,
  signingPreference: null,
  runnerProfileId: null,
  dxCoAuthor: null,
} as const;

const mutationData = (client: QueryClient) =>
  client
    .getMutationCache()
    .getAll()
    .map((mutation) => mutation.state.data);

describe("runtime settings data ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const request of Object.values(api)) request.mockResolvedValue({});
    answers.length = 0;
    requests.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        requests.push({ method, url: input });
        const path = input.split("?")[0];
        const index = answers.findIndex(
          (candidate) => candidate.method === method && candidate.path === path,
        );
        if (index === -1) throw new Error(`No answer for ${method} ${input}`);
        const [next] = answers.splice(index, 1);
        return next?.answer();
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps loaded history when a continuation fails and retries its cursor", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const historyPath = `${environmentPath}/history`;
    answer("GET", historyPath, {
      items: [historyEvent("history-first")],
      nextCursor: "history-cursor",
    });
    const observer = new InfiniteQueryObserver(
      client,
      environmentVariableHistoryQueryOptions(userId, personal),
    );
    const unsubscribe = observer.subscribe(() => undefined);
    const ids = (
      pages: ReadonlyArray<{ items: ReadonlyArray<{ id: string }> }>,
    ) => pages.map((page) => page.items.map((item) => item.id));

    await observer.refetch();
    fail("GET", historyPath, new Error("Older history is unavailable."));
    const failed = await observer.fetchNextPage();

    expect(failed.isFetchNextPageError).toBe(true);
    expect(ids(failed.data?.pages ?? [])).toEqual([["history-first"]]);

    answer("GET", historyPath, { items: [historyEvent("history-second")] });
    const retried = await observer.fetchNextPage();
    expect(ids(retried.data?.pages ?? [])).toEqual([
      ["history-first"],
      ["history-second"],
    ]);
    // The failed page and its retry both ask for the same cursor.
    expect(requests.map((request) => request.url)).toEqual([
      `${historyPath}?scope=personal&limit=20`,
      `${historyPath}?scope=personal&limit=20&cursor=history-cursor`,
      `${historyPath}?scope=personal&limit=20&cursor=history-cursor`,
    ]);

    unsubscribe();
  });

  it("applies exact invalidation and authoritative cache policies", async () => {
    const client = new QueryClient();
    const environmentKey = environmentVariableKeys.list(userId, personal);
    const environmentHistoryKey = environmentVariableKeys.history(
      userId,
      personal,
    );
    const mcpKey = mcpServerKeys.list(userId, personal);
    const skillKey = skillKeys.list(userId, personal);
    const triggerKey = triggerKeys.list(userId);
    for (const key of [
      environmentKey,
      environmentHistoryKey,
      mcpKey,
      skillKey,
      triggerKey,
    ])
      client.setQueryData(key, { items: [] });

    answer("POST", `${environmentPath}/bulk`, {
      items: [],
      conflictBehavior: "reject",
    });
    await client
      .getMutationCache()
      .build(
        client,
        environmentVariablesMutationOptions(client, userId, personal),
      )
      .execute({
        type: "applyBulk",
        input: {
          kind: "variable",
          contents: "NAME=value",
          conflictBehavior: "reject",
        },
      });
    const serverId = "mcp_00000000-0000-4000-8000-000000000000";
    answer("DELETE", `/v1/settings/personal/mcp-servers/${serverId}`, {
      deletedMcpServerId: serverId,
    });
    await client
      .getMutationCache()
      .build(client, mcpServersMutationOptions(client, userId, personal))
      .execute({ type: "delete", serverId: serverId as never });
    await client
      .getMutationCache()
      .build(client, skillsMutationOptions(client, userId, personal))
      .execute({ type: "remove", skillId: "skl_test" as never });
    answer("DELETE", `/v1/settings/personal/triggers/${triggerId}`, {
      revokedTriggerId: triggerId,
    });
    await client
      .getMutationCache()
      .build(client, triggersMutationOptions(client, userId))
      .execute({ type: "revoke", triggerId: triggerId as never });

    for (const key of [
      environmentKey,
      environmentHistoryKey,
      mcpKey,
      skillKey,
      triggerKey,
    ])
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);

    const saved = {
      scope: "personal",
      revision: 4,
      overrides: projectDefaultOverrides,
      resolved: {
        shipAction: { value: "ship", source: "deployment" },
        commitAuthor: { value: "dx", source: "deployment" },
        signingPreference: { value: "disabled", source: "deployment" },
        runnerProfileId: { value: "e2b-standard", source: "deployment" },
        dxCoAuthor: { value: true, source: "deployment" },
      },
      catalog: {
        version: 1,
        defaultProfileId: "e2b-standard",
        profiles: [],
        adapterStates: [],
      },
      restrictions: {
        allowProjectCreation: true,
        allowPublicCodeAccess: false,
        allowedRunnerProfileIds: null,
        source: "deployment",
      },
      canUpdate: true,
    };
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(Response.json({ status: "success", data: saved }));
    vi.stubGlobal("fetch", fetch);
    await client
      .getMutationCache()
      .build(client, projectDefaultsMutationOptions(client, userId, personal))
      .execute({ expectedRevision: 3, overrides: projectDefaultOverrides });
    vi.unstubAllGlobals();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect([url, init?.method, JSON.parse(String(init?.body))]).toEqual([
      "/v1/settings/personal/projects",
      "PUT",
      { expectedRevision: 3, overrides: projectDefaultOverrides },
    ]);
    expect(
      client.getQueryData(projectDefaultsKeys.detail(userId, personal)),
    ).toMatchObject({ revision: 4, canUpdate: true });
  });

  it("removes environment secret inputs and trigger capabilities after delivery", async () => {
    const client = new QueryClient();
    const secret = "environment-secret-input";
    const capability = `dxt_${"a".repeat(43)}`;
    answer("POST", environmentPath, environmentVariable("TOKEN"));
    const capabilityUrl = `https://dx.example/api/triggers/${triggerId}/${capability}`;
    answer("POST", "/v1/settings/personal/triggers", {
      trigger: pluginTrigger,
      capability: { capabilityUrl, token: capability },
    });

    const environmentObserver = new MutationObserver(
      client,
      createEnvironmentVariableMutationOptions(client, userId, personal),
    );
    const deliveredEnvironment = await environmentObserver.mutate({
      name: "TOKEN",
      kind: "secret",
      value: secret,
    });
    expect(deliveredEnvironment.name).toBe("TOKEN");
    expect(deliveredEnvironment.value).not.toContain(secret);
    environmentObserver.reset();

    const triggerObserver = new MutationObserver(
      client,
      triggerCapabilityMutationOptions(client, userId),
    );
    const triggerAction: TriggerCapabilityAction = {
      type: "create",
      input: {
        pluginId: pluginTrigger.pluginId,
        pluginVersion: pluginTrigger.pluginVersion,
        capabilityName: pluginTrigger.capabilityName,
      } as never,
    };
    const deliveredTrigger = await triggerObserver.mutate(triggerAction);
    expect(deliveredTrigger.capability).toEqual({
      capabilityUrl,
      token: capability,
    });
    triggerObserver.reset();

    await vi.waitFor(() => expect(mutationData(client)).toEqual([]));
    const cached = JSON.stringify({
      mutations: mutationData(client),
      queries: client
        .getQueryCache()
        .getAll()
        .map((query) => query.state.data),
    });
    expect(cached).not.toContain(secret);
    expect(cached).not.toContain(capability);
  });

  it("delivers previews locally without retaining them in Query caches", async () => {
    const client = new QueryClient();
    const previewMarker = "preview-only-contents";
    answer("POST", `${environmentPath}/bulk/preview`, {
      items: [{ line: 1, name: previewMarker, status: "ready" }],
      canApply: true,
    });
    api.previewSkill.mockResolvedValueOnce({ previewMarker });
    const environmentObserver = new MutationObserver(
      client,
      environmentVariablesPreviewMutationOptions(userId, personal),
    );
    const skillObserver = new MutationObserver(
      client,
      skillPreviewMutationOptions(userId, personal),
    );

    const delivered = await Promise.all([
      environmentObserver.mutate({
        kind: "variable",
        contents: "NAME=value",
      }),
      skillObserver.mutate({} as never),
    ]);
    expect(delivered).toEqual([
      {
        items: [{ line: 1, name: previewMarker, status: "ready" }],
        canApply: true,
      },
      { previewMarker },
    ]);
    expect(client.getQueryCache().getAll()).toEqual([]);

    environmentObserver.reset();
    skillObserver.reset();
    await vi.waitFor(() => expect(mutationData(client)).toEqual([]));
    expect(JSON.stringify(mutationData(client))).not.toContain(previewMarker);
  });

  it("evicts rejected secret inputs after observer completion", async () => {
    const client = new QueryClient();
    const marker = "rejected-secret-input";
    fail(
      "POST",
      `${environmentPath}/bulk/preview`,
      new Error("preview rejected"),
    );
    const observer = new MutationObserver(
      client,
      environmentVariablesPreviewMutationOptions(userId, personal),
    );

    await expect(
      observer.mutate({ kind: "secret", contents: marker }),
    ).rejects.toThrow("preview rejected");
    expect(JSON.stringify(observer.getCurrentResult())).toContain(marker);
    observer.reset();
    await vi.waitFor(() => expect(mutationData(client)).toEqual([]));

    expect(JSON.stringify(client.getMutationCache().getAll())).not.toContain(
      marker,
    );
  });
});
