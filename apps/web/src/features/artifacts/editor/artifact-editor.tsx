import { Menu } from "@base-ui/react/menu";
import type { ThreadId } from "@dx/domain";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowUp,
  BetweenHorizontalEnd,
  BetweenVerticalEnd,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  Download,
  GripVertical,
  Image as ImageIcon,
  ListChecks,
  LoaderCircle,
  MessageSquare,
  MessageSquarePlus,
  MoveHorizontal,
  Pencil,
  Plus,
  Table,
  TableProperties,
  Trash2,
} from "lucide-react";
import type { EditorState, Transaction } from "prosemirror-state";
import { type EditorProps, EditorView } from "prosemirror-view";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { useMountEffect } from "../../../shared/hooks/use-mount-effect.js";
import { useMobile } from "../../../shared/use-mobile.js";
import { artifactCommentsOptions } from "../artifact-comments-queries.js";
import type { ArtifactDocument } from "../artifacts-api.js";
import { artifactsApi } from "../artifacts-api.js";
import { ArtifactComments, type CommentDraft } from "./artifact-comments.js";
import {
  artifactClipboardTextParser,
  artifactNodeViews,
} from "./artifact-editor-state.js";
import type {
  ArtifactSession,
  ArtifactSessionSnapshot,
} from "./artifact-session.js";
import {
  artifactSessionFor,
  holdArtifactSession,
  releaseArtifactSession,
} from "./artifact-sessions.js";
import {
  BLOCK_KINDS,
  type BlockKind,
  deleteBlock,
  duplicateBlock,
  insertBlock,
  insertBlockBelow,
  insertChip,
  moveBlock,
  moveBlockTo,
  type TableAction,
  tableAction,
  turnBlockInto,
} from "./block-commands.js";
import { ChipInsertItems, ChipPicker, ViewFrames } from "./chip-picker.js";
import { useCommentPeople } from "./comment-people.js";
import { NotifyAgentButton } from "./notify-agent-button.js";
import { SuggestMenu } from "./suggest-menu.js";
import "prosemirror-view/style/prosemirror.css";
import "prosemirror-tables/style/tables.css";
import { linkClickProps, linkToOpen } from "./link-clicks.js";
import "./artifact-editor.css";

const authorName = (author: ArtifactSessionSnapshot["merged"]) =>
  author === undefined
    ? "Someone"
    : author.kind === "agent"
      ? "The agent"
      : (author.name ?? "Someone");

function SaveIndicator({
  snapshot,
}: {
  readonly snapshot: ArtifactSessionSnapshot;
}) {
  const { save } = snapshot;
  switch (save.kind) {
    case "saved":
      return (
        <span
          className="artifact-save"
          role="status"
          title={`Revision ${snapshot.revision}`}
        >
          <Check aria-hidden="true" />
          Saved
        </span>
      );
    case "unsaved":
      return (
        <span className="artifact-save" role="status">
          Unsaved
        </span>
      );
    case "saving":
      return (
        <span className="artifact-save" role="status">
          <LoaderCircle className="artifact-spin" aria-hidden="true" />
          Saving…
        </span>
      );
    case "error":
      return (
        <span className="artifact-save" data-tone="warning" role="status">
          <CircleAlert aria-hidden="true" />
          Not saved
        </span>
      );
    case "conflict":
      return (
        <span className="artifact-save" data-tone="warning" role="status">
          <CircleAlert aria-hidden="true" />
          Needs review
        </span>
      );
  }
}

function BlockKindItems({
  onPick,
  convertibleOnly = false,
}: {
  readonly onPick: (kind: BlockKind) => void;
  readonly convertibleOnly?: boolean;
}) {
  return (
    <>
      {BLOCK_KINDS.map(({ kind, label, convertible }) =>
        convertibleOnly && !convertible ? null : (
          <Menu.Item
            key={kind}
            className="thread-menu-item"
            data-block-kind={kind}
            onClick={() => onPick(kind)}
          >
            {label}
          </Menu.Item>
        ),
      )}
    </>
  );
}

