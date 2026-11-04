import { Menu } from "@base-ui/react/menu";
import type { ThreadDetailData } from "@dx/api";
import * as React from "react";
import { useOrbRestartEnabled } from "./orb-restart-queries.js";
import type { RestartOrbControlProps } from "./restart-orb-actions.js";

const RestartOrbControl = React.lazy(() => import("./restart-orb-loader.js"));

/**
 * Restart Orb (#1592) is an experimental feature: its controls load only for
 * people who turned it on, and only where it is offered, in the open menu or
 * on an error card. For everyone else nothing of it loads.
 */
export function RestartOrb(props: RestartOrbControlProps) {
  return useOrbRestartEnabled() ? (
    <React.Suspense fallback={null}>
      <RestartOrbControl {...props} />
    </React.Suspense>
  ) : null;
}

/**
 * Restart Orb in the Thread's menu: `item` goes in it and `dialog` beside
 * it. The menu mounts its items only while open, so the flag is read then.
 */
export const useRestartOrbMenu = (thread: ThreadDetailData) => {
  const [restarting, setRestarting] = React.useState(false);
  return {
    item: (
      <RestartOrb
        part="menu-item"
        thread={thread}
        Item={Menu.Item}
        onSelect={() => setRestarting(true)}
      />
    ),
    dialog: restarting ? (
      <RestartOrb
        part="dialog"
        threadId={thread.id}
        onClose={() => setRestarting(false)}
      />
    ) : null,
  };
};
