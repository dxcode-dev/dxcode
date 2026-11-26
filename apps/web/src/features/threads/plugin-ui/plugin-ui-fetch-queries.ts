import {
  GetPluginIconEndpoint,
  GetPluginThreadUiEndpoint,
  type PluginNotice,
  type PluginThreadUiData,
} from "@dx/api";
import { endpointPath } from "@dx/client";
import type { ThreadId } from "@dx/domain";
import { createElement } from "react";
import { toast } from "sonner";
import { dxClient } from "../../../shared/api/client.js";
import { linkRemarkFor } from "./plugin-link-remark.js";
import { iconForItem } from "./plugin-ui-icon-lookup.js";

/**
 * The request behind `pluginUiQueryOptions` (thread-queries.ts), loaded
 * with its first fetch, after the Thread page paints: the Thread's plugin
 * UI, its new notices shown as toasts, and its link patterns built into a
 * remark plugin for the transcript.
 */

/** Notices already toasted on this page, so a refetch never repeats one. */
const toasted = new Set<string>();

const showNotices = (
  notices: ReadonlyArray<PluginNotice>,
  plugins: PluginThreadUiData["plugins"],
) => {
  for (const notice of notices) {
    if (toasted.has(notice.id)) continue;
    toasted.add(notice.id);
    const show =
      notice.level === "success"
        ? toast.success
        : notice.level === "warning"
          ? toast.warning
          : notice.level === "error"
            ? toast.error
            : toast.info;
    // The plugin's icon by URL, a plain image: a query module draws no
    // components. Without one, the toast keeps its level's own icon.
    const src = iconForItem({ plugins }, notice)?.src;
    show(notice.message, {
      description: notice.plugin,
      ...(src === undefined
        ? {}
        : {
            icon: createElement("img", {
              src: endpointPath(GetPluginIconEndpoint, {
                params: { sha256: src },
              }),
              alt: "",
              width: 16,
              height: 16,
              decoding: "async",
              style: { borderRadius: "var(--radius-xs)" },
            }),
          }),
    });
  }
};

export const loadPluginUi = async (threadId: ThreadId, signal: AbortSignal) => {
  const { data } = await dxClient.call(
    GetPluginThreadUiEndpoint,
    { params: { threadId } },
    { signal },
  );
  showNotices(data.notices, data.plugins);
  return {
    ...data,
    linkRemark: linkRemarkFor(
      data.linkPatterns.map((link) => {
        const icon = iconForItem(data, link);
        const iconHash = icon?.src ?? icon?.monochrome;
        return iconHash === undefined ? link : { ...link, iconHash };
      }),
    ),
  };
};
