import {
  InfiniteQueryObserver,
  MutationObserver,
  QueryClient,
} from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  applyBulkEnvironmentVariables: vi.fn(),
  createEnvironmentVariable: vi.fn(),
  createPluginTrigger: vi.fn(),
  deleteMcpServer: vi.fn(),
  exportSkill: vi.fn(),
  getProjectDefaults: vi.fn(),
  listEnvironmentVariableHistory: vi.fn(),
  listEnvironmentVariables: vi.fn(),
  listMcpServers: vi.fn(),
  listPlugins: vi.fn(),
  listPluginTriggers: vi.fn(),
  listSkills: vi.fn(),
  previewBulkEnvironmentVariables: vi.fn(),
  previewPlugin: vi.fn(),
  previewSkill: vi.fn(),
  removePlugin: vi.fn(),
  removeSkill: vi.fn(),
  revokePluginTrigger: vi.fn(),
  updatePersonalProjectDefaults: vi.fn(),
}));

vi.mock("../../../shared/api/client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../shared/api/client.js")>()),
  ...api,
}));

import {
  type PluginsMutationAction,
  pluginPreviewMutationOptions,
  pluginsMutationOptions,
} from "../custom-plugins/custom-plugins-mutations.js";
import {
  pluginKeys,
  pluginsQueryOptions,
} from "../custom-plugins/custom-plugins-queries.js";
import {
  type McpServersMutationAction,
  mcpServersMutationOptions,
} from "../integrations/mcp-mutations.js";
import {
  mcpServerKeys,
  mcpServersQueryOptions,
} from "../integrations/mcp-queries.js";
import { projectDefaultsMutationOptions } from "../project-defaults/project-defaults-mutations.js";
import {
  projectDefaultsKeys,
  projectDefaultsQueryOptions,
} from "../project-defaults/project-defaults-queries.js";
import {
  type SkillsMutationAction,
  skillExportMutationOptions,
  skillPreviewMutationOptions,
  skillsMutationOptions,
} from "../skills/skills-mutations.js";
import { skillKeys, skillsQueryOptions } from "../skills/skills-queries.js";
import {
  type TriggerCapabilityAction,
  type TriggersMutationAction,
  triggerCapabilityMutationOptions,
  triggersMutationOptions,
} from "../triggers/triggers-mutations.js";
import {
  triggerKeys,
  triggersQueryOptions,
} from "../triggers/triggers-queries.js";
import {
  createEnvironmentVariableMutationOptions,
  type EnvironmentVariablesMutationAction,
  environmentVariablesMutationOptions,
  environmentVariablesPreviewMutationOptions,
} from "./environment-variables-mutations.js";
import {
  environmentVariableHistoryQueryOptions,
  environmentVariableKeys,
  environmentVariablesQueryOptions,
} from "./environment-variables-queries.js";

const userId = "usr_test" as never;
const personal = { scope: "personal" } as const;
const projectDefaultOverrides = {
  shipAction: null,
  commitAuthor: null,
  signingPreference: null,
  runnerProfileId: null,
} as const;

const runQuery = async (
  options: {
    readonly queryFn?: unknown;
    readonly queryKey: readonly unknown[];
  },
  signal: AbortSignal,
) => {
  if (typeof options.queryFn !== "function") throw new Error("Missing queryFn");
  await options.queryFn({
    queryKey: options.queryKey,
    signal,
    meta: undefined,
  });
};

const mutationData = (client: QueryClient) =>
  client
    .getMutationCache()
    .getAll()
    .map((mutation) => mutation.state.data);

