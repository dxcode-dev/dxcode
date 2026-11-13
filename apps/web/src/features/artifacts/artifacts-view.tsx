import type { ThreadArtifact, ThreadArtifactKind } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { Check, ChevronDown, FileText } from "lucide-react";
import * as React from "react";
import { useShowArtifact } from "../../shared/navigation/open-artifact.js";
import { Button } from "../../shared/ui/button.js";
import { EmptyState } from "../../shared/ui/empty-state.js";
import {
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuPopup,
  MenuRoot,
  MenuSeparator,
  MenuTrigger,
} from "../../shared/ui/menu.js";
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

const artifactLoading = (
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
    <MenuRoot>
      <MenuTrigger className="artifact-switcher" aria-label="Switch Artifact">
        <SelectedIcon aria-hidden="true" />
        <span>
          {selected === undefined
            ? "Artifacts"
            : selected.folder === ""
              ? selected.title
              : `${selected.folder} / ${selected.title}`}
        </span>
        <ChevronDown aria-hidden="true" />
      </MenuTrigger>
      <MenuPopup
        align="start"
        className="artifact-switcher-menu"
        aria-label="Artifacts"
      >
        {byFolder(artifacts).map(([folder, list]) => (
          <MenuGroup key={folder}>
            {folder === "" ? null : <MenuLabel>{folder}</MenuLabel>}
            {list.map((artifact) => {
              const Icon = artifactKindView(artifact.kind).icon;
              return (
                <MenuItem
                  key={artifact.id}
                  data-folder={folder === "" ? undefined : true}
                  data-kind={artifact.kind}
                  onClick={() => onSelect(artifact.id)}
                >
                  <Icon aria-hidden="true" />
                  <span>{artifact.title}</span>
                  {artifact.id === selected?.id ? (
                    <Check aria-hidden="true" />
                  ) : null}
                </MenuItem>
              );
            })}
          </MenuGroup>
        ))}
        {canCreate ? (
          <>
            {artifacts.length === 0 ? null : <MenuSeparator />}
            {creatable.map((view) => (
              <MenuItem key={view.kind} onClick={() => onCreate(view.kind)}>
                <view.icon aria-hidden="true" />
                <span>
                  {creatable.length > 1 ? view.newLabel : "New Artifact"}
                </span>
              </MenuItem>
            ))}
          </>
        ) : null}
        {extra}
      </MenuPopup>
    </MenuRoot>
  );
}

export function OpenArtifact({
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
          <EmptyState
            className="artifacts-state"
            tone="error"
            title={message(query.error)}
          />
        ) : (
          artifactLoading
        )}
      </section>
    );
  const view = artifactKindView(query.data.artifact.kind);
  return (
    <React.Suspense
      fallback={
        <section className="artifact-view">
          <header className="artifact-header">{switcher()}</header>
          {artifactLoading}
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
      <EmptyState
        className="artifacts-state"
        tone="error"
        title={message(list.error)}
      />
    ) : (
      artifactLoading
    );
  if (selected === undefined)
    return (
      <EmptyState
        className="artifacts-empty"
        icon={<FileText />}
        title="No artifacts yet. Ask the agent to write or draw one, or start a blank one."
        action={
          readOnly && !create.isError ? undefined : (
            <>
              {readOnly ? null : (
                <div className="artifacts-new-row">
                  {ARTIFACT_KIND_VIEWS.map((view, index) => (
                    <Button
                      key={view.kind}
                      size="sm"
                      variant={index === 0 ? "default" : "outline"}
                      className="artifacts-new"
                      disabled={create.isPending}
                      onClick={() => startBlank(view.kind)}
                    >
                      <view.icon aria-hidden="true" />
                      {view.newLabel}
                    </Button>
                  ))}
                </div>
              )}
              {create.isError ? (
                <p className="artifacts-error" role="alert">
                  {message(create.error)}
                </p>
              ) : null}
            </>
          )
        }
      />
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
