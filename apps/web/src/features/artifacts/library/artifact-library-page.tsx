import type {
  ArtifactFolder,
  ArtifactLibraryFilter,
  ArtifactLibraryItem,
  ThreadArtifactKind,
} from "@dx/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Bot,
  FileText,
  Folder,
  FolderPlus,
  Globe,
  Lock,
  MessageSquare,
  MoreHorizontal,
  Pin,
  Plus,
  Search,
  Shapes,
  User,
  Users,
} from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { DxLoading } from "../../../shared/brand/dx-loading.js";
import { PageShell } from "../../../shared/layout/page-shell.js";
import { Button } from "../../../shared/ui/button.js";
import { ConfirmDialog } from "../../../shared/ui/confirm-dialog.js";
import { EmptyState } from "../../../shared/ui/empty-state.js";
import { Input } from "../../../shared/ui/input.js";
import {
  MenuItem,
  MenuPopup,
  MenuRoot,
  MenuSeparator,
  MenuSubmenuRoot,
  MenuSubmenuTrigger,
  MenuTrigger,
} from "../../../shared/ui/menu.js";
import { SegmentedControl } from "../../../shared/ui/segmented-control.js";
import { TimeText } from "../../../shared/ui/time-text.js";
import { formatRelativeTime } from "../../../shared/utils.js";
import { ARTIFACT_KIND_VIEWS } from "../kinds.js";
import {
  artifactLibraryOptions,
  createStandaloneArtifactMutation,
  deleteFolderMutation,
  fileArtifactMutation,
  pinArtifactMutation,
  saveFolderMutation,
} from "./artifact-library-queries.js";
import "./artifact-library.css";

const FILTERS: ReadonlyArray<readonly [ArtifactLibraryFilter, string]> = [
  ["all", "All"],
  ["pinned", "Pinned"],
  ["mine", "Made by me"],
  ["agent", "Made by agent"],
  ["shared", "Shared with me"],
];

const EMPTY: Record<ArtifactLibraryFilter, string> = {
  all: "No artifacts yet",
  pinned: "Nothing pinned",
  mine: "You haven't made any artifacts",
  agent: "The agent hasn't made any artifacts",
  shared: "Nothing shared with you yet",
};

const updatedText = (updatedAt: number) => (now: number) =>
  formatRelativeTime({ epochMilliseconds: updatedAt }, now);

/** Who made it, from the reader's side: You, their name, or Agent. */
const creatorLabel = (item: ArtifactLibraryItem, userId: string) =>
  item.createdBy.kind === "agent"
    ? "Agent"
    : item.createdBy.userId === userId
      ? "You"
      : (item.createdBy.name ?? "A former member");

/** Where an artifact lives and who can see it, in a few words. */
function SourceLabel({
  item,
  userId,
}: {
  readonly item: ArtifactLibraryItem;
  readonly userId: string;
}) {
  if (item.source.kind !== "standalone")
    return (
      <small className="artifact-library-source" title={item.source.title}>
        <MessageSquare aria-hidden="true" />
        <span>{item.source.title}</span>
      </small>
    );
  const SharingIcon = item.sharing === "private" ? Lock : Globe;
  return (
    <small className="artifact-library-source">
      <SharingIcon aria-hidden="true" />
      <span>
        {item.owner.userId === userId
          ? item.sharing === "private"
            ? "Private"
            : item.sharing === "edit"
              ? "Workspace can edit"
              : "Workspace can view"
          : (item.owner.name ?? "A former member")}
      </span>
    </small>
  );
}

