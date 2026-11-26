import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { Puzzle } from "lucide-react";
import { DxLoading } from "../../shared/brand/dx-loading.js";
import { PageShell } from "../../shared/layout/page-shell.js";
import { EmptyState } from "../../shared/ui/empty-state.js";
import { PluginIcon } from "../../shared/ui/plugin-icon.js";
import { LazyDataView } from "./lazy-data-view.js";
import { PluginAppPage } from "./plugin-app-page.js";
import { pluginViewsCatalogQueryOptions } from "./plugin-views-queries.js";
import "./plugin-page.css";

/**
 * A plugin's full page outside any Thread, at `/plugins/<name>/<id>`: a
 * view described as data whose `show` lists `page`.
 */

/** The person's view described as data at this address, when there is one. */
const useDataViewPage = (plugin: string, page: string) =>
  useQuery({
    ...pluginViewsCatalogQueryOptions(),
    select: (data) =>
      data.dataViews?.find(
        (entry) =>
          entry.plugin === plugin &&
          entry.view === page &&
          entry.show.includes("page"),
      ),
  });

export function PluginPageRoute(props: {
  readonly plugin: string;
  readonly page: string;
}) {
  const dataView = useDataViewPage(props.plugin, props.page);
  if (dataView.isPending)
    return <DxLoading label="Loading page…" variant="pane" />;
  const entry = dataView.data;
  if (entry === undefined)
    return (
      <PageShell title={props.page} contentClassName="plugin-page-content">
        <EmptyState
          className="plugin-page-empty"
          icon={<Puzzle />}
          title="This page is not available"
          description="Its plugin may be off or removed, or no longer shows this page."
          role="status"
        />
      </PageShell>
    );
  return (
    <PageShell
      title={
        <span className="plugin-page-title">
          <PluginIcon
            name={entry.pluginTitle}
            {...(entry.icon === undefined ? {} : { item: entry.icon })}
            size={16}
          />
          <strong>{entry.title}</strong>
          {entry.pluginTitle === entry.title ? null : (
            <small>{entry.pluginTitle}</small>
          )}
        </span>
      }
      contentClassName="plugin-page-content plugin-data-page"
    >
      <LazyDataView
        address={{
          source: { kind: "page" },
          plugin: entry.plugin,
          view: entry.view,
          installId: entry.installId,
          integrity: entry.integrity,
        }}
      />
    </PageShell>
  );
}

/** The router's component: reads the plugin and page from the URL. */
export function PluginPageFromUrl() {
  const params = useParams({ strict: false }) as {
    readonly name?: string;
    readonly id?: string;
  };
  // `app` is a plugin's own web app; a view may not take that id.
  if (params.id === "app")
    return <PluginAppPage key={params.name} plugin={params.name ?? ""} />;
  return (
    <PluginPageRoute
      key={`${params.name}/${params.id}`}
      plugin={params.name ?? ""}
      page={params.id ?? ""}
    />
  );
}
