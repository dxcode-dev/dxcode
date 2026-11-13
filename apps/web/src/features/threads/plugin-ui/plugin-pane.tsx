import type { ThreadId } from "@dx/domain";
import {
  QueryObserver,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Lock } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { DxLoading } from "../../../shared/brand/dx-loading.js";
import type { PluginPaneFrameProps } from "../../../shared/ui/markdown-view-frame.js";
import type { PluginPaneTab } from "../panes/pane-layout.js";
import type { PluginPaneMenuProps } from "../panes/pane-views.js";
import { pluginUiQueryOptions, threadQueryOptions } from "../thread-queries.js";
import {
  pluginPaneMessageMutationOptions,
  pluginPaneMessagesQueryOptions,
  pluginPaneViewQueryOptions,
} from "./plugin-pane-queries.js";
import "./plugin-ui.css";

/**
 * An installed plugin's pane in a Thread tab: its view, framed as an MCP
 * Apps card is, and the plugin's posts, which realtime's
 * `plugin-pane.invalidated` refetches. Loads when its tab is first shown,
 * and the Views menu's pane items when the menu first opens.
 */

const PaneFrame = React.lazy<React.ComponentType<PluginPaneFrameProps>>(() =>
  import("../../../shared/ui/markdown-view-frame.js").then(
    (module) => ({ default: module.PluginPaneFrame }),
    () => ({
      default: () => (
        <p className="plugin-pane-state" role="alert">
          This pane could not load.
        </p>
      ),
    }),
  ),
);

function PluginPaneBody({
  threadId,
  tab,
  canPost,
}: {
  readonly threadId: ThreadId;
  readonly tab: PluginPaneTab;
  readonly canPost: boolean;
}) {
  const client = useQueryClient();
  const view = useQuery(
    pluginPaneViewQueryOptions(threadId, tab.plugin, tab.pane),
  );
  const post = useMutation(
    pluginPaneMessageMutationOptions(threadId, tab.plugin, tab.pane),
  );
  // The Thread owner's personal plugin: a member sees it, without controls.
  const { identity } = useAuthenticatedIdentity();
  const ownerOnly =
    useQuery({
      ...pluginUiQueryOptions(threadId),
      select: (data) =>
        data.panes?.find(
          (entry) => entry.plugin === tab.plugin && entry.pane === tab.pane,
        )?.ownerOnly === true,
    }).data === true;
  const ownerName = useQuery({
    ...threadQueryOptions(identity.id, threadId),
    enabled: false,
    select: (thread) =>
      thread.participants?.find(({ owner }) => owner)?.name ?? "the owner",
  }).data;
  // A failed refetch keeps the pane it already shows.
  if (view.data === undefined && view.isError)
    return (
      <p className="plugin-pane-state" role="status">
        {tab.title} is not available in this Thread. Its plugin may be off or
        removed.
      </p>
    );
  if (view.data === undefined)
    return <DxLoading label={`Loading ${tab.title}…`} variant="pane" />;
  const subscribeMessages: PluginPaneFrameProps["subscribeMessages"] = (
    listener,
  ) => {
    const observer = new QueryObserver(
      client,
      pluginPaneMessagesQueryOptions(threadId, tab.plugin, tab.pane),
    );
    const unsubscribe = observer.subscribe((result) => {
      if (result.data !== undefined) listener(result.data);
    });
    const current = observer.getCurrentResult().data;
    if (current !== undefined) listener(current);
    return unsubscribe;
  };
  const frame = (
    <React.Suspense fallback={<div className="plugin-pane-state" />}>
      <PaneFrame
        html={view.data.html}
        title={tab.title}
        subscribeMessages={subscribeMessages}
        {...(canPost && !ownerOnly ? { onPost: post.mutateAsync } : {})}
      />
    </React.Suspense>
  );
  if (!ownerOnly) return frame;
  return (
    <div className="plugin-pane-archived" data-owner-only="">
      <p className="plugin-pane-read-only" role="status">
        <Lock aria-hidden="true" />
        Only {ownerName ?? "the owner"} can use this plugin here.
      </p>
      <div className="plugin-pane-archived-frame" inert>
        {frame}
      </div>
    </div>
  );
}

/** A plugin's pane; nothing loads until its tab is first shown. */
export function PluginPane({
  threadId,
  tab,
  active,
  canPost,
}: {
  readonly threadId: ThreadId;
  readonly tab: PluginPaneTab;
  readonly active: boolean;
  /** People who can only view the Thread see the pane but cannot post. */
  readonly canPost: boolean;
}) {
  const [shown, setShown] = React.useState(active);
  if (active && !shown) setShown(true);
  if (!shown) return null;
  return (
    <div className="plugin-pane">
      <PluginPaneBody threadId={threadId} tab={tab} canPost={canPost} />
    </div>
  );
}

/** The Views menu's items for the panes the Thread's plugins offer. */
export function PluginPaneMenuItems({
  threadId,
  renderItem,
}: PluginPaneMenuProps & { readonly threadId: ThreadId }) {
  const panes = useQuery(pluginUiQueryOptions(threadId)).data?.panes ?? [];
  return <>{panes.map(renderItem)}</>;
}
