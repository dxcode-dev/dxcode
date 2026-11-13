import type { ThreadArtifactComment } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import {
  CaptureUpdateAction,
  Excalidraw,
  exportToBlob,
  exportToSvg,
  MainMenu,
} from "@excalidraw/excalidraw";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  Download,
  LoaderCircle,
  MessageSquare,
  MessageSquarePlus,
  Pencil,
} from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import type { DictationSlot } from "../../../shared/dictation/dictation-slot.js";
import { useMountEffect } from "../../../shared/hooks/use-mount-effect.js";
import { useBoardLiveChannel } from "../../../shared/realtime/board-live.js";
import { useTheme } from "../../../shared/theme/theme-provider.js";
import { Avatar } from "../../../shared/ui/avatar.js";
import { Button } from "../../../shared/ui/button.js";
import { buttonVariants } from "../../../shared/ui/button-variants.js";
import { ConfirmDialog } from "../../../shared/ui/confirm-dialog.js";
import { Input } from "../../../shared/ui/input.js";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuTrigger,
} from "../../../shared/ui/menu.js";
import { cn } from "../../../shared/utils.js";
import { threadMembersQueryOptions } from "../../threads/sharing/thread-chat-queries.js";
import { artifactCommentsOptions } from "../artifact-comments-queries.js";
import { type ArtifactDocument, artifactsApi } from "../artifacts-api.js";
import {
  CommentCard,
  type CommentDraft,
  CommentsMenu,
} from "../editor/artifact-comments.js";
import { saveFile } from "../editor/artifact-export.js";
import { useArtifactFileActions } from "../editor/artifact-file-actions.js";
import { useCommentPeople } from "../editor/comment-people.js";
import {
  type BoardSaveState,
  BoardSession,
  type BoardSnapshot,
  collaboratorColor,
  storedBackground,
} from "./board-session.js";
import "@excalidraw/excalidraw/index.css";
// The header's buttons, save state, and comment cards, as documents have them.
import "../editor/artifact-editor.css";
import "./board-editor.css";

function SaveIndicator({
  save,
  revision,
}: {
  readonly save: BoardSaveState;
  readonly revision: number;
}) {
  switch (save.kind) {
    case "saved":
      return (
        <span
          className="artifact-save"
          role="status"
          title={`Revision ${revision}`}
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
        <span
          className="artifact-save"
          data-tone="warning"
          role="status"
          title={save.message}
        >
          <CircleAlert aria-hidden="true" />
          Not saved
        </span>
      );
  }
}

/** Who else is on the board now, in their cursor colors. */
function PresenceStack({
  present,
  people,
}: {
  readonly present: BoardSnapshot["present"];
  readonly people: ReturnType<typeof useCommentPeople>;
}) {
  const users = [...new Set(present.map(({ userId }) => userId))];
  if (users.length === 0) return null;
  const names = users.map((userId) => people.get(userId)?.name ?? "Someone");
  return (
    <span
      className="board-presence"
      role="status"
      aria-label={`On this board: ${names.join(", ")}`}
      title={`On this board: ${names.join(", ")}`}
    >
      {users.slice(0, 4).map((userId, index) => {
        const person = people.get(userId);
        return (
          <span
            key={userId}
            className="board-presence-person"
            style={
              {
                "--board-person": collaboratorColor(userId).stroke,
              } as React.CSSProperties
            }
          >
            <Avatar
              name={names[index] ?? "Someone"}
              {...(person?.image === undefined ? {} : { image: person.image })}
              seed={userId}
            />
          </span>
        );
      })}
      {users.length > 4 ? (
        <span className="board-presence-more">+{users.length - 4}</span>
      ) : null}
    </span>
  );
}

/** Where a shape's comment pin sits, in the canvas's own pixels. */
const pinPosition = (
  element: ExcalidrawElement,
  viewport: BoardSnapshot["viewport"],
) => ({
  left: (element.x + element.width + viewport.scrollX) * viewport.zoom,
  top: (element.y + viewport.scrollY) * viewport.zoom,
});

/** What a comment sits on: the shape, or the shape a label belongs to. */
const commentTarget = (
  elements: ReadonlyArray<ExcalidrawElement>,
  selected: ReadonlyArray<string>,
) => {
  const chosen = new Set(selected);
  const element = elements.find(({ id }) => chosen.has(id));
  if (element === undefined) return undefined;
  const container =
    "containerId" in element && element.containerId !== null
      ? elements.find(({ id }) => id === element.containerId)
      : undefined;
  return container ?? element;
};

