import { Menu } from "@base-ui/react/menu";
import type { ThreadVisibility } from "@dx/domain";
import { Check, ChevronRight, EllipsisVertical, Users } from "lucide-react";
import { Button } from "../../shared/ui/button.js";
import { MenuItemText } from "../../shared/ui/menu-item-text.js";

const VISIBILITY_COPY = {
  private: { label: "Private", detail: "Only you can see this Thread" },
  workspace: {
    label: "Workspace",
    detail: "Visible to all members of the workspace",
  },
} as const satisfies Record<
  ThreadVisibility,
  { readonly label: string; readonly detail: string }
>;

/**
 * The new-Thread composer's options: who can see the Thread from its start.
 * Workspace shares it as View, as the Share dialog does, in the same request
 * that creates it.
 */
export function NewThreadOptionsMenu({
  visibility,
  locked,
  onVisibilityChange,
}: {
  readonly visibility: ThreadVisibility;
  readonly locked: boolean;
  readonly onVisibilityChange: (visibility: ThreadVisibility) => void;
}) {
  const shared = visibility === "workspace";
  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={locked}
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="new-thread-options"
            data-visibility={visibility}
            aria-label={
              shared
                ? "Create Thread options: visible to the workspace"
                : "Create Thread options"
            }
            title={shared ? "Visible to the workspace" : "Options"}
          />
        }
      >
        {shared ? (
          <Users aria-hidden="true" />
        ) : (
          <EllipsisVertical aria-hidden="true" />
        )}
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="thread-menu-positioner"
          align="start"
          sideOffset={4}
        >
          <Menu.Popup
            className="thread-menu-popup thread-actions-menu"
            aria-label="Create Thread options"
          >
            <Menu.SubmenuRoot>
              <Menu.SubmenuTrigger className="thread-menu-item new-thread-options-row">
                <span>Visibility</span>
                <span className="new-thread-options-value">
                  {VISIBILITY_COPY[visibility].label}
                </span>
                <ChevronRight aria-hidden="true" />
              </Menu.SubmenuTrigger>
              <Menu.Portal>
                <Menu.Positioner
                  className="thread-menu-positioner"
                  sideOffset={4}
                  alignOffset={-4}
                >
                  <Menu.Popup
                    className="thread-menu-popup thread-actions-menu thread-actions-submenu"
                    aria-label="Visibility"
                  >
                    <Menu.RadioGroup
                      value={visibility}
                      onValueChange={(next) =>
                        onVisibilityChange(next as ThreadVisibility)
                      }
                    >
                      {(["private", "workspace"] as const).map((option) => (
                        <Menu.RadioItem
                          key={option}
                          value={option}
                          className="thread-menu-item mcp-menu-radio"
                        >
                          <Menu.RadioItemIndicator className="mcp-menu-indicator">
                            <Check />
                          </Menu.RadioItemIndicator>
                          <MenuItemText
                            title={VISIBILITY_COPY[option].label}
                            description={VISIBILITY_COPY[option].detail}
                          />
                        </Menu.RadioItem>
                      ))}
                    </Menu.RadioGroup>
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.SubmenuRoot>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
