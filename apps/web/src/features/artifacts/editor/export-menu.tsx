import { Download, X } from "lucide-react";
import * as React from "react";
import { Button } from "../../../shared/ui/button.js";
import { buttonVariants } from "../../../shared/ui/button-variants.js";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../../shared/ui/menu.js";
import { cn } from "../../../shared/utils.js";
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
      <MenuRoot>
        <MenuTrigger
          className={cn(
            buttonVariants({ variant: "subtle", size: "icon-xs" }),
            "artifact-icon-button",
          )}
          aria-label="Export"
          title="Export"
        >
          <Download aria-hidden="true" />
        </MenuTrigger>
        <MenuPopup side="bottom" align="end" aria-label="Export">
          <MenuItem
            onClick={() =>
              void save(() => markdownFile(title, session.markdown()))
            }
          >
            Download Markdown
          </MenuItem>
          <MenuItem onClick={() => void save(() => htmlFile(title, doc()))}>
            Download HTML
          </MenuItem>
          <MenuItem
            onClick={() =>
              sharesFiles()
                ? void save(() => pdfFile(title, doc()))
                : printArtifact(title, doc())
            }
          >
            Print or Save as PDF
          </MenuItem>
        </MenuPopup>
      </MenuRoot>
      {ready === undefined && !failed ? null : (
        <div className="artifact-export-ready" role="status">
          <span>
            {failed
              ? "Couldn't make the file. Try again."
              : `${ready?.name} is ready.`}
          </span>
          {ready === undefined ? null : (
            <Button variant="outline" onClick={() => void save(() => ready)}>
              Save {ready.name}
            </Button>
          )}
          <Button
            variant="outline"
            size="icon"
            aria-label="Dismiss"
            onClick={() => {
              setReady(undefined);
              setFailed(false);
            }}
          >
            <X aria-hidden="true" />
          </Button>
        </div>
      )}
    </>
  );
}
