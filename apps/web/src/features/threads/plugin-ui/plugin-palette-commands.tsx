import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { PluginIcon } from "../../../shared/ui/plugin-icon.js";
import {
  pluginAppsQueryOptions,
  pluginViewsCatalogQueryOptions,
} from "../../plugins/plugin-views-queries.js";
import { pluginUiQueryOptions } from "../thread-queries.js";
import { iconForItem } from "./plugin-ui-icon-lookup.js";
import { runPluginCommand } from "./plugin-ui-mutations.js";

interface PaletteProps {
  /** The palette's search, trimmed and lowercased. */
  readonly query: string;
  readonly onRun: () => void;
}

/**
 * The open Thread's plugin commands in the command palette, matched like
 * dx's own. Loaded when the palette opens; nothing outside a Thread.
 */
export function PluginPaletteCommands(props: PaletteProps) {
  const threadId = useLocation({
    select: (location) => /^\/threads\/([^/]+)/.exec(location.pathname)?.[1],
  });
  return (
    <>
      {threadId === undefined ? null : (
        <ThreadPluginCommands threadId={threadId as ThreadId} {...props} />
      )}
      <PluginViewCommands {...props} />
    </>
  );
}

/**
 * The person's plugin views shown as pages ("Open …") and Thread types
 * ("New …"), in
 * every palette, from the views catalog.
 */
function PluginViewCommands({ query, onRun }: PaletteProps) {
  const { data } = useQuery(pluginViewsCatalogQueryOptions());
  const apps = useQuery(pluginAppsQueryOptions()).data;
  const navigate = useNavigate();
  const matches = (text: string) =>
    query === "" || text.toLocaleLowerCase().includes(query);
  return (
    <>
      {(data?.dataViews ?? []).flatMap((view) =>
        !view.show.includes("page") ||
        !matches(`open ${view.title} ${view.pluginTitle}`) ? (
          []
        ) : (
          <button
            key={`view:${view.plugin}/${view.view}`}
            type="button"
            className="command-palette-item"
            onClick={() => {
              void navigate({
                to: "/plugins/$name/$id/$",
                params: { name: view.plugin, id: view.view, _splat: "" },
              });
              onRun();
            }}
          >
            <span>
              <strong>Open {view.title}</strong>{" "}
              <small>{view.pluginTitle}</small>
            </span>
          </button>
        ),
      )}
      {(apps ?? []).flatMap((app) =>
        !matches(`open ${app.title} app`) ? (
          []
        ) : (
          <button
            key={`app:${app.plugin}`}
            type="button"
            className="command-palette-item"
            onClick={() => {
              void navigate({
                to: "/plugins/$name/$id/$",
                params: { name: app.plugin, id: "app", _splat: "" },
              });
              onRun();
            }}
          >
            <span>
              <strong>Open {app.title} App</strong>
            </span>
          </button>
        ),
      )}
      {(data?.threadTypes ?? []).flatMap((type) =>
        !matches(`new ${type.title} ${type.pluginTitle}`) ? (
          []
        ) : (
          <button
            key={`type:${type.ref}`}
            type="button"
            className="command-palette-item"
            onClick={() => {
              void navigate({
                to: "/new",
                search: { project: undefined, type: type.ref },
              });
              onRun();
            }}
          >
            <span>
              <strong>New {type.title}</strong>{" "}
              <small>{type.pluginTitle}</small>
            </span>
          </button>
        ),
      )}
    </>
  );
}

function ThreadPluginCommands({
  threadId,
  query,
  onRun,
}: PaletteProps & { readonly threadId: ThreadId }) {
  const { data } = useQuery(pluginUiQueryOptions(threadId));
  const commands = (data?.commands ?? []).filter(
    (command) =>
      query === "" ||
      `${command.title} ${command.description ?? ""} ${command.plugin}`
        .toLocaleLowerCase()
        .includes(query),
  );
  return commands.map((command) => (
    <button
      key={command.id}
      type="button"
      className="command-palette-item"
      onClick={() => {
        void runPluginCommand(threadId, command.id, command.title);
        onRun();
      }}
    >
      <PluginIcon
        name={command.plugin}
        icon={iconForItem(data, command)}
        item={command.icon}
        size={16}
        className="command-palette-plugin-icon"
      />
      <span>
        <strong>{command.title}</strong> <small>{command.plugin}</small>
      </span>
    </button>
  ));
}
