import type { TranscriptViewModel } from "@dx/client";
import type { ThreadId } from "@dx/domain";
import * as React from "react";
import { createServerTranscriptShadow } from "./server-transcript-shadow-store.js";

/**
 * Compares the server's transcript items with the web's own model. The
 * agent panel renders it only for a person with the `server-transcript`
 * experimental feature on, from the settings context; it renders nothing
 * itself: the transcript always comes from the web's projection.
 */
export function ShadowStream({
  threadId,
  localModel,
}: {
  readonly threadId: ThreadId;
  readonly localModel: () => TranscriptViewModel;
}): React.ReactNode {
  const [shadow] = React.useState(() =>
    createServerTranscriptShadow(threadId, localModel),
  );
  const report = React.useSyncExternalStore(
    shadow.subscribe,
    shadow.getSnapshot,
    shadow.getSnapshot,
  );
  return (
    <span
      hidden
      data-transcript-shadow={report.connected ? "connected" : "idle"}
      data-transcript-shadow-differences={report.differences.length}
    />
  );
}