const elementLabel = (
  elements: ReadonlyArray<ExcalidrawElement>,
  element: ExcalidrawElement,
) => {
  const text =
    element.type === "text"
      ? element.text
      : elements.find(
          (candidate) =>
            candidate.type === "text" && candidate.containerId === element.id,
        );
  const words =
    typeof text === "string"
      ? text
      : text !== undefined && "text" in text
        ? text.text
        : "";
  const names: Record<string, string> = {
    rectangle: "Rectangle",
    ellipse: "Ellipse",
    diamond: "Diamond",
    text: "Text",
    arrow: "Arrow",
    line: "Line",
    freedraw: "Drawing",
    image: "Image",
    frame: "Frame",
  };
  const kind = names[element.type] ?? "Shape";
  const short = words.replace(/\s+/g, " ").trim();
  return short === "" ? kind : `${kind}: ${short.slice(0, 80)}`;
};

/** Pins on the shapes that have open comments; one opens its card. */
function CommentPins({
  comments,
  snapshot,
  draft,
  activeId,
  onOpen,
}: {
  readonly comments: ReadonlyArray<ThreadArtifactComment>;
  readonly snapshot: BoardSnapshot;
  readonly draft: (CommentDraft & { readonly target: string }) | undefined;
  readonly activeId: string | undefined;
  readonly onOpen: (id: string) => void;
}) {
  const byId = new Map(
    snapshot.elements.map((element) => [element.id, element]),
  );
  const open = comments.filter(
    (comment) =>
      comment.parentId === null &&
      comment.resolvedAt === null &&
      comment.target !== null &&
      byId.has(comment.target),
  );
  // Several comments on one shape share a pin, offset in a row.
  const order = new Map<string, number>();
  return (
    <div className="board-pins">
      {open.map((comment) => {
        const element = byId.get(comment.target ?? "") as ExcalidrawElement;
        const index = order.get(element.id) ?? 0;
        order.set(element.id, index + 1);
        const position = pinPosition(element, snapshot.viewport);
        const replies = comments.filter(
          (reply) => reply.parentId === comment.id,
        ).length;
        return (
          <button
            key={comment.id}
            type="button"
            className="board-pin"
            data-board-comment={comment.id}
            data-active={comment.id === activeId || undefined}
            style={{
              left: position.left + index * 26,
              top: position.top,
            }}
            aria-label={`Comment on ${comment.quote}`}
            title={comment.body}
            onClick={() => onOpen(comment.id)}
          >
            <MessageSquare aria-hidden="true" />
            {replies === 0 ? null : <span>{replies + 1}</span>}
          </button>
        );
      })}
      {draft === undefined
        ? null
        : (() => {
            const element = byId.get(draft.target);
            if (element === undefined) return null;
            const position = pinPosition(element, snapshot.viewport);
            return (
              <span
                className="board-pin"
                data-board-comment="draft"
                data-draft
                style={{ left: position.left, top: position.top }}
              >
                <MessageSquarePlus aria-hidden="true" />
              </span>
            );
          })()}
    </div>
  );
}

function BoardExportMenu({
  editor,
  title,
}: {
  readonly editor: () => ExcalidrawImperativeAPI | undefined;
  readonly title: string;
}) {
  const [failed, setFailed] = React.useState(false);
  const name = title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "Board";
  const scene = () => {
    const api = editor();
    if (api === undefined) throw new Error("The board is not open.");
    const appState = api.getAppState();
    // Exports are light, on the board's own background (white by default).
    return {
      elements: api.getSceneElements(),
      appState: {
        ...appState,
        exportBackground: true,
        exportWithDarkMode: false,
        viewBackgroundColor: storedBackground(appState.viewBackgroundColor),
      },
      files: api.getFiles(),
    };
  };
  const run = async (make: () => Promise<File>) => {
    setFailed(false);
    try {
      await saveFile(await make());
    } catch {
      setFailed(true);
    }
  };
  return (
    <MenuRoot>
      <MenuTrigger
        className={cn(
          buttonVariants({ variant: "subtle", size: "icon-xs" }),
          "artifact-icon-button",
        )}
        aria-label="Export"
        title={failed ? "Couldn't export. Try again." : "Export"}
      >
        <Download aria-hidden="true" />
      </MenuTrigger>
      <MenuPopup side="bottom" align="end" aria-label="Export">
        <MenuItem
          onClick={() =>
            void run(async () => {
              const blob = await exportToBlob({
                ...scene(),
                mimeType: "image/png",
                exportPadding: 24,
                getDimensions: (width: number, height: number) => ({
                  width: width * 2,
                  height: height * 2,
                  scale: 2,
                }),
              });
              return new File([blob], `${name}.png`, { type: "image/png" });
            })
          }
        >
          Download PNG
        </MenuItem>
        <MenuItem
          onClick={() =>
            void run(async () => {
              const svg = await exportToSvg({
                ...scene(),
                exportPadding: 24,
              });
              return new File([svg.outerHTML], `${name}.svg`, {
                type: "image/svg+xml",
              });
            })
          }
        >
          Download SVG
        </MenuItem>
      </MenuPopup>
    </MenuRoot>
  );
}