describe("runtime settings data ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const request of Object.values(api)) request.mockResolvedValue({});
  });

  it("forwards Query cancellation to every owned settings read", async () => {
    const signal = new AbortController().signal;
    await runQuery(environmentVariablesQueryOptions(userId, personal), signal);
    await runQuery(
      environmentVariableHistoryQueryOptions(userId, personal),
      signal,
    );
    await runQuery(mcpServersQueryOptions(userId, personal), signal);
    await runQuery(pluginsQueryOptions(userId, personal), signal);
    await runQuery(skillsQueryOptions(userId, personal), signal);
    await runQuery(triggersQueryOptions(userId), signal);
    await runQuery(projectDefaultsQueryOptions(userId, personal), signal);

    expect(api.listEnvironmentVariables).toHaveBeenCalledWith(personal, signal);
    expect(api.listEnvironmentVariableHistory).toHaveBeenCalledWith(
      personal,
      undefined,
      signal,
    );
    expect(api.listMcpServers).toHaveBeenCalledWith(personal, signal);
    expect(api.listPlugins).toHaveBeenCalledWith(personal, signal);
    expect(api.listSkills).toHaveBeenCalledWith(personal, signal);
    expect(api.listPluginTriggers).toHaveBeenCalledWith(signal);
    expect(api.getProjectDefaults).toHaveBeenCalledWith(personal, signal);
  });

  it("keeps loaded history when a continuation fails and retries its cursor", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const first = {
      items: [{ id: "history-first" }],
      nextCursor: "history-cursor",
    };
    const second = {
      items: [{ id: "history-second" }],
      nextCursor: undefined,
    };
    api.listEnvironmentVariableHistory.mockResolvedValueOnce(first);
    const observer = new InfiniteQueryObserver(
      client,
      environmentVariableHistoryQueryOptions(userId, personal),
    );
    const unsubscribe = observer.subscribe(() => undefined);

    await observer.refetch();
    api.listEnvironmentVariableHistory.mockRejectedValueOnce(
      new Error("Older history is unavailable."),
    );
    const failed = await observer.fetchNextPage();

    expect(failed.isFetchNextPageError).toBe(true);
    expect(failed.data?.pages).toEqual([first]);

    api.listEnvironmentVariableHistory.mockResolvedValueOnce(second);
    const retried = await observer.fetchNextPage();
    expect(retried.data?.pages).toEqual([first, second]);
    expect(api.listEnvironmentVariableHistory).toHaveBeenNthCalledWith(
      2,
      personal,
      "history-cursor",
      expect.anything(),
    );
    expect(api.listEnvironmentVariableHistory).toHaveBeenNthCalledWith(
      3,
      personal,
      "history-cursor",
      expect.anything(),
    );

    unsubscribe();
  });

  it("starts feature HTTP requests inside typed mutation functions", async () => {
    const client = new QueryClient();
    const environmentAction: EnvironmentVariablesMutationAction = {
      type: "applyBulk",
      input: {
        kind: "variable",
        contents: "NAME=value",
        conflictBehavior: "reject",
      },
    };
    const mcpAction: McpServersMutationAction = {
      type: "delete",
      serverId: "mcp_test" as never,
    };
    const pluginAction: PluginsMutationAction = {
      type: "remove",
      pluginId: "plg_test" as never,
    };
    const skillAction: SkillsMutationAction = {
      type: "remove",
      skillId: "skl_test" as never,
    };
    const triggerAction: TriggersMutationAction = {
      type: "revoke",
      triggerId: "trg_test" as never,
    };

    const environment = environmentVariablesMutationOptions(
      client,
      userId,
      personal,
    );
    const mcp = mcpServersMutationOptions(client, userId, personal);
    const plugin = pluginsMutationOptions(client, userId, personal);
    const skill = skillsMutationOptions(client, userId, personal);
    const trigger = triggersMutationOptions(client, userId);
    const defaults = projectDefaultsMutationOptions(client, userId, personal);

    expect(api.applyBulkEnvironmentVariables).not.toHaveBeenCalled();
    await environment.mutationFn?.(environmentAction, {} as never);
    expect(api.applyBulkEnvironmentVariables).toHaveBeenCalledWith(
      personal,
      environmentAction.input,
    );

    expect(api.deleteMcpServer).not.toHaveBeenCalled();
    await mcp.mutationFn?.(mcpAction, {} as never);
    expect(api.deleteMcpServer).toHaveBeenCalledWith(
      personal,
      mcpAction.serverId,
    );

    expect(api.removePlugin).not.toHaveBeenCalled();
    await plugin.mutationFn?.(pluginAction, {} as never);
    expect(api.removePlugin).toHaveBeenCalledWith(
      personal,
      pluginAction.pluginId,
    );

    expect(api.removeSkill).not.toHaveBeenCalled();
    await skill.mutationFn?.(skillAction, {} as never);
    expect(api.removeSkill).toHaveBeenCalledWith(personal, skillAction.skillId);

    expect(api.revokePluginTrigger).not.toHaveBeenCalled();
    await trigger.mutationFn?.(triggerAction, {} as never);
    expect(api.revokePluginTrigger).toHaveBeenCalledWith(
      triggerAction.triggerId,
    );

    expect(api.updatePersonalProjectDefaults).not.toHaveBeenCalled();
    await defaults.mutationFn?.(
      { expectedRevision: 3, overrides: projectDefaultOverrides },
      {} as never,
    );
    expect(api.updatePersonalProjectDefaults).toHaveBeenCalledWith(
      3,
      projectDefaultOverrides,
    );
  });

  it("applies exact invalidation and authoritative cache policies", async () => {
    const client = new QueryClient();
    const environmentKey = environmentVariableKeys.list(userId, personal);
    const environmentHistoryKey = environmentVariableKeys.history(
      userId,
      personal,
    );
    const mcpKey = mcpServerKeys.list(userId, personal);
    const pluginKey = pluginKeys.list(userId, personal);
    const skillKey = skillKeys.list(userId, personal);
    const triggerKey = triggerKeys.list(userId);
    for (const key of [
      environmentKey,
      environmentHistoryKey,
      mcpKey,
      pluginKey,
      skillKey,
      triggerKey,
    ])
      client.setQueryData(key, { items: [] });

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
    await client
      .getMutationCache()
      .build(client, mcpServersMutationOptions(client, userId, personal))
      .execute({ type: "delete", serverId: "mcp_test" as never });
    await client
      .getMutationCache()
      .build(client, pluginsMutationOptions(client, userId, personal))
      .execute({ type: "remove", pluginId: "plg_test" as never });
    await client
      .getMutationCache()
      .build(client, skillsMutationOptions(client, userId, personal))
      .execute({ type: "remove", skillId: "skl_test" as never });
    await client
      .getMutationCache()
      .build(client, triggersMutationOptions(client, userId))
      .execute({ type: "revoke", triggerId: "trg_test" as never });

    for (const key of [
      environmentKey,
      environmentHistoryKey,
      mcpKey,
      pluginKey,
      skillKey,
      triggerKey,
    ])
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);

    const saved = { revision: 4, marker: "authoritative" } as never;
    api.updatePersonalProjectDefaults.mockResolvedValueOnce(saved);
    await client
      .getMutationCache()
      .build(client, projectDefaultsMutationOptions(client, userId, personal))
      .execute({ expectedRevision: 3, overrides: projectDefaultOverrides });
    expect(
      client.getQueryData(projectDefaultsKeys.detail(userId, personal)),
    ).toBe(saved);
  });

  it("removes environment secret inputs and trigger capabilities after delivery", async () => {
    const client = new QueryClient();
    const secret = "environment-secret-input";
    const capability = "one-time-trigger-capability";
    const created = { id: "environment-metadata" };
    api.createEnvironmentVariable.mockResolvedValueOnce(created);
    api.createPluginTrigger.mockResolvedValueOnce({
      capability: { secret: capability },
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
    expect(deliveredEnvironment).toBe(created);
    environmentObserver.reset();

    const triggerObserver = new MutationObserver(
      client,
      triggerCapabilityMutationOptions(client, userId),
    );
    const triggerAction: TriggerCapabilityAction = {
      type: "create",
      input: {} as never,
    };
    const deliveredTrigger = await triggerObserver.mutate(triggerAction);
    expect(deliveredTrigger).toEqual({ capability: { secret: capability } });
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

  it("treats skill export as a resettable one-shot mutation", async () => {
    const client = new QueryClient();
    const contents = "export-only-contents";
    api.exportSkill.mockResolvedValueOnce({ files: [{ content: contents }] });
    const observer = new MutationObserver(
      client,
      skillExportMutationOptions(userId, personal),
    );

    expect(api.exportSkill).not.toHaveBeenCalled();
    const delivered = await observer.mutate("skl_test" as never);
    expect(api.exportSkill).toHaveBeenCalledWith(personal, "skl_test");
    expect(delivered).toEqual({ files: [{ content: contents }] });
    expect(client.getQueryCache().getAll()).toEqual([]);

    observer.reset();
    await vi.waitFor(() => expect(mutationData(client)).toEqual([]));
    expect(JSON.stringify(mutationData(client))).not.toContain(contents);
  });

  it("delivers previews locally without retaining them in Query caches", async () => {
    const client = new QueryClient();
    const previewMarker = "preview-only-contents";
    api.previewBulkEnvironmentVariables.mockResolvedValueOnce({
      previewMarker,
    });
    api.previewPlugin.mockResolvedValueOnce({ previewMarker });
    api.previewSkill.mockResolvedValueOnce({ previewMarker });
    const environmentObserver = new MutationObserver(
      client,
      environmentVariablesPreviewMutationOptions(userId, personal),
    );
    const pluginObserver = new MutationObserver(
      client,
      pluginPreviewMutationOptions(userId, personal),
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
      pluginObserver.mutate({} as never),
      skillObserver.mutate({} as never),
    ]);
    expect(delivered).toEqual([
      { previewMarker },
      { previewMarker },
      { previewMarker },
    ]);
    expect(client.getQueryCache().getAll()).toEqual([]);

    environmentObserver.reset();
    pluginObserver.reset();
    skillObserver.reset();
    await vi.waitFor(() => expect(mutationData(client)).toEqual([]));
    expect(JSON.stringify(mutationData(client))).not.toContain(previewMarker);
  });

  it("evicts rejected secret inputs after observer completion", async () => {
    const client = new QueryClient();
    const marker = "rejected-secret-input";
    api.previewBulkEnvironmentVariables.mockRejectedValueOnce(
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
