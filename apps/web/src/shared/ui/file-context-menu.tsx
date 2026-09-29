import { ContextMenu } from "@base-ui/react/context-menu";
import { Download, FileText } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

/** Start a same-origin download without navigating away from dx. */
export const downloadFromUrl = (url: string) => {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
};

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
    <ContextMenu.Root>
      <ContextMenu.Trigger render={trigger}>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner className="thread-context-positioner">
          <ContextMenu.Popup className="thread-context-menu">
            <ContextMenu.Item className="thread-context-item" onClick={onOpen}>
              <FileText /> Open file
            </ContextMenu.Item>
            {downloadUrl === undefined ? null : (
              <ContextMenu.Item
                className="thread-context-item"
                onClick={() => downloadFromUrl(downloadUrl)}
              >
                <Download /> Download file
              </ContextMenu.Item>
            )}
          </ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