function MenuPopup({
  children,
  align = "start",
  label,
}: {
  readonly children: React.ReactNode;
  readonly align?: "start" | "end";
  readonly label: string;
}) {
  return (
    <Menu.Portal>
      <Menu.Positioner
        className="thread-menu-positioner"
        align={align}
        sideOffset={4}
      >
        <Menu.Popup
          className="thread-menu-popup thread-actions-menu"
          aria-label={label}
        >
          {children}
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  );
}

/** How far the pointer moves on the grip before a press becomes a drag. */
const DRAG_START = 4;

/**
 * Insert Below and Block Options, beside the block under the pointer or
 * cursor. While a menu is open or a drag is under way the handle stays with
 * its block (`onPin`), so crossing other blocks or leaving the editor on the
 * way to the menu changes nothing. The grip drags the block to a new place
 * (a mouse; a phone uses Move Up and Move Down); a click opens Block Options.
 */
function BlockHandle({
  session,
  pos,
  top,
  run,
  onPin,
  onDone,
}: {
  readonly session: ArtifactSession;
  readonly pos: number;
  readonly top: number;
  readonly run: (
    build: (state: EditorState) => Transaction | undefined,
  ) => void;
  readonly onPin: (pinned: boolean) => void;
  /** The block moved or went: the handle follows the pointer again. */
  readonly onDone: () => void;
}) {
  const [optionsOpen, setOptionsOpen] = React.useState(false);
  const [press, setPress] = React.useState<{
    readonly x: number;
    readonly y: number;
    readonly dragging: boolean;
  }>();
  const [drop, setDrop] = React.useState<{
    readonly index: number;
    readonly top: number;
  }>();
  const finish = (index: number | undefined) => {
    setPress(undefined);
    setDrop(undefined);
    onPin(false);
    if (index === undefined) return;
    run((state) => moveBlockTo(state, pos, index));
    onDone();
  };
  return (
    <>
      <div className="artifact-block-handle" style={{ top }}>
        <Menu.Root onOpenChange={onPin}>
          <Menu.Trigger
            className="artifact-handle-button"
            aria-label="Insert Below"
            title="Insert Below"
          >
            <Plus aria-hidden="true" />
          </Menu.Trigger>
          <MenuPopup label="Insert Below">
            <BlockKindItems
              onPick={(kind) =>
                run((state) => insertBlockBelow(state, pos, kind))
              }
            />
          </MenuPopup>
        </Menu.Root>
        <Menu.Root
          open={optionsOpen}
          onOpenChange={(open) => {
            setOptionsOpen(open);
            onPin(open);
          }}
        >
          <Menu.Trigger
            className="artifact-handle-button artifact-grip"
            aria-label="Block Options"
            title="Drag to move, or click for options"
            // A mouse press may become a drag: the menu opens on release
            // without movement instead of on press. Touch and keys open it
            // as any menu.
            onPointerDown={(event) => {
              if (event.pointerType !== "mouse" || event.button !== 0) return;
              event.preventDefault();
              // Moves anywhere reach the grip while it drags.
              try {
                event.currentTarget.setPointerCapture(event.pointerId);
              } catch {
                // A pointer the browser no longer tracks: nothing to capture.
              }
              setPress({ x: event.clientX, y: event.clientY, dragging: false });
              onPin(true);
            }}
            onPointerMove={(event) => {
              if (press === undefined) return;
              const moved =
                press.dragging ||
                Math.hypot(event.clientX - press.x, event.clientY - press.y) >=
                  DRAG_START;
              if (!moved) return;
              if (!press.dragging) setPress({ ...press, dragging: true });
              setDrop(session.dropAt(event.clientY));
            }}
            onPointerUp={(event) => {
              if (press === undefined) return;
              if (press.dragging) finish(session.dropAt(event.clientY)?.index);
              else {
                finish(undefined);
                setOptionsOpen(true);
                onPin(true);
              }
            }}
            onPointerCancel={() => finish(undefined)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && press !== undefined)
                finish(undefined);
            }}
          >
            <GripVertical aria-hidden="true" />
          </Menu.Trigger>
          <MenuPopup label="Block Options">
            <Menu.SubmenuRoot>
              <Menu.SubmenuTrigger className="thread-menu-item">
                Turn Into
                <ChevronRight aria-hidden="true" />
              </Menu.SubmenuTrigger>
              <Menu.Portal>
                <Menu.Positioner
                  className="thread-menu-positioner"
                  alignOffset={-5}
                  sideOffset={4}
                >
                  <Menu.Popup
                    className="thread-menu-popup thread-actions-menu thread-actions-submenu"
                    aria-label="Turn Into"
                  >
                    <BlockKindItems
                      onPick={(kind) =>
                        run((state) => turnBlockInto(state, pos, kind))
                      }
                      convertibleOnly
                    />
                  </Menu.Popup>
                </Menu.Positioner>
              </Menu.Portal>
            </Menu.SubmenuRoot>
            {(
              [
                [-1, ArrowUp, "Move Up"],
                [1, ArrowDown, "Move Down"],
              ] as const
            ).map(([direction, Icon, label]) => (
              <Menu.Item
                key={label}
                className="thread-menu-item"
                onClick={() => {
                  run((state) => moveBlock(state, pos, direction));
                  onDone();
                }}
              >
                <Icon aria-hidden="true" />
                {label}
              </Menu.Item>
            ))}
            <Menu.Item
              className="thread-menu-item"
              onClick={() => run((state) => duplicateBlock(state, pos))}
            >
              <Copy aria-hidden="true" />
              Duplicate
            </Menu.Item>
            <Menu.Separator className="thread-menu-separator" />
            <Menu.Item
              className="thread-menu-item"
              onClick={() => {
                run((state) => deleteBlock(state, pos));
                onDone();
              }}
            >
              <Trash2 aria-hidden="true" />
              Delete
            </Menu.Item>
          </MenuPopup>
        </Menu.Root>
      </div>
      {press?.dragging && drop !== undefined ? (
        <div
          className="artifact-drop-line"
          style={{ top: drop.top }}
          aria-hidden="true"
        />
      ) : null}
    </>
  );
}

