import {
  CallPluginDataViewEndpoint,
  CallThreadPluginDataViewEndpoint,
  GetPluginDataViewDefinitionEndpoint,
  GetPluginDataViewStateEndpoint,
  GetThreadPluginDataViewDefinitionEndpoint,
  GetThreadPluginDataViewStateEndpoint,
  type PluginDataViewStateData,
} from "@dx/api";
import {
  type DataViewDefinition,
  parseStatePath,
  type ThreadId,
  writeStatePath,
} from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { dxClient } from "../../../shared/api/client.js";
import type {
  DataViewAddress,
  DataViewSource,
} from "../../../shared/realtime/live.js";

/**
 * A view described as data: its file (fixed by its address, so it is read
 * once), its state, and its `call` action. A view inside a Thread reads
 * through the Thread, so its members see the owner's plugins; a page reads
 * the person's own installs.
 */

export type { DataViewAddress, DataViewSource };

const pageParams = (address: DataViewAddress) => ({
  plugin: address.plugin,
  view: address.view,
});

const threadParams = (address: DataViewAddress, threadId: string) => ({
  ...pageParams(address),
  threadId: threadId as ThreadId,
});

export const dataViewKeys = {
  all: ["plugin-data-view"] as const,
  definition: (installId: string, integrity: string) =>
    [...dataViewKeys.all, "definition", installId, integrity] as const,
  state: (address: DataViewAddress) =>
    [
      ...dataViewKeys.all,
      "state",
      address.source.kind === "page" ? "page" : address.source.threadId,
      address.plugin,
      address.view,
    ] as const,
};

export const dataViewDefinitionQueryOptions = (address: DataViewAddress) =>
  queryOptions({
    queryKey: dataViewKeys.definition(address.installId, address.integrity),
    // dx checked the file when the plugin was installed, or the draft
    // loaded. A draft's file is kept with its Thread, so it is read through
    // that Thread; the address carries the file's sha256 either way.
    queryFn: async ({ signal }) => {
      const { source } = address;
      const file =
        address.installId.startsWith("plg_draft-") && source.kind === "thread"
          ? await dxClient.call(
              GetThreadPluginDataViewDefinitionEndpoint,
              {
                params: threadParams(address, source.threadId),
                query: { v: address.integrity },
              },
              { signal },
            )
          : await dxClient.call(
              GetPluginDataViewDefinitionEndpoint,
              {
                params: {
                  installId: address.installId,
                  integrity: address.integrity,
                },
              },
              { signal },
            );
      return JSON.parse(await file.text()) as DataViewDefinition;
    },
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
    retry: 1,
  });

export const dataViewStateQueryOptions = (address: DataViewAddress) =>
  queryOptions({
    queryKey: dataViewKeys.state(address),
    queryFn: async ({ signal }) => {
      const { source } = address;
      return (
        source.kind === "page"
          ? await dxClient.call(
              GetPluginDataViewStateEndpoint,
              { params: pageParams(address) },
              { signal },
            )
          : await dxClient.call(
              GetThreadPluginDataViewStateEndpoint,
              { params: threadParams(address, source.threadId) },
              { signal },
            )
      ).data;
    },
    // Live changes arrive on the realtime connection; a whole state can be
    // large, so it is replaced, never compared.
    structuralSharing: false,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });

/**
 * Applies changes the realtime connection brought, at most once per
 * animation frame per view. A change that is not the next version, or came
 * without its value, reads the whole state again.
 */
export const liveStateApplier = (
  queryClient: QueryClient,
  address: DataViewAddress,
) => {
  const key = dataViewKeys.state(address);
  const pending: Array<{
    readonly version: number;
    readonly patch?: { readonly path: string; readonly value?: unknown };
  }> = [];
  let frame: number | undefined;
  const refetch = () => {
    pending.length = 0;
    void queryClient.invalidateQueries({ queryKey: key, exact: true });
  };
  const flush = () => {
    frame = undefined;
    const current = queryClient.getQueryData<PluginDataViewStateData>(key);
    if (current === undefined) return refetch();
    let { state, version } = current;
    for (const change of pending.splice(0)) {
      if (change.version <= version) continue;
      const segments =
        change.patch === undefined
          ? undefined
          : parseStatePath(change.patch.path);
      if (change.version !== version + 1 || segments === undefined)
        return refetch();
      const written = writeStatePath(
        state ?? {},
        segments,
        change.patch?.value,
      );
      if (!written.ok) return refetch();
      state = written.state;
      version = change.version;
    }
    queryClient.setQueryData<PluginDataViewStateData>(key, {
      ...current,
      state,
      version,
    });
  };
  return {
    change: (change: (typeof pending)[number]) => {
      pending.push(change);
      frame ??= requestAnimationFrame(flush);
    },
    stale: refetch,
    stop: () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      frame = undefined;
      pending.length = 0;
    },
  };
};

const errorDetail = (error: unknown) =>
  error !== null &&
  typeof error === "object" &&
  "data" in error &&
  typeof (error as { data?: { detail?: unknown; message?: unknown } }).data
    ?.detail === "string"
    ? (error as { data: { detail: string } }).data.detail
    : error !== null &&
        typeof error === "object" &&
        "data" in error &&
        typeof (error as { data?: { message?: unknown } }).data?.message ===
          "string"
      ? (error as { data: { message: string } }).data.message
      : error instanceof Error
        ? error.message
        : "The plugin could not answer.";

/** A view's `call` action. */
export const dataViewCallMutationOptions = (address: DataViewAddress) =>
  mutationOptions({
    mutationFn: async (input: {
      readonly fn: string;
      readonly args: Readonly<Record<string, unknown>>;
      readonly result?: string;
    }) => {
      const { source } = address;
      try {
        return (
          source.kind === "page"
            ? await dxClient.call(CallPluginDataViewEndpoint, {
                params: pageParams(address),
                body: input,
              })
            : await dxClient.call(CallThreadPluginDataViewEndpoint, {
                params: threadParams(address, source.threadId),
                body: input,
              })
        ).data;
      } catch (error) {
        throw new Error(errorDetail(error));
      }
    },
  });

/** Reads every open view's state again, after a call changed one. */
export const invalidateDataViewStates = (queryClient: QueryClient) =>
  queryClient.invalidateQueries({
    queryKey: [...dataViewKeys.all, "state"],
  });
