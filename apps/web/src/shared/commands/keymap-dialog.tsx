import { useLocation, useNavigate } from "@tanstack/react-router";
import { Pencil } from "lucide-react";
import { settingsNavigationState } from "../navigation/settings-return.js";
import { CommandSurfaceDialog } from "../ui/command-surface-dialog.js";
import {
  type CommandId,
  type CommandView,
  keymapCategories,
  keymapCategoryFor,
} from "./command-registry.js";
import { ShortcutBindings } from "./shortcut-keycaps.js";

export function KeymapDialog({
  open,
  onOpenChange,
  commands,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly commands: ReadonlyArray<CommandView<CommandId>>;
}) {
  const navigate = useNavigate();
  const returnTo = useLocation({ select: (location) => location.href });
  const visible = commands.filter(
    (command) => command.available && command.displayedBindings.length > 0,
  );

  return (
    <CommandSurfaceDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Keymap"
      description="Keyboard shortcuts available on this page."
      rightHeaderAction={
        <button
          type="button"
          className="keymap-edit-link"
          onClick={() => {
            onOpenChange(false);
            void navigate({
              to: "/settings/$section",
              params: { section: "keyboard-shortcuts" },
              state: settingsNavigationState(returnTo),
            });
          }}
        >
          <Pencil aria-hidden="true" /> Edit Keyboard Shortcuts
        </button>
      }
      primary={null}
      variant="keymap"
    >
      <div className="keymap-grid" data-testid="keymap-grid">
        {keymapCategories.map((category) => {
          const entries = visible.filter(
            (command) => keymapCategoryFor(command) === category,
          );
          if (entries.length === 0) return null;
          return (
            <section className="keymap-category-column" key={category}>
              <h3 className="keymap-category">{category}</h3>
              {entries.map((command) => (
                <div className="keymap-entry-wrap" key={command.id}>
                  <div className="keymap-entry">
                    <span className="keymap-label">{command.label}</span>
                    <ShortcutBindings
                      bindings={command.displayedBindings}
                      sequence={command.sequence !== undefined}
                    />
                  </div>
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </CommandSurfaceDialog>
  );
}
