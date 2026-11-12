import {
  type PluginNotice,
  type PluginPaneEntry,
  PluginThreadUiErrorResponseSchema,
  PluginThreadUiResponseSchema,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { toast } from "sonner";
import { request } from "../../../shared/api/client.js";
import { requestPluginPane } from "../../../shared/commands/thread-open-view-event.js";
import { linkRemarkFor } from "./plugin-link-remark.js";

/**
 * The request behind `pluginUiQueryOptions` (thread-queries.ts), loaded
 * with its first fetch, after the Thread page paints: the Thread's plugin
 * UI, its new notices shown as toasts, and its link patterns built into a
 * remark plugin for the transcript.
 */

/** Notices already toasted on this page, so a refetch never repeats one. */
const toasted = new Set<string>();

const showNotices = (notices: ReadonlyArray<PluginNotice>) => {
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
    show(notice.message, { description: notice.plugin });
  }
};

/** Open requests already acted on by this page, by `plugin/pane@time`. */
const opened = new Set<string>();

/**
 * Opens each pane a plugin's code asked to open since this page last
 * looked; a request already older than the page's first look still opens
 * it, as a notice still shows, within the minute dx keeps it.
 */
const openRequestedPanes = (
  threadId: ThreadId,
  panes: ReadonlyArray<PluginPaneEntry>,
) => {
  for (const pane of panes) {
    if (pane.openedAt === undefined) continue;
    const key = `${threadId}:${pane.plugin}/${pane.pane}@${pane.openedAt}`;
    if (opened.has(key)) continue;
    opened.add(key);
    requestPluginPane({
      threadId,
      plugin: pane.plugin,
      pane: pane.pane,
      title: pane.title,
    });
  }
};

export const loadPluginUi = async (threadId: ThreadId, signal: AbortSignal) => {
  const { data } = await request(
    `/v1/threads/${encodeURIComponent(threadId)}/plugin-ui`,
    PluginThreadUiResponseSchema,
    { signal },
    PluginThreadUiErrorResponseSchema,
  );
  showNotices(data.notices);
  queueMicrotask(() => openRequestedPanes(threadId, data.panes ?? []));
  return { ...data, linkRemark: linkRemarkFor(data.linkPatterns) };
};