/** Pin and folder actions: the reader's own arrangement. */
function RowMenu({
  item,
  folders,
  onNewFolder,
}: {
  readonly item: ArtifactLibraryItem;
  readonly folders: ReadonlyArray<ArtifactFolder>;
  readonly onNewFolder: (artifactId: string) => void;
}) {
  const queryClient = useQueryClient();
  const pin = useMutation(pinArtifactMutation(queryClient, item.id));
  const file = useMutation(fileArtifactMutation(queryClient, item.id));
  return (
    <MenuRoot>
      <MenuTrigger
        render={
          <Button
            variant="subtle"
            size="icon-xs"
            className="artifact-library-row-menu"
            aria-label={`More for ${item.title}`}
          >
            <MoreHorizontal aria-hidden="true" />
          </Button>
        }
      />
      <MenuPopup align="end">
        <MenuItem onClick={() => pin.mutate(!item.pinned)}>
          <Pin aria-hidden="true" />
          <span>{item.pinned ? "Unpin" : "Pin"}</span>
        </MenuItem>
        <MenuSubmenuRoot>
          <MenuSubmenuTrigger>
            <Folder aria-hidden="true" />
            <span>Move to folder</span>
          </MenuSubmenuTrigger>
          <MenuPopup>
            {folders.map((folder) => (
              <MenuItem
                key={folder.id}
                disabled={folder.id === item.folderId}
                onClick={() => file.mutate(folder.id)}
              >
                <Folder aria-hidden="true" />
                <span>{folder.name}</span>
              </MenuItem>
            ))}
            {folders.length === 0 ? null : <MenuSeparator />}
            <MenuItem onClick={() => onNewFolder(item.id)}>
              <FolderPlus aria-hidden="true" />
              <span>New folder…</span>
            </MenuItem>
          </MenuPopup>
        </MenuSubmenuRoot>
        {item.folderId === null ? null : (
          <MenuItem onClick={() => file.mutate(null)}>
            <ArrowLeft aria-hidden="true" />
            <span>Remove from folder</span>
          </MenuItem>
        )}
      </MenuPopup>
    </MenuRoot>
  );
}

function LibraryRow({
  item,
  userId,
  folders,
  onNewFolder,
}: {
  readonly item: ArtifactLibraryItem;
  readonly userId: string;
  readonly folders: ReadonlyArray<ArtifactFolder>;
  readonly onNewFolder: (artifactId: string) => void;
}) {
  const Icon = item.kind === "board" ? Shapes : FileText;
  const creator = creatorLabel(item, userId);
  const CreatorIcon = item.createdBy.kind === "agent" ? Bot : User;
  return (
    <div className="artifact-library-row" data-kind={item.kind}>
      <Link
        className="artifact-library-row-link"
        to="/artifacts/$artifactId"
        params={{ artifactId: item.id }}
      >
        <span className="artifact-library-icon" aria-hidden="true">
          <Icon />
        </span>
        <span className="artifact-library-row-content">
          <strong>
            {item.pinned ? (
              <Pin className="artifact-library-pin" aria-label="Pinned" />
            ) : null}
            {item.title}
          </strong>
          <span className="artifact-library-meta">
            <small className="artifact-library-creator" title="Made by">
              <CreatorIcon aria-hidden="true" />
              <span>{creator}</span>
            </small>
            <SourceLabel item={item} userId={userId} />
            {item.access === "view" ? (
              <small className="artifact-library-badge">View only</small>
            ) : null}
            <small>
              <TimeText text={updatedText(item.updatedAt)} />
            </small>
          </span>
        </span>
      </Link>
      <RowMenu item={item} folders={folders} onNewFolder={onNewFolder} />
    </div>
  );
}

/** One of the reader's folders, at the top of All. */
function FolderRow({
  folder,
  count,
  onOpen,
  onRename,
  onDelete,
}: {
  readonly folder: ArtifactFolder;
  readonly count: number;
  readonly onOpen: () => void;
  readonly onRename: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <div className="artifact-library-row" data-kind="folder">
      <button
        type="button"
        className="artifact-library-row-link"
        onClick={onOpen}
      >
        <span className="artifact-library-icon" aria-hidden="true">
          <Folder />
        </span>
        <span className="artifact-library-row-content">
          <strong>{folder.name}</strong>
          <span className="artifact-library-meta">
            <small>{count === 1 ? "1 artifact" : `${count} artifacts`}</small>
          </span>
        </span>
      </button>
      <MenuRoot>
        <MenuTrigger
          render={
            <Button
              variant="subtle"
              size="icon-xs"
              className="artifact-library-row-menu"
              aria-label={`More for folder ${folder.name}`}
            >
              <MoreHorizontal aria-hidden="true" />
            </Button>
          }
        />
        <MenuPopup align="end">
          <MenuItem onClick={onRename}>Rename…</MenuItem>
          <MenuItem tone="danger" onClick={onDelete}>
            Delete folder…
          </MenuItem>
        </MenuPopup>
      </MenuRoot>
    </div>
  );
}