function TableTools({
  onAction,
}: {
  readonly onAction: (action: TableAction) => void;
}) {
  return (
    <>
      <button
        type="button"
        className="artifact-tool"
        title="Add Row"
        onClick={() => onAction("add-row")}
      >
        <BetweenHorizontalEnd
          aria-hidden="true"
          className="artifact-tool-phone-icon"
        />
        <span>Add Row</span>
      </button>
      <button
        type="button"
        className="artifact-tool"
        title="Add Column"
        onClick={() => onAction("add-column")}
      >
        <BetweenVerticalEnd
          aria-hidden="true"
          className="artifact-tool-phone-icon"
        />
        <span>Add Column</span>
      </button>
      <Menu.Root>
        <Menu.Trigger
          className="artifact-tool"
          aria-label="Row Options"
          title="Row Options"
        >
          <TableProperties
            aria-hidden="true"
            className="artifact-tool-phone-icon"
          />
          <span>Row Options</span>
          <ChevronDown aria-hidden="true" className="artifact-tool-caret" />
        </Menu.Trigger>
        <MenuPopup label="Row Options">
          <Menu.Item
            className="thread-menu-item"
            onClick={() => onAction("align-left")}
          >
            Align Column Left
          </Menu.Item>
          <Menu.Item
            className="thread-menu-item"
            onClick={() => onAction("align-center")}
          >
            Align Column Center
          </Menu.Item>
          <Menu.Item
            className="thread-menu-item"
            onClick={() => onAction("align-right")}
          >
            Align Column Right
          </Menu.Item>
          <Menu.Separator className="thread-menu-separator" />
          <Menu.Item
            className="thread-menu-item"
            onClick={() => onAction("delete-row")}
          >
            Delete Row
          </Menu.Item>
          <Menu.Item
            className="thread-menu-item"
            onClick={() => onAction("delete-column")}
          >
            Delete Column
          </Menu.Item>
          <Menu.Item
            className="thread-menu-item"
            onClick={() => onAction("delete-table")}
          >
            Delete Table
          </Menu.Item>
        </MenuPopup>
      </Menu.Root>
    </>
  );
}

