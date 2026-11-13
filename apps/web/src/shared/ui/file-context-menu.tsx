import { Download, FileText } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { downloadFromUrl } from "../download-from-url.js";
import {
  ContextMenuRoot,
  ContextMenuTrigger,
  MenuItem,
  MenuPopup,
} from "./menu.js";

/**
 * Right-click menu for a file reference: "Open file" and, when the file can
 * be fetched, "Download file". `trigger` is the element that receives the
 * right-click and keeps its own left-click behavior.
 */
export function FileContextMenu({
  trigger,
  children,
  onOpen,
  downloadUrl,
}: {
  readonly trigger: ReactElement;
  readonly children: ReactNode;
  readonly onOpen: () => void;
  readonly downloadUrl?: string;
}) {
  return (
    <ContextMenuRoot>
      <ContextMenuTrigger render={trigger}>{children}</ContextMenuTrigger>
      <MenuPopup sideOffset={0}>
        <MenuItem onClick={onOpen}>
          <FileText />
          <span>Open file</span>
        </MenuItem>
        {downloadUrl === undefined ? null : (
          <MenuItem onClick={() => downloadFromUrl(downloadUrl)}>
            <Download />
            <span>Download file</span>
          </MenuItem>
        )}
      </MenuPopup>
    </ContextMenuRoot>
  );
}
