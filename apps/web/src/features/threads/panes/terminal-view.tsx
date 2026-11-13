import type { ThreadTerminalId } from "@dx/api";
import { Ellipsis, RefreshCw } from "lucide-react";
import {
  TerminalSessionContext,
  terminalEnvironmentFormId,
} from "../../../shared/terminal-session.js";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../../shared/ui/menu.js";

/** The Terminal with a floating `⋯` of Terminal actions at its top right. */
export function TerminalView({
  session,
  children,
}: {
  readonly session: ThreadTerminalId;
  readonly children: React.ReactNode;
}) {
  return (
    <TerminalSessionContext value={session}>
      <div className="pane-terminal-view">
        {children}
        <MenuRoot>
          <MenuTrigger
            className="pane-terminal-actions"
            aria-label="Terminal Actions"
            title="Terminal Actions"
          >
            <Ellipsis aria-hidden="true" />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              nativeButton
              render={
                <button
                  type="submit"
                  form={terminalEnvironmentFormId(session)}
                />
              }
            >
              <RefreshCw aria-hidden="true" />
              <span>Refresh Environment</span>
            </MenuItem>
          </MenuPopup>
        </MenuRoot>
      </div>
    </TerminalSessionContext>
  );
}
