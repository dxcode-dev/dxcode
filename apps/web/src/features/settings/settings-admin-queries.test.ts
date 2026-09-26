import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applicationMutationOptions } from "./applications/application-mutations.js";
import {
  applicationAuditQueryOptions,
  applicationKeys,
  applicationsQueryOptions,
} from "./applications/application-queries.js";
import { integrationMutationOptions } from "./integrations/integration-mutations.js";
import { integrationKeys } from "./integrations/integration-queries.js";
import {
  settingsContextQueryOptions,
  settingsKeys,
} from "./settings-context-queries.js";

const userId = "user-1" as never;
const otherUserId = "user-2" as never;
const workspaceSlug = "sample-team" as never;
const otherWorkspaceSlug = "other-team" as never;

afterEach(() => vi.unstubAllGlobals());

describe("settings administration query contracts", () => {
  it("isolates users, personal integration scope, and workspaces", () => {
    expect(settingsKeys.context(userId, { scope: "personal" })).not.toEqual(
      settingsKeys.context(userId, {
        scope: "workspace",
        workspaceSlug,
      }),
    );
    expect(
      settingsKeys.context(userId, { scope: "workspace", workspaceSlug }),
    ).not.toEqual(
      settingsKeys.context(userId, {
        scope: "workspace",
        workspaceSlug: otherWorkspaceSlug,
      }),
    );
    expect(integrationKeys.personal(userId)).not.toEqual(
      integrationKeys.personal(otherUserId),
    );
  });

  it("uses server cursors as infinite-query page parameters", () => {
    const applications = applicationsQueryOptions(userId, workspaceSlug);
    const audit = applicationAuditQueryOptions(
      userId,
      workspaceSlug,
      "application-1" as never,
    );
    for (const options of [applications, audit]) {
      expect(
        options.getNextPageParam?.(
          { items: [], nextCursor: "next" as never, permissions: [] } as never,
          [],
          undefined,
          [],
        ),
      ).toBe("next");
      expect(
        options.getNextPageParam?.(
          { items: [], permissions: [] } as never,
          [],
          undefined,
          [],
        ),
      ).toBeUndefined();
    }
  });

  it("passes Query cancellation through the settings request", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        requestSignal = init?.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }),
    );
    const queryClient = new QueryClient();
    const promise = queryClient.fetchQuery(
      settingsContextQueryOptions(userId, { scope: "personal" }),
    );
    await vi.waitFor(() => expect(requestSignal).toBeDefined());

    await queryClient.cancelQueries({
      queryKey: settingsKeys.contexts(userId),
    });

    expect(requestSignal?.aborted).toBe(true);
    await expect(promise).rejects.toBeDefined();
  });

  it("invalidates only the owning workspace prefixes and evicts one-shot results", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const application = applicationMutationOptions(
      queryClient,
      userId,
      workspaceSlug,
    );
    const integration = integrationMutationOptions(queryClient, userId);

    await application.onSuccess?.(
      {},
      {
        kind: "enabled",
        applicationId: "application-1" as never,
        enabled: true,
      },
      undefined,
      {} as never,
    );

    expect(invalidate).toHaveBeenNthCalledWith(1, {
      queryKey: applicationKeys.all(userId, workspaceSlug),
    });
    expect(application.gcTime).toBe(0);
    expect(integration.gcTime).toBe(0);
  });
});
