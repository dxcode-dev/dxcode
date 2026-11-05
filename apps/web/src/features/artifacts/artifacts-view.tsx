import { Menu } from "@base-ui/react/menu";
import type { ThreadArtifact } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazyRouteComponent, useSearch } from "@tanstack/react-router";
import { Check, ChevronDown, FileText, Plus } from "lucide-react";
import * as React from "react";
import { useShowArtifact } from "../../shared/navigation/open-artifact.js";
import {
  artifactListOptions,
  artifactOptions,
  createArtifactMutation,
} from "./artifact-document-queries.js";
import "./artifacts-view.css";
import type { DictationSlot } from "../../shared/dictation/dictation-slot.js";

// ProseMirror and the Markdown codec load only when an artifact opens, so
// the Thread page's first load does not grow. `lazyRouteComponent` reloads
// the page once if a deploy removed the chunk.
const ArtifactEditor = lazyRouteComponent(
  () => import("./editor/artifact-editor.js"),
  "ArtifactEditor",
);

const loading = (
  <div className="artifacts-state" role="status">
    <FileText className="workspace-loading-glyph" aria-hidden="true" />
    <span className="sr-only">Loading artifacts…</span>
  </div>
);

const message = (error: unknown) =>
  error instanceof Error ? error.message : "Artifacts are unavailable.";

/** Artifacts by folder: top level first, then each folder by name. */
const byFolder = (artifacts: ReadonlyArray<ThreadArtifact>) => {
  const folders = new Map<string, ThreadArtifact[]>();
  for (const artifact of artifacts) {
    const list = folders.get(artifact.folder) ?? [];
    list.push(artifact);
    folders.set(artifact.folder, list);
  }
  return [...folders.entries()].sort(([a], [b]) =>
    a === "" ? -1 : b === "" ? 1 : a.localeCompare(b),
  );
};

function ArtifactSwitcher({
  artifacts,
  selected,
  onSelect,
  onCreate,
  canCreate,
}: {
  readonly artifacts: ReadonlyArray<ThreadArtifact>;
  readonly selected: ThreadArtifact | undefined;
  readonly onSelect: (artifactId: string) => void;
  readonly onCreate: () => void;
  readonly canCreate: boolean;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger className="artifact-switcher" aria-label="Switch Artifact">
        <FileText aria-hidden="true" />
        <span>
          {selected === undefined
            ? "Artifacts"
            : selected.folder === ""
              ? selected.title
              : `${selected.folder} / ${selected.title}`}
        </span>
        <ChevronDown aria-hidden="true" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="thread-menu-positioner"
          align="start"
          sideOffset={4}
        >
          <Menu.Popup
            className="thread-menu-popup thread-actions-menu artifact-switcher-menu"
            aria-label="Artifacts"
          >
            {byFolder(artifacts).map(([folder, list]) => (
              <Menu.Group key={folder}>
                {folder === "" ? null : (
                  <Menu.GroupLabel className="artifact-folder-label">
                    {folder}
                  </Menu.GroupLabel>
                )}
                {list.map((artifact) => (
                  <Menu.Item
                    key={artifact.id}
                    className="thread-menu-item"
                    data-folder={folder === "" ? undefined : true}
                    onClick={() => onSelect(artifact.id)}
                  >
                    <span className="artifact-switcher-title">
                      {artifact.title}
                    </span>
                    {artifact.id === selected?.id ? (
                      <Check aria-hidden="true" />
                    ) : null}
                  </Menu.Item>
                ))}
              </Menu.Group>
            ))}
            {canCreate ? (
              <>
                {artifacts.length === 0 ? null : (
                  <Menu.Separator className="thread-menu-separator" />
                )}
                <Menu.Item className="thread-menu-item" onClick={onCreate}>
                  <Plus aria-hidden="true" />
                  New Artifact
                </Menu.Item>
              </>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function OpenArtifact({
  threadId,
  artifactId,
  active,
  readOnly,
  switcher,
  dictation,
}: {
  readonly threadId: ThreadId;
  readonly artifactId: string;
  readonly active: boolean;
  readonly readOnly: boolean;
  readonly switcher: React.ReactNode;
  readonly dictation: DictationSlot | undefined;
}) {
  const query = useQuery(artifactOptions(threadId, artifactId, active));
  if (query.data === undefined)
    return (
      <section className="artifact-view">
        <header className="artifact-header">{switcher}</header>
        {query.isError ? (
          <div className="artifacts-state" role="alert">
            {message(query.error)}
          </div>
        ) : (
          loading
        )}
      </section>
    );
  return (
    <React.Suspense
      fallback={
        <section className="artifact-view">
          <header className="artifact-header">{switcher}</header>
          {loading}
        </section>
      }
    >
      <ArtifactEditor
        threadId={threadId}
        initial={query.data}
        readOnly={readOnly}
        switcher={switcher}
        dictation={dictation}
      />
    </React.Suspense>
  );
}

/**
 * The Thread's Artifacts view: the artifact in the `artifact` search
 * parameter (else the newest), its switcher, and an empty state.
 */
export function ArtifactsView({
  threadId,
  active,
  readOnly,
  dictation,
}: {
  readonly threadId: ThreadId;
  readonly active: boolean;
  readonly readOnly: boolean;
  /** The composer's mic, when the Thread page offers dictation. */
  readonly dictation?: DictationSlot | undefined;
}) {
  const queryClient = useQueryClient();
  const requested = useSearch({
    strict: false,
    select: (search: { readonly artifact?: string }) => search.artifact,
  });
  const openArtifact = useShowArtifact();
  const list = useQuery(artifactListOptions(threadId, active));
  const create = useMutation(
    createArtifactMutation(queryClient, threadId, (created) =>
      openArtifact(created.artifact.id),
    ),
  );
  const artifacts = list.data ?? [];
  // Without an `artifact` parameter the view keeps showing the artifact it
  // first chose, even when another one becomes the newest.
  const [pinned, setPinned] = React.useState<string>();
  const selected =
    artifacts.find((artifact) => artifact.id === requested) ??
    artifacts.find((artifact) => artifact.id === pinned) ??
    artifacts[0];
  if (
    selected !== undefined &&
    selected.id !== requested &&
    selected.id !== pinned
  )
    setPinned(selected.id);
  const startBlank = () => create.mutate({ title: "Untitled" });
  const switcher = (
    <ArtifactSwitcher
      artifacts={artifacts}
      selected={selected}
      onSelect={openArtifact}
      onCreate={startBlank}
      canCreate={!readOnly && !create.isPending}
    />
  );
  if (list.data === undefined)
    return list.isError ? (
      <div className="artifacts-state" role="alert">
        {message(list.error)}
      </div>
    ) : (
      loading
    );
  if (selected === undefined)
    return (
      <div className="artifacts-empty">
        <FileText aria-hidden="true" />
        <p>
          No artifacts yet. Ask the agent to write one, or start a blank
          artifact.
        </p>
        {readOnly ? null : (
          <button
            type="button"
            className="artifacts-new"
            disabled={create.isPending}
            onClick={startBlank}
          >
            <Plus aria-hidden="true" />
            New Artifact
          </button>
        )}
        {create.isError ? (
          <p className="artifacts-error" role="alert">
            {message(create.error)}
          </p>
        ) : null}
      </div>
    );
  return (
    <OpenArtifact
      key={`${selected.id}:${readOnly}`}
      threadId={threadId}
      artifactId={selected.id}
      active={active}
      readOnly={readOnly}
      switcher={switcher}
      dictation={dictation}
    />
  );
}
