import type { TranscriptViewModel } from "@dx/client";
import {
  SERVER_TRANSCRIPT_FEATURE_ID,
  type ThreadId,
  type UserId,
} from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { useIdentity } from "../../shared/auth/auth-context.js";
import { personalExperimentalFeaturesQueryOptions } from "../settings/experimental-features/experimental-features-queries.js";
import { createServerTranscriptShadow } from "./server-transcript-shadow-store.js";

/**
 * Compares the server's transcript items with the web's own model while the
 * person has the `server-transcript` experimental feature on. It renders
 * nothing: the transcript always comes from the web's projection. Loaded
 * lazily, after the transcript has painted.
 */
export function ServerTranscriptShadow({
  threadId,
  localModel,
}: {
  readonly threadId: ThreadId;
  readonly localModel: () => TranscriptViewModel;
}) {
  // Never throws: a page without a signed-in person compares nothing.
  const auth = useIdentity();
  return auth === undefined ? null : (
    <ShadowWhenOn
      userId={auth.identity.id}
      threadId={threadId}
      localModel={localModel}
    />
  );
}

function ShadowWhenOn({
  userId,
  threadId,
  localModel,
}: {
  readonly userId: UserId;
  readonly threadId: ThreadId;
  readonly localModel: () => TranscriptViewModel;
}) {
  const features = useQuery(personalExperimentalFeaturesQueryOptions(userId));
  const on =
    features.data?.flags.some(
      (flag) =>
        flag.registration.id === SERVER_TRANSCRIPT_FEATURE_ID &&
        flag.effectiveEnabled,
    ) === true;
  return on ? (
    <ShadowStream key={threadId} threadId={threadId} localModel={localModel} />
  ) : null;
}

function ShadowStream({
  threadId,
  localModel,
}: {
  readonly threadId: ThreadId;
  readonly localModel: () => TranscriptViewModel;
}) {
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
