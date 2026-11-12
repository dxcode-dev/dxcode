import { ARTIFACT_BOARDS_FEATURE, type ThreadArtifactKind } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { lazyRouteComponent } from "@tanstack/react-router";
import { FileText, type LucideIcon, Shapes } from "lucide-react";
import type * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import type { DictationSlot } from "../../shared/dictation/dictation-slot.js";
import { personalExperimentalFeaturesQueryOptions } from "../settings/experimental-features/experimental-features-queries.js";
import type { ArtifactDocument } from "./artifacts-api.js";

/** What every artifact type's editor receives from the Artifacts view. */
export interface ArtifactEditorProps {
  readonly threadId: ThreadId;
  readonly initial: ArtifactDocument;
  readonly readOnly: boolean;
  /** The header's switcher; given file actions for its menu. */
  readonly switcher: (items?: React.ReactNode) => React.ReactNode;
  readonly dictation?: DictationSlot | undefined;
}

/**
 * Each artifact type's place in the web app: how it is named and drawn in
 * lists, the flag it needs, and its editor, which loads only when an
 * artifact of that type opens. The server's half is
 * apps/core/src/thread-artifacts/kinds.ts. Adding a type (a flowchart, a mind
 * map) adds an entry here and there; the Artifacts view, its switcher, and
 * New … read this list.
 */
export interface ArtifactKindView {
  readonly kind: ThreadArtifactKind;
  /** Singular, in a sentence: "document", "board". */
  readonly noun: string;
  /** The create action: "New Document". */
  readonly newLabel: string;
  readonly icon: LucideIcon;
  /** The experimental flag a person needs to create and open it. */
  readonly feature?: string;
  readonly Editor: React.ComponentType<ArtifactEditorProps>;
}

// ProseMirror and the Markdown codec load only when a document opens.
const DocumentEditor = lazyRouteComponent(
  () => import("./editor/artifact-editor.js"),
  "ArtifactEditor",
);

/** Excalidraw's fonts ship with dx (the CSP allows no font CDN). */
const EXCALIDRAW_ASSETS = "/excalidraw/";

// Excalidraw (about 1 MB) loads only when a board opens.
const BoardEditor = lazyRouteComponent(() => {
  (window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
    `${window.location.origin}${EXCALIDRAW_ASSETS}`;
  return import("./board/board-editor.js");
}, "BoardEditor");

export const ARTIFACT_KIND_VIEWS: ReadonlyArray<ArtifactKindView> = [
  {
    kind: "document",
    noun: "document",
    newLabel: "New Document",
    icon: FileText,
    Editor: DocumentEditor as React.ComponentType<ArtifactEditorProps>,
  },
  {
    kind: "board",
    noun: "board",
    newLabel: "New Board",
    icon: Shapes,
    feature: ARTIFACT_BOARDS_FEATURE,
    Editor: BoardEditor as React.ComponentType<ArtifactEditorProps>,
  },
];

export const artifactKindView = (kind: ThreadArtifactKind): ArtifactKindView =>
  ARTIFACT_KIND_VIEWS.find((view) => view.kind === kind) ??
  (ARTIFACT_KIND_VIEWS[0] as ArtifactKindView);

/** The types this person may create and open: their flags are on. */
export const useEnabledArtifactKinds = () => {
  const { identity } = useAuthenticatedIdentity();
  const features = useQuery(
    personalExperimentalFeaturesQueryOptions(identity.id),
  );
  const on = new Set(
    (features.data?.flags ?? []).flatMap(
      ({ registration, effectiveEnabled }) =>
        effectiveEnabled ? [registration.id as string] : [],
    ),
  );
  return ARTIFACT_KIND_VIEWS.filter(
    (view) => view.feature === undefined || on.has(view.feature),
  );
};
