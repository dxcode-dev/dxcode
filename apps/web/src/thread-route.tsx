import { DesktopViewer } from "./features/desktop/desktop-viewer.js";
import { ThreadTerminal } from "./features/terminal/thread-terminal.js";
import { ThreadWorkspace } from "./features/threads/thread-workspace.js";

export const ThreadRoute = () => (
  <ThreadWorkspace Terminal={ThreadTerminal} Desktop={DesktopViewer} />
);