/** An icon action in the board's header: a subtle icon Button. */
function BoardToolButton(props: React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="subtle"
      size="icon-xs"
      className="artifact-icon-button"
      {...props}
    />
  );
}

/**
 * A drawing board: the editor, its save state, who else is drawing, and
 * comments on shapes. Loaded only when a board opens.
 */
export function BoardEditor({
  threadId,
  initial,
  readOnly,
  switcher,
  dictation,
}: {
  readonly threadId: ThreadId;
  readonly initial: ArtifactDocument;
  readonly readOnly: boolean;
  readonly switcher:
    | React.ReactNode
    | ((items: React.ReactNode) => React.ReactNode);
  readonly dictation?: DictationSlot | undefined;
}) {
  const queryClient = useQueryClient();
  const artifactId = initial.artifact.id;
  const [session] = React.useState(
    () =>
      new BoardSession({
        threadId,
        initial,
        api: artifactsApi,
        queryClient,
        readOnly,
      }),
  );
  const snapshot = React.useSyncExternalStore(
    session.subscribe,
    session.getSnapshot,
    session.getSnapshot,
  );
  const live = useBoardLiveChannel(threadId, artifactId);
  const { identity } = useAuthenticatedIdentity();
  const people = useCommentPeople(identity, threadId);
  const comments = useQuery(artifactCommentsOptions(threadId, artifactId));
  const { resolvedAppearance } = useTheme();
  const [editor, setEditor] = React.useState<ExcalidrawImperativeAPI>();
  const [draft, setDraft] = React.useState<
    (CommentDraft & { readonly target: string }) | undefined
  >();
  const [draftBody, setDraftBody] = React.useState("");
  const [activeComment, setActiveComment] = React.useState<string>();
  // The editor reads its first scene once, as it mounts.
  const [initialData] = React.useState(() => session.initialData());
  const [renaming, setRenaming] = React.useState(false);
  const [newTitle, setNewTitle] = React.useState(snapshot.title);
  const files = useArtifactFileActions({
    session,
    threadId,
    artifactId,
    folder: snapshot.folder,
    readOnly,
  });

  // The board's lifetime: follow saves others make, warn before leaving
  // with unsaved changes, and save on the way out.
  useMountEffect(() => {
    const stopFollowing = session.followQuery();
    const warn = (event: BeforeUnloadEvent) => {
      if (session.dirty && !session.readOnly) event.preventDefault();
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
      session.flush();
    };
  });

  // The editor's API arrives once it mounts; the live channel starts then.
  useMountEffect(() => () => session.detach());
  const connect = (api: ExcalidrawImperativeAPI) => {
    if (editor === api) return;
    setEditor(api);
    session.setNames((userId) => {
      const members =
        queryClient.getQueryData(
          threadMembersQueryOptions(identity.id as UserId, threadId).queryKey,
        ) ?? [];
      const member = members.find((entry) => entry.userId === userId);
      return member === undefined
        ? { name: userId === identity.id ? identity.name : "Someone" }
        : {
            name: member.name,
            ...(member.image === undefined ? {} : { avatarUrl: member.image }),
          };
    });
    session.attach(api, live);
  };

  const target = commentTarget(snapshot.elements, snapshot.selected);
  const startComment = () => {
    if (target === undefined) return;
    setActiveComment(undefined);
    setDraft({
      target: target.id,
      label: elementLabel(snapshot.elements, target),
    });
  };
  const openComment = (id: string) => {
    setDraft(undefined);
    setActiveComment(id);
    const comment = comments.data?.find((entry) => entry.id === id);
    const element = snapshot.elements.find(
      ({ id: elementId }) => elementId === comment?.target,
    );
    if (element !== undefined && editor !== undefined) {
      editor.scrollToContent(element, { animate: true, duration: 300 });
      editor.updateScene({
        appState: { selectedElementIds: { [element.id]: true } },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    }
  };
  // Open comments in the order of their shapes, for the Comments list.
  const order = new Map(
    snapshot.elements.map((element, index) => [element.id, index]),
  );
  const anchors: Array<{ id: string; from: number }> = [];
  for (const comment of comments.data ?? []) {
    const from =
      comment.target === null ? undefined : order.get(comment.target);
    if (from !== undefined) anchors.push({ id: comment.id, from });
  }

  return (
    <section
      className="artifact-view board-view"
      aria-label={`Board ${snapshot.title}`}
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
        {typeof switcher === "function" ? switcher(files.items) : switcher}
        <PresenceStack present={snapshot.present} people={people} />
        {readOnly ? (
          <span className="artifact-save" role="status">
            View only
          </span>
        ) : (
          <SaveIndicator save={snapshot.save} revision={snapshot.revision} />
        )}
        {readOnly ? null : (
          <BoardToolButton
            aria-label="Comment on Shape"
            title={
              target === undefined
                ? "Select a shape to comment on it"
                : "Comment on Shape"
            }
            disabled={target === undefined}
            onClick={startComment}
          >
            <MessageSquarePlus aria-hidden="true" />
          </BoardToolButton>
        )}
        <CommentsMenu
          comments={comments.data ?? []}
          anchors={anchors}
          loadFailed={comments.isError}
          onSelect={openComment}
          emptyText="No comments yet. Select a shape and choose Comment on Shape."
          detachedHeading="Shape no longer here"
        />
        {readOnly ? null : (
          <BoardToolButton
            aria-label="Rename"
            title="Rename"
            onClick={() => {
              setNewTitle(snapshot.title);
              setRenaming(true);
            }}
          >
            <Pencil aria-hidden="true" />
          </BoardToolButton>
        )}
        <BoardExportMenu editor={() => editor} title={snapshot.title} />
      </header>
      <div
        className="board-canvas"
        data-theme={resolvedAppearance}
        onKeyDownCapture={session.noteInput}
        onPasteCapture={session.noteInput}
        onDropCapture={session.noteInput}
        onPointerDownCapture={session.noteInput}
      >
        <Excalidraw
          initialData={initialData}
          excalidrawAPI={connect}
          onChange={session.onChange}
          onPointerUpdate={session.onPointerUpdate}
          isCollaborating
          viewModeEnabled={readOnly}
          theme={resolvedAppearance === "dark" ? "dark" : "light"}
          name={snapshot.title}
          aiEnabled={false}
          validateEmbeddable={false}
          UIOptions={{
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              toggleTheme: false,
              export: false,
              saveAsImage: false,
            },
            tools: { image: !readOnly },
          }}
        >
          <MainMenu>
            <MainMenu.DefaultItems.ChangeCanvasBackground />
            <MainMenu.DefaultItems.ClearCanvas />
            <MainMenu.DefaultItems.Help />
          </MainMenu>
        </Excalidraw>
        <CommentPins
          comments={comments.data ?? []}
          snapshot={snapshot}
          draft={draft}
          activeId={activeComment}
          onOpen={openComment}
        />
      </div>
      {draft === undefined && activeComment === undefined ? null : (
        <CommentCard
          key={draft === undefined ? activeComment : `draft:${draft.target}`}
          target={
            draft === undefined
              ? { kind: "comment", id: activeComment ?? "" }
              : { kind: "draft", draft }
          }
          anchor={() =>
            document.querySelector(
              `[data-board-comment="${draft === undefined ? activeComment : "draft"}"]`,
            )
          }
          comments={comments.data ?? []}
          draftText={{ value: draftBody, set: setDraftBody }}
          readOnly={readOnly}
          people={people}
          dictation={readOnly ? undefined : dictation}
          threadId={threadId}
          artifactId={artifactId}
          onPosted={(id) => {
            setDraft(undefined);
            setDraftBody("");
            setActiveComment(id);
          }}
          onClose={() => {
            setDraft(undefined);
            setActiveComment(undefined);
          }}
        />
      )}
      <ConfirmDialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Rename Board"
        confirmLabel="Rename"
        confirmDisabled={newTitle.trim() === ""}
        onConfirm={() => {
          session.rename(newTitle);
          setRenaming(false);
        }}
      >
        <Input
          className="artifact-folder-input"
          aria-label="Title"
          value={newTitle}
          maxLength={200}
          onChange={(event) => setNewTitle(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && newTitle.trim() !== "") {
              event.preventDefault();
              session.rename(newTitle);
              setRenaming(false);
            }
          }}
        />
      </ConfirmDialog>
      {files.dialogs}
    </section>
  );
}
