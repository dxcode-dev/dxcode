import { Menu } from "@base-ui/react/menu";
import type { ProjectData, ThreadDetailData } from "@dx/api";
import { Link } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  Braces,
  Check,
  ChevronRight,
  Copy,
  Ellipsis,
  FileDown,
  FileText,
  Hash,
  Link2,
  Pencil,
  Share2,
  X,
} from "lucide-react";
import * as React from "react";
import { useOptionalThreadArchive } from "../../shared/thread-archive.js";
import { useOptionalThreadEditing } from "../../shared/thread-editing.js";
import { absoluteThreadUrl } from "../../shared/thread-url.js";
import { Button } from "../../shared/ui/button.js";
import { SubthreadIcon } from "../../shared/ui/subthread-icon.js";
import { ThreadColorSubmenu } from "../../shared/ui/thread-color-submenu.js";
import {
  serializeThreadJson,
  serializeThreadMarkdown,
  threadExportFilename,
} from "./thread-export.js";
import type { TranscriptViewModel } from "./transcript-view-model.js";

function Submenu({
  icon,
  label,
  children,
}: {
  readonly icon: React.ReactNode;
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <Menu.SubmenuRoot>
      <Menu.SubmenuTrigger className="thread-menu-item">
        {icon}
        <span>{label}</span>
        <ChevronRight />
      </Menu.SubmenuTrigger>
      <Menu.Portal>
        <Menu.Positioner
          className="thread-menu-positioner"
          sideOffset={4}
          alignOffset={-4}
        >
          <Menu.Popup className="thread-menu-popup thread-actions-menu thread-actions-submenu">
            {children}
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
  onOpenShare,
}: {
  readonly thread: ThreadDetailData;
  readonly project?: Pick<ProjectData, "name">;
  readonly model: TranscriptViewModel;
  readonly onOpenShare?: () => void;
}) {
  const archive = useOptionalThreadArchive();
  const editing = useOptionalThreadEditing();
  // Archiving and editing are the owner's; members of a shared Thread only
  // read or export.
  const own = thread.access === undefined || thread.access === "owner";
  const [announcement, setAnnouncement] = React.useState("");
  const copy = async (text: string, label: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setAnnouncement(`${label} copied.`);
    } catch {
      setAnnouncement(`Could not copy the ${label}.`);
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
  const editable = own && editing !== undefined;
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
            <Menu.Popup className="thread-menu-popup thread-actions-menu">
              {!own || thread.parentThreadId === undefined ? null : (
                <>
                  <Menu.Item
                    className="thread-menu-item"
                    render={
                      <Link
                        to="/threads/$threadId"
                        params={{ threadId: thread.parentThreadId }}
                      />
                    }
                  >
                    <SubthreadIcon strokeWidth={2} />
                    <span>Open Source Thread</span>
                  </Menu.Item>
                  <Menu.Separator className="thread-menu-separator" />
                </>
              )}
              <Submenu icon={<Copy />} label="Copy">
                <Menu.Item
                  className="thread-menu-item"
                  onClick={() =>
                    void copy(
                      absoluteThreadUrl(thread.id, window.location.href),
                      "Thread URL",
                    )
                  }
                >
                  <Link2 />
                  <span>Thread URL</span>
                </Menu.Item>
                <Menu.Item
                  className="thread-menu-item"
                  onClick={() => void copy(thread.id, "Thread ID")}
                >
                  <Hash />
                  <span>Thread ID</span>
                </Menu.Item>
              </Submenu>
              <Submenu icon={<FileDown />} label="Export">
                <Menu.Item
                  className="thread-menu-item"
                  onClick={() => download("markdown")}
                >
                  <FileText />
                  <span>Markdown</span>
                </Menu.Item>
                <Menu.Item
                  className="thread-menu-item"
                  onClick={() => download("json")}
                >
                  <Braces />
                  <span>JSON</span>
                </Menu.Item>
              </Submenu>
              {onOpenShare === undefined && !editable ? null : (
                <Menu.Separator className="thread-menu-separator" />
              )}
              {onOpenShare === undefined ? null : (
                <Menu.Item className="thread-menu-item" onClick={onOpenShare}>
                  <Share2 />
                  <span>Share…</span>
                </Menu.Item>
              )}
              {editable ? (
                <>
                  <Menu.Item
                    className="thread-menu-item"
                    onClick={() => editing.openRename(thread)}
                  >
                    <Pencil />
                    <span>Rename</span>
                  </Menu.Item>
                  <ThreadColorSubmenu
                    thread={thread}
                    itemClassName="thread-menu-item"
                    onSelect={(color) => editing.setColor(thread.id, color)}
                  />
                </>
              ) : null}
              {own ? (
                <>
                  <Menu.Separator className="thread-menu-separator" />
                  <Menu.Item
                    className="thread-menu-item"
                    disabled={
                      archive === undefined ||
                      archive.pendingThreadId === thread.id
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
                    <span>
                      {thread.lifecycleState === "archived"
                        ? "Unarchive"
                        : "Archive"}
                    </span>
                  </Menu.Item>
                </>
              ) : null}
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
