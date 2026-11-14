import type { PluginThreadTypeOption } from "@dx/api";
import type { ThreadVisibility } from "@dx/domain";
import { EllipsisVertical, PanelsTopLeft, Users } from "lucide-react";
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

/** The value the Thread type menu gives a plain chat. */
const CHAT = "chat";

/**
 * The new-Thread composer's options: who can see the Thread from its start,
 * and which Thread type it starts as. Workspace shares it as View, as
 * the Share dialog does, in the same request that creates it. A plugin
 * Thread type gives the Thread a main area its plugin draws; it never
 * changes once the Thread exists.
 */
export function NewThreadOptionsMenu({
  visibility,
  locked,
  onVisibilityChange,
  threadTypes = [],
  threadType,
  onThreadTypeChange,
}: {
  readonly visibility: ThreadVisibility;
  readonly locked: boolean;
  /** Absent outside a workspace. */
  readonly onVisibilityChange?:
    | ((visibility: ThreadVisibility) => void)
    | undefined;
  readonly threadTypes?: ReadonlyArray<PluginThreadTypeOption>;
  readonly threadType?: string | undefined;
  readonly onThreadTypeChange?:
    | ((type: string | undefined) => void)
    | undefined;
}) {
  // Nothing to offer: outside a workspace, with no Thread types to pick.
  if (
    onVisibilityChange === undefined &&
    (threadTypes.length === 0 || onThreadTypeChange === undefined)
  )
    return null;
  const shared = visibility === "workspace";
  const chosenType = threadTypes.find(({ ref }) => ref === threadType);
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
            {...(chosenType === undefined
              ? {}
              : { "data-thread-type": chosenType.ref })}
            aria-label={
              chosenType !== undefined
                ? `Create Thread options: ${chosenType.title}`
                : shared
                  ? "Create Thread options: visible to the workspace"
                  : "Create Thread options"
            }
            title={
              chosenType !== undefined
                ? `${chosenType.title} · ${chosenType.pluginTitle}`
                : shared
                  ? "Visible to the workspace"
                  : "Options"
            }
          />
        }
      >
        {chosenType !== undefined ? (
          <PanelsTopLeft aria-hidden="true" />
        ) : shared ? (
          <Users aria-hidden="true" />
        ) : (
          <EllipsisVertical aria-hidden="true" />
        )}
      </MenuTrigger>
      <MenuPopup align="start" aria-label="Create Thread options">
        {onThreadTypeChange === undefined || threadTypes.length === 0 ? null : (
          <MenuSubmenuRoot>
            <MenuSubmenuTrigger>
              <span>Thread type</span>
              <MenuItemHint>{chosenType?.title ?? "Chat"}</MenuItemHint>
            </MenuSubmenuTrigger>
            <MenuPopup alignOffset={-4} aria-label="Thread type">
              <MenuRadioGroup
                value={chosenType?.ref ?? CHAT}
                onValueChange={(next) =>
                  onThreadTypeChange(
                    next === CHAT ? undefined : (next as string),
                  )
                }
              >
                <MenuRadioItem value={CHAT}>
                  <MenuItemText
                    title="Chat"
                    description="A Thread with its chat in the main area"
                  />
                </MenuRadioItem>
                {threadTypes.map((type) => (
                  <MenuRadioItem key={type.ref} value={type.ref}>
                    <MenuItemText
                      title={type.title}
                      description={`${type.pluginTitle} · chat ${type.chat === "side" ? "beside it" : "behind a tab"}`}
                    />
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuPopup>
          </MenuSubmenuRoot>
        )}
        {onVisibilityChange === undefined ? null : (
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
        )}
      </MenuPopup>
    </MenuRoot>
  );
}
