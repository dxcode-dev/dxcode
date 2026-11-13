import type { ThreadId } from "@dx/domain";
import { useParams } from "@tanstack/react-router";
import { ArtifactLibraryPage } from "./features/artifacts/library/artifact-library-page.js";
import { LibraryArtifactPage } from "./features/artifacts/library/library-artifact-page.js";
import { useThreadPresence } from "./features/threads/realtime/realtime-provider.js";

/** Joins the artifact's Thread so live edits and drawing reach this page. */
function ThreadPresence({ threadId }: { readonly threadId: ThreadId }) {
  useThreadPresence(threadId);
  return null;
}

const presence = (threadId: ThreadId) => (
  <ThreadPresence key={threadId} threadId={threadId} />
);

/** `/artifacts`: the Artifacts library. */
export function ArtifactLibraryRoute() {
  return <ArtifactLibraryPage />;
}

/**
 * `/artifacts/<id>`: one artifact, joined to its Thread's realtime presence
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
