import { useParams } from "@tanstack/react-router";
import { ArtifactLibraryPage } from "./features/artifacts/library/artifact-library-page.js";
import { LibraryArtifactPage } from "./features/artifacts/library/library-artifact-page.js";
import { useThreadPresence } from "./features/threads/realtime/realtime-provider.js";
import type { PresenceScope } from "./shared/realtime/presence-scope.js";

/**
 * Joins the artifact's Thread, or the standalone artifact itself, so live
 * edits and drawing reach this page.
 */
function ArtifactPresence({ scope }: { readonly scope: PresenceScope }) {
  useThreadPresence(scope);
  return null;
}

const presence = (scope: PresenceScope) => (
  <ArtifactPresence key={scope} scope={scope} />
);

/** `/artifacts`: the Artifacts library. */
export function ArtifactLibraryRoute() {
  return <ArtifactLibraryPage />;
}

/**
 * `/artifacts/<id>`: one artifact, joined to its realtime presence
 * here, at the application boundary, because features do not reach into
 * each other.
 */
export function LibraryArtifactRoute() {
  const { artifactId } = useParams({ from: "/_product/artifacts/$artifactId" });
  return (
    <LibraryArtifactPage
      key={artifactId}
      artifactId={artifactId}
      presence={presence}
    />
  );
}
