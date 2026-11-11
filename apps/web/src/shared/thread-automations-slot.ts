import type { ThreadId } from "@dx/domain";
import type * as React from "react";

/** One of a Thread's automation lists, as its title bar names them. */
export type ThreadAutomationView = "issues" | "pulls" | "ci" | "listeners";

/**
 * A Thread title bar's issues, pull requests, CI, and schedule and GitHub
 * listeners, for a surface outside the Thread page, such as a Space. The
 * Thread route hands it over, so a Space shows them as a Thread does
 * without reaching into the Thread page's code.
 */
export interface ThreadAutomationsSlot {
  /** The chips, each opening its list; nothing when the Thread has none. */
  readonly Chips: React.ComponentType<{ readonly threadId: ThreadId }>;
  /** Their entries in a Base UI menu, for a bar with no room for chips. */
  readonly MenuItems: React.ComponentType<{
    readonly threadId: ThreadId;
    readonly onOpen: (view: ThreadAutomationView) => void;
  }>;
  /** One list as a sheet, which an entry opens. */
  readonly Sheet: React.ComponentType<{
    readonly threadId: ThreadId;
    readonly view: ThreadAutomationView;
    readonly onClose: () => void;
  }>;
}
