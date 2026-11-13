import type { ThreadVisibility } from "@dx/domain";
import { EllipsisVertical, Users } from "lucide-react";
import { Button } from "../../shared/ui/button.js";
import {
  MenuItemHint,
  MenuItemText,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRoot,
  MenuSubmenuRoot,
  MenuSubmenuTrigger,
  MenuTrigger,
} from "../../shared/ui/menu.js";

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
    <MenuRoot>
      <MenuTrigger
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
      </MenuTrigger>
      <MenuPopup align="start" aria-label="Create Thread options">
        <MenuSubmenuRoot>
          <MenuSubmenuTrigger>
            <span>Visibility</span>
            <MenuItemHint>{VISIBILITY_COPY[visibility].label}</MenuItemHint>
          </MenuSubmenuTrigger>
          <MenuPopup alignOffset={-4} aria-label="Visibility">
            <MenuRadioGroup
              value={visibility}
              onValueChange={(next) =>
                onVisibilityChange(next as ThreadVisibility)
              }
            >
              {(["private", "workspace"] as const).map((option) => (
                <MenuRadioItem key={option} value={option}>
                  <MenuItemText
                    title={VISIBILITY_COPY[option].label}
                    description={VISIBILITY_COPY[option].detail}
                  />
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuPopup>
        </MenuSubmenuRoot>
      </MenuPopup>
    </MenuRoot>
  );
}
