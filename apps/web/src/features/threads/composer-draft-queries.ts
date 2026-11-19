import type { WorkspaceDraftSlot } from "@dx/api";
import type { ThreadId, WorkspaceId } from "@dx/domain";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import {
  type DraftAddress,
  flushUnsavedThreadDrafts,
  threadDraftKeys,
  threadDraftValue,
} from "./thread-draft-queries.js";

/**
 * The signed-in person's draft in one composer, and its setter: what a box
 * that owns its text holds instead of component state, so the text survives
 * leaving the page, a reload, and another device. Loads from Core. Without
 * an address (a box with no Thread, such as on a standalone artifact) it
 * lasts as long as the component.
 */
export function useComposerDraft(address: DraftAddress | undefined) {
  const client = useQueryClient();
  const { identity } = useAuthenticatedIdentity();
  const [local, setLocal] = React.useState("");
  const value =
    address === undefined
      ? undefined
      : threadDraftValue(client, identity.id, address);
  const saved = React.useSyncExternalStore(
    value?.subscribe ?? noSubscription,
    value?.get ?? noText,
    value?.get ?? noText,
  );
  const set = (next: string | ((current: string) => string)) => {
    if (value === undefined) {
      setLocal(next);
      return;
    }
    value.set(typeof next === "function" ? next(value.get()) : next);
  };
  return [value === undefined ? local : saved, set] as const;
}

const noSubscription = () => () => {};
const noText = () => "";

/**
 * The person's New Thread or New Space draft in a workspace, as the New
 * Thread store reads it: with whether Core's text has arrived.
 */
export function useWorkspaceDraftText(
  workspace: WorkspaceId | "personal",
  slot: WorkspaceDraftSlot,
) {
  const client = useQueryClient();
  const { identity } = useAuthenticatedIdentity();
  const address = { workspace, slot } as const;
  const value = threadDraftValue(client, identity.id, address);
  const queryKey = threadDraftKeys.draft(identity.id, address);
  return {
    ...value,
    loaded: () => client.getQueryData(queryKey) !== undefined,
    flush: flushUnsavedThreadDrafts,
  };
}

/**
 * Where a Thread artifact's comment box keeps its draft: a new comment's, one
 * per artifact, or a reply's, one per comment. A standalone artifact
 * (`artifact:<id>` scope) has no Thread, so its boxes keep none.
 */
export const artifactCommentDraftAddress = (
  scope: string,
  box: { readonly artifactId: string } | { readonly replyTo: string },
): DraftAddress | undefined =>
  scope.startsWith("artifact:")
    ? undefined
    : {
        threadId: scope as ThreadId,
        slot:
          "artifactId" in box
            ? `artifact-comment:${box.artifactId}`
            : `artifact-reply:${box.replyTo}`,
      };
