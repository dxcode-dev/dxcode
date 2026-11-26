import * as React from "react";
import { lazyComponent } from "../../shared/stale-chunk.js";
import { EmptyState } from "../../shared/ui/empty-state.js";
import type { DataViewProps } from "./data-view/data-view.js";

const LoadedDataView = lazyComponent(() =>
  import("./data-view/data-view.js").then((module) => ({
    default: module.PluginDataView,
  })),
);

/**
 * A plugin's view described as data, loaded the first time one shows, so
 * the pages and panels that may hold one pay nothing until then.
 */
export function LazyDataView(props: DataViewProps) {
  return (
    <React.Suspense fallback={<EmptyState busy title="Loading…" />}>
      <LoadedDataView {...props} />
    </React.Suspense>
  );
}