/** What the folder dialog is doing: making one (and filing an artifact), or renaming. */
type FolderDialog =
  | { readonly kind: "create"; readonly fileArtifactId?: string }
  | { readonly kind: "rename"; readonly folder: ArtifactFolder };

/** Name a new folder, or rename one. */
function FolderNameDialog({
  dialog,
  onClose,
}: {
  readonly dialog: FolderDialog;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = React.useState(
    dialog.kind === "rename" ? dialog.folder.name : "",
  );
  const fileId = dialog.kind === "create" ? dialog.fileArtifactId : undefined;
  const file = useMutation(fileArtifactMutation(queryClient, fileId ?? ""));
  const save = useMutation(
    saveFolderMutation(queryClient, (folder) => {
      if (fileId !== undefined) file.mutate(folder.id);
      onClose();
    }),
  );
  const trimmed = name.trim();
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={dialog.kind === "create" ? "New folder" : "Rename folder"}
      confirmLabel={dialog.kind === "create" ? "Create" : "Save"}
      confirmDisabled={trimmed.length === 0 || trimmed.length > 64}
      pending={save.isPending}
      error={save.error instanceof Error ? save.error.message : undefined}
      onConfirm={() =>
        save.mutate({
          name: trimmed,
          ...(dialog.kind === "rename" ? { folderId: dialog.folder.id } : {}),
        })
      }
    >
      <Input
        value={name}
        maxLength={64}
        onChange={(event) => setName(event.target.value)}
        aria-label="Folder name"
        placeholder="Folder name"
      />
    </ConfirmDialog>
  );
}

/**
 * `/artifacts`: every artifact the person may open. Their pins come first,
 * then what they made, newest save first. Filters pick pins, what they or
 * the agent made, or what others shared; All leaves out what the agent made
 * that no one has touched. Folders are the person's own, one level deep.
 */
