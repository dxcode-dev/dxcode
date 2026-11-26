import type { PluginDataViewStateData } from "@dx/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import type { DataViewSlotProps } from "../../../shared/realtime/live.js";
import { ViewLiveContext } from "../../../shared/realtime/live.js";
import { ConfirmDialog } from "../../../shared/ui/confirm-dialog.js";
import { EmptyState } from "../../../shared/ui/empty-state.js";
import { useDataViewActions } from "./data-view-actions.js";
import { DataViewParts } from "./data-view-parts.js";
import {
  type DataViewAddress,
  dataViewDefinitionQueryOptions,
  dataViewStateQueryOptions,
  liveStateApplier,
} from "./data-view-queries.js";
import { watchView } from "./view-watches.js";
import "./data-view.css";

/**
 * A plugin's view described as data, drawn with dx's own parts: on a page
 * of its own, in a Thread panel, as a card in a message, or as a Thread's
 * main area. Loaded on first use, so no place pays for it until a view
 * shows. Its state stays live: changes arrive on the realtime connection
 * and redraw at most once per animation frame.
 */

export type DataViewProps = DataViewSlotProps;

const noSnapshot = () => undefined;

/** Hears the view's changes while it shows, with the state's watch token. */
const useLiveState = (
  address: DataViewAddress,
  data: PluginDataViewStateData | undefined,
) => {
  const hub = React.use(ViewLiveContext);
  const queryClient = useQueryClient();
  const token = data?.watch;
  const key = data?.key;
  const subscribe = () => {
    if (hub === undefined || token === undefined || key === undefined)
      return () => undefined;
    const applier = liveStateApplier(queryClient, address);
    const stop = watchView(hub, token, key, (event) => {
      if (event.kind === "stale") applier.stale();
      else applier.change(event);
    });
    return () => {
      stop();
      applier.stop();
    };
  };
  React.useSyncExternalStore(subscribe, noSnapshot, noSnapshot);
};

export function PluginDataView({
  address,
  disabledReason,
  showTitle = false,
  className,
}: DataViewProps) {
  const definition = useQuery(dataViewDefinitionQueryOptions(address));
  const stateQuery = useQuery(dataViewStateQueryOptions(address));
  useLiveState(address, stateQuery.data);
  const actions = useDataViewActions(address, disabledReason);
  if (definition.isError || stateQuery.isError)
    return (
      <EmptyState
        tone="error"
        role="alert"
        title="This view could not load"
        description="Its plugin may be off or removed."
      />
    );
  if (definition.data === undefined || stateQuery.data === undefined)
    return <EmptyState busy title="Loading…" />;
  const view = definition.data;
  // Before the plugin first sets state, the view draws its file's own.
  const state =
    stateQuery.data.version === 0 ? (view.state ?? {}) : stateQuery.data.state;
  return (
    <div className={`data-view ${className ?? ""}`}>
      {showTitle ? (
        <header className="data-view-header">
          <h2 className="data-view-title">{view.title}</h2>
          {view.description === undefined ? null : (
            <p className="data-view-text" data-tone="muted">
              {view.description}
            </p>
          )}
        </header>
      ) : null}
      <div className="data-view-parts">
        <DataViewParts
          parts={view.parts}
          path="parts"
          context={{
            state,
            run: actions.run,
            busy: actions.busy,
            disabledReason,
          }}
        />
      </div>
      {actions.confirm === undefined ? null : (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) actions.clearConfirm();
          }}
          title={actions.confirm.title}
          {...(actions.confirm.description === undefined
            ? {}
            : { description: actions.confirm.description })}
          confirmLabel={actions.confirm.confirmLabel}
          onConfirm={() => {
            const pending = actions.confirm;
            actions.clearConfirm();
            void pending?.run();
          }}
        />
      )}
    </div>
  );
}

/** The router loads the renderer lazily, by its default export. */
export default PluginDataView;