/** The image types the Thread stores. */
const IMAGE_TYPES = "image/png,image/jpeg,image/gif,image/webp";

/** The image files a paste or drop carries. */
const imageFiles = (data: DataTransfer | null): File[] =>
  [...(data?.files ?? [])].filter((file) => file.type.startsWith("image/"));

/** Pasted or dropped image files upload to the Thread. */
const imageDropProps = (session: ArtifactSession): Partial<EditorProps> => ({
  handlePaste: (_view, event) => {
    const files = imageFiles(event.clipboardData);
    if (files.length === 0) return false;
    session.uploadImages(files);
    return true;
  },
  handleDrop: (target, event) => {
    const files = imageFiles(event.dataTransfer);
    if (files.length === 0) return false;
    event.preventDefault();
    const at = target.posAtCoords({ left: event.clientX, top: event.clientY });
    session.uploadImages(files, at?.pos);
    return true;
  },
});

/**
 * The file picker Insert Image opens, which the session opens while it is
 * mounted; picked images upload to the Thread.
 */
function ImageFileInput({ session }: { readonly session: ArtifactSession }) {
  return (
    <input
      ref={(input) =>
        input === null ? undefined : session.setImagePicker(() => input.click())
      }
      className="artifact-image-input"
      type="file"
      accept={IMAGE_TYPES}
      multiple
      hidden
      aria-label="Image files"
      onChange={(event) => {
        const files = [...(event.currentTarget.files ?? [])];
        event.currentTarget.value = "";
        if (files.length > 0) session.uploadImages(files);
      }}
    />
  );
}

/** Rename opens the title field: it takes focus as it appears. */
const focusField = (node: HTMLInputElement | null) => {
  node?.focus();
  node?.select();
};

/**
 * The title field. Its size sits on the wrapper: a touch screen keeps every
 * field at max(16px, 1em), and 1em is the parent's size.
 */
function TitleField({
  title,
  readOnly,
  focus,
  onRename,
  onSubmit,
}: {
  readonly title: string;
  readonly readOnly: boolean;
  readonly focus: boolean;
  readonly onRename: (title: string) => void;
  readonly onSubmit: () => void;
}) {
  return (
    <div className="artifact-title-field">
      <input
        className="artifact-title"
        ref={focus ? focusField : undefined}
        aria-label="Title"
        defaultValue={title}
        readOnly={readOnly}
        maxLength={200}
        onBlur={(event) => onRename(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            onRename(event.currentTarget.value);
            onSubmit();
          }
        }}
      />
    </div>
  );
}

