import { Menu } from "@base-ui/react/menu";
import type { ProjectData, ThreadDetailData } from "@dx/api";
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronRight,
  Copy,
  Download,
  Ellipsis,
  X,
} from "lucide-react";
import * as React from "react";
import { useOptionalThreadArchive } from "../../shared/thread-archive.js";
import { absoluteThreadUrl } from "../../shared/thread-url.js";
import { Button } from "../../shared/ui/button.js";
import {
  serializeThreadJson,
  serializeThreadMarkdown,
  threadExportFilename,
} from "./thread-export.js";
import type { TranscriptViewModel } from "./transcript-view-model.js";

function ExportSubmenu({
  onDownload,
}: {
  readonly onDownload: (format: "markdown" | "json") => void;
}) {
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className="thread-menu-item">
        Export
        <ChevronRight />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner className="thread-menu-positioner" sideOffset={2}>
          <Menu.Popup className="thread-menu-popup">
            <Menu.Item
              className="thread-menu-item"
              onClick={() => onDownload("markdown")}
            >
              <Download /> Markdown
            </Menu.Item>
            <Menu.Item
              className="thread-menu-item"
              onClick={() => onDownload("json")}
            >
              <Download /> JSON
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.SubmenuRoot>
  );
}

export function ThreadMenu({
  thread,
  project,
  model,
}: {
  readonly thread: ThreadDetailData;
  readonly project?: Pick<ProjectData, "name">;
  readonly model: TranscriptViewModel;
}) {
  const archive = useOptionalThreadArchive();
  const [announcement, setAnnouncement] = React.useState("");
  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(
        absoluteThreadUrl(thread.id, window.location.href),
      );
      setAnnouncement("Thread URL copied.");
    } catch {
      setAnnouncement("Could not copy the Thread URL.");
    }
  };
  const download = (format: "markdown" | "json") => {
    const markdown = format === "markdown";
    const contents = markdown
      ? serializeThreadMarkdown({ thread, project, model })
      : serializeThreadJson({ thread, project, model });
    const url = URL.createObjectURL(
      new Blob([contents], {
        type: markdown
          ? "text/markdown;charset=utf-8"
          : "application/json;charset=utf-8",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = threadExportFilename(
      thread.title,
      markdown ? "md" : "json",
    );
    anchor.click();
    URL.revokeObjectURL(url);
    setAnnouncement(`${markdown ? "Markdown" : "JSON"} export downloaded.`);
  };
  return (
    <>
      <Menu.Root>
        <Menu.Trigger
          render={
            <Button
              aria-label="Thread actions"
              variant="ghost"
              size="icon-xs"
            />
          }
        >
          <Ellipsis />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            className="thread-menu-positioner"
            align="end"
            sideOffset={4}
          >
            <Menu.Popup className="thread-menu-popup">
              <Menu.Item
                className="thread-menu-item"
                disabled={
                  archive === undefined || archive.pendingThreadId === thread.id
                }
                onClick={() =>
                  archive?.setArchived(
                    thread.id,
                    thread.lifecycleState !== "archived",
                  )
                }
              >
                {thread.lifecycleState === "archived" ? (
                  <ArchiveRestore />
                ) : (
                  <Archive />
                )}
                {thread.lifecycleState === "archived" ? "Unarchive" : "Archive"}
              </Menu.Item>
              <Menu.Separator className="thread-menu-separator" />
              <Menu.Item
                className="thread-menu-item"
                onClick={() => void copyUrl()}
              >
                <Copy />
                Copy Thread URL
              </Menu.Item>
              <ExportSubmenu onDownload={download} />
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      <span className="sr-only" aria-live="polite">
        {announcement}
        {announcement.startsWith("Could") ? (
          <X />
        ) : announcement ? (
          <Check />
        ) : null}
      </span>
    </>
  );
}
