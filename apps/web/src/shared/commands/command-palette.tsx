import * as React from "react";
import { CommandSurfaceDialog } from "../ui/command-surface-dialog.js";
import { Input } from "../ui/input.js";
import type { CommandId, CommandView } from "./command-registry.js";
import { ShortcutKeycaps } from "./shortcut-keycaps.js";

export function CommandPalette({
  open,
  commands,
  onOpenChange,
  onDispatch,
}: {
  readonly open: boolean;
  readonly commands: ReadonlyArray<CommandView>;
  readonly onOpenChange: (open: boolean) => void;
  readonly onDispatch: (id: CommandId) => void;
}) {
  const [query, setQuery] = React.useState("");
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleCommands = commands.filter(
    (command) =>
      command.id !== "command-palette.open" &&
      (normalizedQuery.length === 0 ||
        `${command.label} ${command.description} ${command.category} ${command.contextLabel}`
          .toLocaleLowerCase()
          .includes(normalizedQuery)),
  );
  const changeOpen = (nextOpen: boolean) => {
    if (!nextOpen) setQuery("");
    onOpenChange(nextOpen);
  };

  return (
    <CommandSurfaceDialog
      open={open}
      onOpenChange={changeOpen}
      title="Command Palette"
      description="Search the commands available in this dx build."
      className="command-palette"
      primary={
        <Input
          autoFocus
          type="search"
          value={query}
          aria-label="Search commands"
          placeholder="Search commands"
          onChange={(event) => setQuery(event.target.value)}
        />
      }
    >
      <div className="command-palette-list" aria-live="polite">
        {visibleCommands.length === 0 ? (
          <p className="command-palette-empty">No commands match.</p>
        ) : (
          visibleCommands.map((command) => (
            <button
              key={command.id}
              type="button"
              className="command-palette-item"
              disabled={!command.available}
              onClick={() => {
                onDispatch(command.id);
                changeOpen(false);
              }}
            >
              <span>
                <strong>{command.label}</strong>
              </span>
              {command.displayedKeycaps.length > 0 ? (
                <ShortcutKeycaps keycaps={command.displayedKeycaps} />
              ) : null}
            </button>
          ))
        )}
      </div>
    </CommandSurfaceDialog>
  );
}
