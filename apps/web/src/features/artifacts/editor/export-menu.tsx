import { Menu } from "@base-ui/react/menu";
import { Download, X } from "lucide-react";
import * as React from "react";
import {
  htmlFile,
  markdownFile,
  pdfFile,
  printArtifact,
  saveFile,
  sharesFiles,
} from "./artifact-export.js";
import type { ArtifactSession } from "./artifact-session.js";

/**
 * Export: the Markdown, a standalone HTML page, or print (Save as PDF). In
 * an iPhone's Home Screen app, where print does nothing, Print or Save as
 * PDF makes the PDF here and hands it to the share sheet. When the phone
 * wants a fresh tap to open the sheet (the file took a moment), a bar
 * offers it.
 */
export function ExportMenu({
  session,
  title,
}: {
  readonly session: ArtifactSession;
  readonly title: string;
}) {
  const [ready, setReady] = React.useState<File>();
  const [failed, setFailed] = React.useState(false);
  const save = async (make: () => File | Promise<File>) => {
    setReady(undefined);
    setFailed(false);
    try {
      const file = await make();
      if ((await saveFile(file)) === "again") setReady(file);
    } catch {
      setFailed(true);
    }
  };
  const doc = () => session.state.doc;
  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          className="artifact-icon-button"
          aria-label="Export"
          title="Export"
        >
          <Download aria-hidden="true" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            className="thread-menu-positioner"
            side="bottom"
            align="end"
            sideOffset={4}
          >
            <Menu.Popup className="thread-menu-popup" aria-label="Export">
              <Menu.Item
                className="thread-menu-item"
                onClick={() =>
                  void save(() => markdownFile(title, session.markdown()))
                }
              >
                Download Markdown
              </Menu.Item>
              <Menu.Item
                className="thread-menu-item"
                onClick={() => void save(() => htmlFile(title, doc()))}
              >
                Download HTML
              </Menu.Item>
              <Menu.Item
                className="thread-menu-item"
                onClick={() =>
                  sharesFiles()
                    ? void save(() => pdfFile(title, doc()))
                    : printArtifact(title, doc())
                }
              >
                Print or Save as PDF
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {ready === undefined && !failed ? null : (
        <div className="artifact-export-ready" role="status">
          <span>
            {failed
              ? "Couldn't make the file. Try again."
              : `${ready?.name} is ready.`}
          </span>
          {ready === undefined ? null : (
            <button type="button" onClick={() => void save(() => ready)}>
              Save {ready.name}
            </button>
          )}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => {
              setReady(undefined);
              setFailed(false);
            }}
          >
            <X aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  );
}