export function ArtifactLibraryPage() {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [query, setQuery] = React.useState("");
  const search = React.useDeferredValue(query);
  const [filter, setFilter] = React.useState<ArtifactLibraryFilter>("all");
  const [openFolderId, setOpenFolderId] = React.useState<string>();
  const [folderDialog, setFolderDialog] = React.useState<FolderDialog>();
  const [deleting, setDeleting] = React.useState<ArtifactFolder>();
  const library = useQuery(artifactLibraryOptions(filter, search));
  const removeFolder = useMutation(deleteFolderMutation(queryClient));
  const create = useMutation(
    createStandaloneArtifactMutation(queryClient, (item) =>
      navigate({
        to: "/artifacts/$artifactId",
        params: { artifactId: item.id },
      }),
    ),
  );
  const items = library.data?.items ?? [];
  const folders = library.data?.folders ?? [];
  // Folders arrange All; a filter or a search lists everything flat.
  const arranged = filter === "all" && search.trim() === "";
  const openFolder = arranged
    ? folders.find((folder) => folder.id === openFolderId)
    : undefined;
  const visible = !arranged
    ? items
    : items.filter((item) => item.folderId === (openFolder?.id ?? null));
  const shownFolders = arranged && openFolder === undefined ? folders : [];
  const startBlank = (kind: ThreadArtifactKind) =>
    create.mutate({
      title: kind === "board" ? "Untitled board" : "Untitled",
      kind,
    });
  const newFolder = (fileArtifactId?: string) =>
    setFolderDialog(
      fileArtifactId === undefined
        ? { kind: "create" }
        : { kind: "create", fileArtifactId },
    );

  return (
    <PageShell
      title={
        <div className="artifact-library-title">
          <strong>Artifacts</strong>
        </div>
      }
      actions={
        <MenuRoot>
          <MenuTrigger
            render={
              <Button
                size="sm"
                aria-label="New artifact"
                disabled={create.isPending}
              >
                <Plus aria-hidden="true" />
                New
              </Button>
            }
          />
          <MenuPopup align="end" aria-label="New artifact">
            {ARTIFACT_KIND_VIEWS.map((view) => (
              <MenuItem key={view.kind} onClick={() => startBlank(view.kind)}>
                <view.icon aria-hidden="true" />
                <span>{view.newLabel}</span>
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem onClick={() => newFolder()}>
              <FolderPlus aria-hidden="true" />
              <span>Folder</span>
            </MenuItem>
          </MenuPopup>
        </MenuRoot>
      }
      contentClassName="artifact-library-content"
    >
      <aside className="artifact-library-pane" aria-label="Find artifacts">
        <div className="artifact-library-search">
          <Search aria-hidden="true" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by title"
            aria-label="Search artifacts by title"
          />
        </div>
        <SegmentedControl
          className="artifact-library-filter"
          label="Show"
          orientation="vertical"
          value={filter}
          onValueChange={(next) => {
            setFilter(next);
            setOpenFolderId(undefined);
          }}
          options={FILTERS}
        />
        <p className="artifact-library-hint">
          <Users aria-hidden="true" />
          New artifacts are private until you share them with your workspace.
        </p>
      </aside>

      <section
        className="artifact-library-list"
        aria-label={
          openFolder?.name ??
          FILTERS.find(([value]) => value === filter)?.[1] ??
          "Artifacts"
        }
        aria-busy={library.isPending}
      >
        {openFolder === undefined ? null : (
          <div className="artifact-library-folder-header">
            <Button
              variant="subtle"
              size="icon-xs"
              aria-label="Back to all artifacts"
              onClick={() => setOpenFolderId(undefined)}
            >
              <ArrowLeft aria-hidden="true" />
            </Button>
            <Folder aria-hidden="true" />
            <strong>{openFolder.name}</strong>
          </div>
        )}
        {create.isError ? (
          <p className="artifact-library-error" role="alert">
            {create.error instanceof Error
              ? create.error.message
              : "The artifact could not be created."}
          </p>
        ) : null}
        {library.isPending ? <DxLoading label="Loading artifacts…" /> : null}
        {library.isError && library.data === undefined ? (
          <EmptyState
            tone="error"
            title="Artifacts unavailable"
            description={
              library.error instanceof Error
                ? library.error.message
                : "Artifacts could not be loaded."
            }
            action={
              <Button
                size="xs"
                variant="outline"
                onClick={() => void library.refetch()}
              >
                Retry
              </Button>
            }
          />
        ) : null}
        {library.data !== undefined &&
        visible.length === 0 &&
        shownFolders.length === 0 ? (
          <EmptyState
            icon={<FileText />}
            title={
              search.trim() !== ""
                ? "No artifacts match"
                : openFolder !== undefined
                  ? "This folder is empty"
                  : EMPTY[filter]
            }
            description={
              search.trim() !== ""
                ? "Try another title."
                : openFolder !== undefined
                  ? "Move artifacts here from their ⋯ menu."
                  : filter === "all"
                    ? "Start a document or a board with New, or ask an agent to write one."
                    : undefined
            }
          />
        ) : null}
        {shownFolders.map((folder) => (
          <FolderRow
            key={folder.id}
            folder={folder}
            count={items.filter((item) => item.folderId === folder.id).length}
            onOpen={() => setOpenFolderId(folder.id)}
            onRename={() => setFolderDialog({ kind: "rename", folder })}
            onDelete={() => setDeleting(folder)}
          />
        ))}
        {visible.map((item) => (
          <LibraryRow
            key={item.id}
            item={item}
            userId={identity.id}
            folders={folders}
            onNewFolder={newFolder}
          />
        ))}
      </section>
      {folderDialog === undefined ? null : (
        <FolderNameDialog
          key={
            folderDialog.kind === "rename" ? folderDialog.folder.id : "create"
          }
          dialog={folderDialog}
          onClose={() => setFolderDialog(undefined)}
        />
      )}
      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
        title={`Delete folder ${deleting?.name ?? ""}?`}
        description="Its artifacts stay in your library. Only the folder goes."
        confirmLabel="Delete"
        destructive
        pending={removeFolder.isPending}
        onConfirm={() => {
          if (deleting === undefined) return;
          removeFolder.mutate(deleting.id, {
            onSuccess: () => {
              if (openFolderId === deleting.id) setOpenFolderId(undefined);
              setDeleting(undefined);
            },
          });
        }}
      />
    </PageShell>
  );
}
