import { Menu } from "@base-ui/react/menu";
import type { ThreadArtifact, ThreadArtifactKind } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { Check, ChevronDown, FileText } from "lucide-react";
import * as React from "react";
import { useShowArtifact } from "../../shared/navigation/open-artifact.js";
import {
  artifactListOptions,
  artifactOptions,
  createArtifactMutation,
} from "./artifact-document-queries.js";
import {
  ARTIFACT_KIND_VIEWS,
  type ArtifactKindView,
  artifactKindView,
} from "./kinds.js";
import "./artifacts-view.css";
import type { DictationSlot } from "../../shared/dictation/dictation-slot.js";

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
  creatable,
  canCreate,
  extra,
}: {
  readonly artifacts: ReadonlyArray<ThreadArtifact>;
  readonly selected: ThreadArtifact | undefined;
  readonly onSelect: (artifactId: string) => void;
  readonly onCreate: (kind: ThreadArtifactKind) => void;
  /** The types this person may create. */
  readonly creatable: ReadonlyArray<ArtifactKindView>;
  readonly canCreate: boolean;
  /** The open artifact's file actions, from the editor. */
  readonly extra?: React.ReactNode;
}) {
  const SelectedIcon =
    selected === undefined ? FileText : artifactKindView(selected.kind).icon;
  return (
    <Menu.Root>
      <Menu.Trigger className="artifact-switcher" aria-label="Switch Artifact">
        <SelectedIcon aria-hidden="true" />
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
                {list.map((artifact) => {
                  const Icon = artifactKindView(artifact.kind).icon;
                  return (
                    <Menu.Item
                      key={artifact.id}
                      className="thread-menu-item"
                      data-folder={folder === "" ? undefined : true}
                      data-kind={artifact.kind}
                      onClick={() => onSelect(artifact.id)}
                    >
                      <Icon
                        className="artifact-switcher-kind"
                        aria-hidden="true"
                      />
                      <span className="artifact-switcher-title">
                        {artifact.title}
                      </span>
                      {artifact.id === selected?.id ? (
                        <Check aria-hidden="true" />
                      ) : null}
                    </Menu.Item>
                  );
                })}
              </Menu.Group>
            ))}
            {canCreate ? (
              <>
                {artifacts.length === 0 ? null : (
                  <Menu.Separator className="thread-menu-separator" />
                )}
                {creatable.map((view) => (
                  <Menu.Item
                    key={view.kind}
                    className="thread-menu-item"
                    onClick={() => onCreate(view.kind)}
                  >
                    <view.icon aria-hidden="true" />
                    {creatable.length > 1 ? view.newLabel : "New Artifact"}
                  </Menu.Item>
                ))}
              </>
            ) : null}
            {extra}
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
  readonly switcher: (extra?: React.ReactNode) => React.ReactNode;
  readonly dictation: DictationSlot | undefined;
}) {
  const query = useQuery(artifactOptions(threadId, artifactId, active));
  if (query.data === undefined)
    return (
      <section className="artifact-view">
        <header className="artifact-header">{switcher()}</header>
        {query.isError ? (
          <div className="artifacts-state" role="alert">
            {message(query.error)}
          </div>
        ) : (
          loading
        )}
      </section>
    );
  const view = artifactKindView(query.data.artifact.kind);
  return (
    <React.Suspense
      fallback={
        <section className="artifact-view">
          <header className="artifact-header">{switcher()}</header>
          {loading}
        </section>
      }
    >
      <view.Editor
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
  const startBlank = (kind: ThreadArtifactKind) =>
    create.mutate({
      title: kind === "board" ? "Untitled board" : "Untitled",
      kind,
    });
  const switcher = (extra?: React.ReactNode) => (
    <ArtifactSwitcher
      artifacts={artifacts}
      selected={selected}
      onSelect={openArtifact}
      onCreate={startBlank}
      creatable={ARTIFACT_KIND_VIEWS}
      canCreate={!readOnly && !create.isPending}
      extra={extra}
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
          No artifacts yet. Ask the agent to write or draw one, or start a blank
          one.
        </p>
        {readOnly ? null : (
          <div className="artifacts-new-row">
            {ARTIFACT_KIND_VIEWS.map((view) => (
              <button
                key={view.kind}
                type="button"
                className="artifacts-new"
                disabled={create.isPending}
                onClick={() => startBlank(view.kind)}
              >
                <view.icon aria-hidden="true" />
                {view.newLabel}
              </button>
            ))}
          </div>
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
