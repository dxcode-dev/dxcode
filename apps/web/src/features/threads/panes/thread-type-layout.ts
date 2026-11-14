import type { ThreadPaneLayout, ThreadPaneTab } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import { pluginUiQueryOptions } from "../thread-queries.js";

/*
 * Loaded only for a Thread with a plugin type and no saved layout, so a
 * plain Thread's first load carries none of it.
 */

/**
 * The first layout of a plugin Thread type's Thread: the plugin's tab
 * draws the main area, with the chat in a side pane, or behind its tab when
 * the type hides the chat. People rearrange it like any layout.
 */
export const pluginThreadTypeLayout = (type: {
  readonly plugin: string;
  readonly view: string;
  readonly title: string;
  readonly chat: "side" | "hidden";
}): ThreadPaneLayout => {
  const tab: ThreadPaneTab = {
    kind: "plugin",
    plugin: type.plugin,
    pane: type.view,
    title: type.title,
  };
  return type.chat === "hidden"
    ? {
        version: 1,
        root: {
          kind: "pane",
          id: "p0",
          tabs: [tab, { kind: "agent" }],
          active: 0,
        },
        focused: "p0",
        nextPane: 1,
        nextTerminal: 1,
      }
    : {
        version: 1,
        root: {
          kind: "split",
          id: "s0",
          direction: "row",
          children: [
            { kind: "pane", id: "p0", tabs: [tab], active: 0 },
            { kind: "pane", id: "p1", tabs: [{ kind: "agent" }], active: 0 },
          ],
          sizes: [0.64, 0.36],
        },
        focused: "p1",
        nextPane: 2,
        nextTerminal: 1,
      };
};

/**
 * The first layout of a Thread with a plugin type its plugin still offers;
 * the plugin UI request it reads is the one the page makes anyway. Any
 * failure leaves the default layout.
 */
export const firstThreadTypeLayout = async (
  client: QueryClient,
  threadId: ThreadId,
) => {
  try {
    const type = (await client.ensureQueryData(pluginUiQueryOptions(threadId)))
      .threadType;
    return type?.available === true &&
      type.view !== undefined &&
      type.chat !== undefined
      ? pluginThreadTypeLayout({
          plugin: type.plugin,
          view: type.view,
          title: type.title,
          chat: type.chat,
        })
      : undefined;
  } catch {
    return undefined;
  }
};
