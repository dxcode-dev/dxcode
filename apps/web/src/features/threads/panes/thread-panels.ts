import type { ComponentType, SVGProps } from "react";
import type { CommandId } from "../../../shared/commands/command-registry.js";

/**
 * The Thread panel slot: a view that opens as a tab beside the Agent, such
 * as Files or Changes. dx's own panels register here
 * (`dx-thread-panels.ts`), and the Views menu, the tab strips, and the
 * phone's view row list whatever is registered, in order. A Thread's
 * plugins add theirs as `plugin` tabs, which their own menu items open.
 */
export interface ThreadPanelRegistration<Id extends string = string> {
  readonly id: Id;
  /** The tab's and the menu item's name. */
  readonly label: string;
  readonly Icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** The command that opens it, whose shortcut the Views menu shows. */
  readonly command?: CommandId;
}

export interface ThreadPanelRegistry<Id extends string = string> {
  /** Every panel, in the order menus list them. */
  readonly panels: ReadonlyArray<ThreadPanelRegistration<Id>>;
  readonly ids: ReadonlyArray<Id>;
  readonly get: (id: Id) => ThreadPanelRegistration<Id>;
}

export const createThreadPanelRegistry = <Id extends string>(
  panels: ReadonlyArray<ThreadPanelRegistration<Id>>,
): ThreadPanelRegistry<Id> => {
  return {
    panels,
    ids: panels.map(({ id }) => id),
    // Ids are the layout's own kinds, so every one is registered.
    get: (id) =>
      panels.find((panel) => panel.id === id) as ThreadPanelRegistration<Id>,
  };
};
