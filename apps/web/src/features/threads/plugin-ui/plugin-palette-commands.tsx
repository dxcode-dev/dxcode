import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "@tanstack/react-router";
import { pluginUiQueryOptions } from "../thread-queries.js";
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
  return threadId === undefined ? null : (
    <ThreadPluginCommands threadId={threadId as ThreadId} {...props} />
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
      <span>
        <strong>{command.title}</strong> <small>{command.plugin}</small>
      </span>
    </button>
  ));
}