const downloadMarkdown = (title: string, markdown: string) => {
  const url = URL.createObjectURL(
    new Blob([markdown], { type: "text/markdown;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${title.replace(/[\\/:*?"<>|]+/g, "-").trim() || "artifact"}.md`;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

/** Insert blocks and chips, comment on the selection, and table tools. */
function ArtifactToolbar({
  threadId,
  artifactId,
  snapshot,
  wide,
  run,
  onComment,
  onImage,
  onWide,
}: {
  readonly threadId: ThreadId;
  readonly artifactId: string;
  readonly snapshot: ArtifactSessionSnapshot;
  readonly wide: boolean;
  readonly run: (
    build: (state: EditorState) => Transaction | undefined,
  ) => void;
  readonly onComment: () => void;
  readonly onImage: () => void;
  readonly onWide: () => void;
}) {
  return (
    <fieldset className="artifact-toolbar" aria-label="Artifact tools">
      <button
        type="button"
        className="artifact-tool"
        title="Table"
        onClick={() => run((state) => insertBlock(state, "table"))}
      >
        <Table aria-hidden="true" />
        <span>Table</span>
      </button>
      <button
        type="button"
        className="artifact-tool"
        title="Checklist"
        onClick={() => run((state) => insertBlock(state, "checklist"))}
      >
        <ListChecks aria-hidden="true" />
        <span>Checklist</span>
      </button>
      <Menu.Root>
        <Menu.Trigger
          className="artifact-tool"
          aria-label="Insert"
          title="Insert"
        >
          <Plus aria-hidden="true" />
          <span>Insert</span>
        </Menu.Trigger>
        <MenuPopup label="Insert">
          <BlockKindItems
            onPick={(kind) => run((state) => insertBlock(state, kind))}
          />
          <Menu.Item className="thread-menu-item" onClick={onImage}>
            <ImageIcon aria-hidden="true" />
            Image
          </Menu.Item>
          <ChipInsertItems
            threadId={threadId}
            onInsert={(source) => run((state) => insertChip(state, source))}
          />
        </MenuPopup>
      </Menu.Root>
      <button
        type="button"
        className="artifact-tool"
        title="Comment"
        disabled={!snapshot.selection.ranged}
        onClick={onComment}
      >
        <MessageSquarePlus aria-hidden="true" />
        <span>Comment</span>
      </button>
      <NotifyAgentButton
        threadId={threadId}
        artifactId={artifactId}
        revision={snapshot.revision}
      />
      {snapshot.selection.inTable ? (
        <TableTools
          onAction={(action) => run((state) => tableAction(state, action))}
        />
      ) : null}
      <button
        type="button"
        className="artifact-tool artifact-tool-end"
        aria-pressed={wide}
        aria-label="Wide Layout"
        title="Wide Layout"
        onClick={onWide}
      >
        <MoveHorizontal aria-hidden="true" />
      </button>
    </fieldset>
  );
}

/** A conflict to review, a merge that kept your edits, or a failed save. */
function ArtifactNotices({
  session,
  snapshot,
  quoteError,
}: {
  readonly session: ArtifactSession;
  readonly snapshot: ArtifactSessionSnapshot;
  readonly quoteError: string | undefined;
}) {
  const { save } = snapshot;
  return (
    <>
      {save.kind === "conflict" ? (
        <div className="artifact-notice" role="alert" data-tone="warning">
          <span>
            {authorName(snapshot.merged)} changed what you were editing. Both
            versions are kept and marked; remove the one you don't want.
          </span>
          <div className="artifact-notice-actions">
            <button type="button" onClick={() => session.keepBoth()}>
              Done
            </button>
            <button type="button" onClick={() => session.keepMine()}>
              Keep My Version
            </button>
          </div>
        </div>
      ) : snapshot.merged !== undefined ? (
        <div className="artifact-notice" role="status">
          {authorName(snapshot.merged)} saved revision {snapshot.revision}; your
          edits were kept.
        </div>
      ) : save.kind === "error" ? (
        <div className="artifact-notice" role="alert" data-tone="warning">
          {save.message}
        </div>
      ) : null}
      {quoteError === undefined ? null : (
        <div className="artifact-notice" role="alert">
          {quoteError}
        </div>
      )}
    </>
  );
}

/**
 * The block editor for one artifact: edits save on their own, and a newer
 * revision someone else saved merges into what is on screen.
 */
export function ArtifactEditor({
  threadId,
  initial,
  readOnly,
  switcher,
}: {
  readonly threadId: ThreadId;
  readonly initial: ArtifactDocument;
  readonly readOnly: boolean;
  /** The header's artifact switcher, from the view. */
  readonly switcher: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  // The session a previous view of this artifact left (a pane move, the
  // phone sheet, a tab switch), so editing carries on where it stopped.
  const [session] = React.useState(() =>
    artifactSessionFor(queryClient, {
      threadId,
      initial,
      api: artifactsApi,
    }),
  );
  const snapshot = React.useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const [wide, setWide] = React.useState(false);
  const phone = useMobile(1023);
  const [commentsOpen, setCommentsOpen] = React.useState(false);
  const [draft, setDraft] = React.useState<CommentDraft>();
  const [quoteError, setQuoteError] = React.useState<string>();
  const [draftBody, setDraftBody] = React.useState("");
  // `@` lists the Thread's people; comments show their pictures.
  const { identity } = useAuthenticatedIdentity();
  const people = useCommentPeople(identity, threadId);
  const comments = useQuery(
    artifactCommentsOptions(threadId, initial.artifact.id),
  );
  const [renaming, setRenaming] = React.useState(false);
  const [hovered, setHovered] = React.useState<
    { readonly pos: number; readonly top: number } | undefined
  >();
  // The handle stays with its block while its menu is open or it drags.
  const [pinned, setPinned] = React.useState<typeof hovered>();
  const host = React.useRef<HTMLDivElement>(null);
  const page = React.useRef<HTMLDivElement>(null);
  const view = React.useRef<EditorView>(undefined);

  useMountEffect(() => {
    const mount = host.current;
    const pageNode = page.current;
    if (mount === null || pageNode === null) return;
    const editor = new EditorView(mount, {
      state: session.state,
      editable: () => !readOnly,
      nodeViews: artifactNodeViews({
        // A reader may still flip toggles; only editors open pickers.
        onChip: (pos, chip) => {
          if (!readOnly || chip.kind === "toggle") session.onChip(pos, chip);
        },
        showView: session.showView,
        setImageAlt: session.setImageAlt,
      }),
      clipboardTextParser: artifactClipboardTextParser,
      ...(readOnly ? {} : imageDropProps(session)),
      dispatchTransaction: session.dispatch,
      // A link opens in a new tab, in a table cell as anywhere else.
      ...linkClickProps,
      // Clicking highlighted text opens its comment, unless it is a link.
      handleClick: (clicked, pos, event) => {
        if (linkToOpen(clicked, event) !== undefined) return false;
        const id = session.commentAt(pos);
        if (id === undefined) return false;
        session.selectComment(id);
        setCommentsOpen(true);
        return false;
      },
      attributes: {
        class: "artifact-prose",
        "aria-label": "Artifact content",
        role: "textbox",
        "aria-multiline": "true",
      },
    });
    view.current = editor;
    session.attach(editor, pageNode);
    holdArtifactSession(queryClient, threadId, initial, session);
    const stopFollowing = session.followQuery();
    const stopComments = session.followComments();
    const stopPeople = session.followPeople(identity.id);
    const warn = (event: BeforeUnloadEvent) => {
      if (session.dirty) event.preventDefault();
    };
    const leave = () => {
      if (document.visibilityState === "hidden") session.flush();
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("visibilitychange", leave);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("visibilitychange", leave);
      stopFollowing();
      stopComments();
      stopPeople();
      session.detach(editor);
      releaseArtifactSession(queryClient, threadId, initial, session);
      editor.destroy();
      view.current = undefined;
    };
  });

  const run = (
    build: (state: typeof session.state) => Transaction | undefined,
  ) => {
    const tr = build(session.state);
    if (tr === undefined) return;
    session.dispatch(tr);
    view.current?.focus();
  };
  const handle = pinned ?? hovered ?? snapshot.selection.block;
  const openComments = (comments.data ?? []).filter(
    (comment) => comment.parentId === null && comment.resolvedAt === null,
  ).length;

  return (
    <section
      className="artifact-view"
      data-wide={wide || undefined}
      aria-label={`Artifact ${snapshot.title}`}
      onKeyDown={(event) => {
        if (
          (event.metaKey || event.ctrlKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          session.flush();
        }
      }}
    >
      <header className="artifact-header">
        {switcher}
        <SaveIndicator snapshot={snapshot} />
        <button
          type="button"
          className="artifact-icon-button artifact-comments-toggle"
          aria-label={`Comments (${openComments})`}
          aria-pressed={commentsOpen}
          title="Comments"
          onClick={() => setCommentsOpen((open) => !open)}
        >
          <MessageSquare aria-hidden="true" />
          {openComments === 0 ? null : <span>{openComments}</span>}
        </button>
        {readOnly ? null : (
          <button
            type="button"
            className="artifact-icon-button"
            aria-label="Rename"
            title="Rename"
            onClick={() => setRenaming(true)}
          >
            <Pencil aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="artifact-icon-button"
          aria-label="Export Markdown"
          title="Export Markdown"
          onClick={() => downloadMarkdown(snapshot.title, session.markdown())}
        >
          <Download aria-hidden="true" />
        </button>
      </header>
      {readOnly ? null : (
        <ArtifactToolbar
          threadId={threadId}
          artifactId={initial.artifact.id}
          snapshot={snapshot}
          wide={wide}
          run={run}
          onImage={session.pickImage}
          onWide={() => setWide((value) => !value)}
          onComment={async () => {
            const quote = await session.quoteSelection();
            if (quote === undefined || quote === "unsaved") {
              setQuoteError(
                quote === "unsaved"
                  ? "Save your edits before commenting."
                  : "Select text to comment on.",
              );
              return;
            }
            setQuoteError(undefined);
            setDraft(quote);
            setCommentsOpen(true);
          }}
        />
      )}
      <ArtifactNotices
        session={session}
        snapshot={snapshot}
        quoteError={quoteError}
      />
      <div className="artifact-main">
        <div
          className="artifact-scroll"
          onPointerMove={(event) => {
            if (readOnly || pinned || event.pointerType !== "mouse") return;
            const block = session.blockAt(event.clientX, event.clientY);
            if (block?.pos !== hovered?.pos || block?.top !== hovered?.top)
              setHovered(block);
          }}
          onPointerLeave={() => setHovered(undefined)}
        >
          <div className="artifact-page" ref={page}>
            {snapshot.headed && !renaming ? null : (
              <TitleField
                key={snapshot.title}
                title={snapshot.title}
                readOnly={readOnly}
                focus={renaming}
                onRename={(title) => {
                  session.rename(title);
                  setRenaming(false);
                }}
                onSubmit={() => view.current?.focus()}
              />
            )}
            <div className="artifact-content" ref={host} />
            {readOnly ? null : <ImageFileInput session={session} />}
            <ViewFrames views={snapshot.views} />
            {readOnly ? null : (
              <SuggestMenu
                menu={snapshot.suggest}
                onPick={session.pickSuggestion}
                onHighlight={session.highlightSuggestion}
              />
            )}
            {readOnly ? null : (
              <ChipPicker session={session} open={snapshot.chip} />
            )}
            {readOnly || handle === undefined ? null : (
              <BlockHandle
                session={session}
                pos={handle.pos}
                top={handle.top}
                run={run}
                onPin={(pin) => setPinned(pin ? handle : undefined)}
                onDone={() => setHovered(undefined)}
              />
            )}
            {readOnly ? null : (
              // The space below the document: a click or tap there starts a
              // paragraph at the end, as Notion does.
              <button
                type="button"
                className="artifact-append"
                aria-label="Add a block at the end"
                onMouseDown={(event) => event.preventDefault()}
                onClick={session.focusEnd}
              />
            )}
          </div>
        </div>
        {commentsOpen ? (
          <ArtifactComments
            phone={phone}
            snapshot={snapshot}
            comments={comments.data ?? []}
            loadFailed={comments.isError}
            draft={draft}
            draftText={{ value: draftBody, set: setDraftBody }}
            readOnly={readOnly}
            people={people}
            threadId={threadId}
            artifactId={initial.artifact.id}
            onSelect={session.selectComment}
            onDraftDone={() => setDraft(undefined)}
            // A comment being written stays for when the panel opens again.
            onClose={() => {
              setCommentsOpen(false);
              setQuoteError(undefined);
              session.selectComment(undefined);
            }}
          />
        ) : null}
      </div>
    </section>
  );
}
