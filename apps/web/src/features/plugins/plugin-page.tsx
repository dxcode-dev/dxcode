import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { Puzzle } from "lucide-react";
import * as React from "react";
import { DxLoading } from "../../shared/brand/dx-loading.js";
import { PageShell } from "../../shared/layout/page-shell.js";
import type { PluginPaneFrameProps } from "../../shared/ui/markdown-view-frame.js";
import { PluginIcon } from "../../shared/ui/plugin-icon.js";
import {
  pluginPageMessageMutationOptions,
  pluginPageViewQueryOptions,
} from "./plugin-views-queries.js";
// The pane frame's sizing rules, shared with Thread panes.
import "../threads/plugin-ui/plugin-ui.css";
import "./plugin-page.css";

/**
 * A plugin's full page outside any Thread, at
 * `/plugins/<name>/<id><path>`, for dashboards and editors. Its view runs in
 * the same sandboxed frame a pane does; it learns its sub-path from the first
 * `dx/plugin.message` it hears, `{ type: "dx.page", path }`.
 */

const PaneFrame = React.lazy<React.ComponentType<PluginPaneFrameProps>>(() =>
  import("../../shared/ui/markdown-view-frame.js").then(
    (module) => ({ default: module.PluginPaneFrame }),
    () => ({
      default: () => (
        <p className="plugin-pane-state" role="alert">
          This page could not load.
        </p>
      ),
    }),
  ),
);

function PluginPageBody({
  plugin,
  page,
  path,
}: {
  readonly plugin: string;
  readonly page: string;
  readonly path: string;
}) {
  const view = useQuery(pluginPageViewQueryOptions(plugin, page));
  const post = useMutation(pluginPageMessageMutationOptions(plugin, page));
  if (view.data === undefined && view.isError)
    return (
      <div className="empty-state plugin-page-empty" role="status">
        <Puzzle aria-hidden="true" />
        <strong>This page is not available</strong>
        <span>
          Its plugin may be off or removed, or it is not trusted to show full
          pages.
        </span>
      </div>
    );
  if (view.data === undefined)
    return <DxLoading label="Loading page…" variant="pane" />;
  const data = view.data;
  // The page's sub-path reaches the view as its first message.
  const subscribeMessages: PluginPaneFrameProps["subscribeMessages"] = (
    listener,
  ) => {
    listener([{ seq: 1, message: { type: "dx.page", path } }]);
    return () => undefined;
  };
  return (
    <React.Suspense fallback={<div className="plugin-pane-state" />}>
      <PaneFrame
        key={`${data.version}:${path}`}
        html={data.html}
        title={data.title}
        subscribeMessages={subscribeMessages}
        {...(data.handlesMessages ? { onPost: post.mutateAsync } : {})}
      />
    </React.Suspense>
  );
}

export function PluginPageRoute({
  plugin,
  page,
  path,
}: {
  readonly plugin: string;
  readonly page: string;
  /** The sub-path after the page id, `/` when none. */
  readonly path: string;
}) {
  const view = useQuery(pluginPageViewQueryOptions(plugin, page));
  const title = view.data?.title ?? page;
  return (
    <PageShell
      title={
        <span className="plugin-page-title">
          <PluginIcon
            name={view.data?.pluginTitle ?? plugin}
            {...(view.data?.icon === undefined ? {} : { item: view.data.icon })}
            size={16}
          />
          <strong>{title}</strong>
          {view.data === undefined ? null : (
            <small>{view.data.pluginTitle}</small>
          )}
        </span>
      }
      contentClassName="plugin-page-content"
    >
      <div className="plugin-pane plugin-page-view">
        <PluginPageBody plugin={plugin} page={page} path={path} />
      </div>
    </PageShell>
  );
}

/** The router's component: reads the plugin, page, and sub-path from the URL. */
export function PluginPageFromUrl() {
  const params = useParams({ strict: false }) as {
    readonly name?: string;
    readonly id?: string;
    readonly _splat?: string;
  };
  return (
    <PluginPageRoute
      key={`${params.name}/${params.id}`}
      plugin={params.name ?? ""}
      page={params.id ?? ""}
      path={`/${params._splat ?? ""}`}
    />
  );
}
