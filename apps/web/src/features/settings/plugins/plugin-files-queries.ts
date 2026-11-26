import {
  ListPersonalPluginFilesEndpoint,
  ListWorkspacePluginFilesEndpoint,
  type PluginBundleUpdatePreviewData,
  PreviewPersonalPluginFilesEndpoint,
  PreviewWorkspacePluginFilesEndpoint,
  ReadPersonalPluginFileEndpoint,
  ReadWorkspacePluginFileEndpoint,
  SavePersonalPluginFilesEndpoint,
  SaveWorkspacePluginFilesEndpoint,
} from "@dx/api";
import type { PluginId, UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { dxClient, type PluginsTarget } from "../../../shared/api/client.js";
import { mcpServerKeys } from "../integrations/mcp-queries.js";
import { skillKeys } from "../skills/skills-queries.js";
import {
  pluginBundleKeys,
  pluginBundleSettingsKey,
} from "./plugin-bundle-queries.js";

/**
 * An installed plugin's files for the Plugins page's browser: the tree when
 * a plugin is chosen, a file's content when it is opened, and edits saved
 * as the plugin's next version. Nothing here loads with the list.
 */

/** Each call at the plugin's scope, with its path parameters. */
const listFiles = (
  target: PluginsTarget,
  pluginId: PluginId,
  signal: AbortSignal,
) =>
  target.scope === "personal"
    ? dxClient.call(
        ListPersonalPluginFilesEndpoint,
        { params: { pluginId } },
        { signal },
      )
    : dxClient.call(
        ListWorkspacePluginFilesEndpoint,
        { params: { workspaceSlug: target.workspaceSlug, pluginId } },
        { signal },
      );

const readFile = (
  target: PluginsTarget,
  pluginId: PluginId,
  path: string,
  signal: AbortSignal,
) =>
  target.scope === "personal"
    ? dxClient.call(
        ReadPersonalPluginFileEndpoint,
        { params: { pluginId }, query: { path } },
        { signal },
      )
    : dxClient.call(
        ReadWorkspacePluginFileEndpoint,
        {
          params: { workspaceSlug: target.workspaceSlug, pluginId },
          query: { path },
        },
        { signal },
      );

/** Keyed by the installed version, so a new version reads its own files. */
export const pluginFilesQueryOptions = (
  target: PluginsTarget,
  pluginId: PluginId,
  integrity: string,
) =>
  queryOptions({
    queryKey: ["plugin-files", target, pluginId, integrity] as const,
    queryFn: async ({ signal }) =>
      (await listFiles(target, pluginId, signal)).data,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
  });

export const pluginFileQueryOptions = (
  target: PluginsTarget,
  pluginId: PluginId,
  integrity: string,
  path: string,
) =>
  queryOptions({
    queryKey: ["plugin-file", target, pluginId, integrity, path] as const,
    queryFn: async ({ signal }) =>
      (await readFile(target, pluginId, path, signal)).data.content,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 5 * 60_000,
  });

export interface EditedPluginFile {
  readonly path: string;
  readonly content: string;
}

/** What saving the edited files would change; installs nothing. */
export const previewPluginFiles = async (
  target: PluginsTarget,
  pluginId: PluginId,
  files: ReadonlyArray<EditedPluginFile>,
) =>
  (target.scope === "personal"
    ? await dxClient.call(PreviewPersonalPluginFilesEndpoint, {
        params: { pluginId },
        body: { files },
      })
    : await dxClient.call(PreviewWorkspacePluginFilesEndpoint, {
        params: { workspaceSlug: target.workspaceSlug, pluginId },
        body: { files },
      })
  ).data;

export interface SavePluginFiles {
  readonly pluginId: PluginId;
  readonly files: ReadonlyArray<EditedPluginFile>;
  readonly preview: PluginBundleUpdatePreviewData;
  /** The person accepted what this version newly asks for. */
  readonly acceptPermissions: boolean;
}

/** Saves edited files as the previewed version and refreshes the page. */
export const savePluginFilesMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  target: PluginsTarget,
) =>
  mutationOptions({
    gcTime: 0,
    mutationFn: async (input: SavePluginFiles) => {
      const body = {
        files: input.files,
        reviewedIntegrity: input.preview.integrity,
        ...(input.acceptPermissions ? { acceptPermissions: true } : {}),
      };
      return (
        target.scope === "personal"
          ? await dxClient.call(SavePersonalPluginFilesEndpoint, {
              params: { pluginId: input.pluginId },
              body,
            })
          : await dxClient.call(SaveWorkspacePluginFilesEndpoint, {
              params: {
                workspaceSlug: target.workspaceSlug,
                pluginId: input.pluginId,
              },
              body,
            })
      ).data;
    },
    // A version can change the plugin's skills, servers, and settings.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: pluginBundleKeys.all(userId),
        }),
        queryClient.invalidateQueries({ queryKey: skillKeys.all(userId) }),
        queryClient.invalidateQueries({ queryKey: mcpServerKeys.all(userId) }),
        queryClient.invalidateQueries({
          queryKey: pluginBundleSettingsKey.root,
        }),
      ]),
  });
