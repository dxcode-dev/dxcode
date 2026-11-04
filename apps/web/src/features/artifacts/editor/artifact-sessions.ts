/**
 * Editor sessions outlive the editor's view. Moving the Artifacts tab to
 * another pane, splitting, opening the phone sheet, or switching tabs
 * unmounts the editor and mounts a new one; the new one takes the session the
 * old one left, so the document, the caret, undo history, unsaved edits, and
 * an open `/` or `@` menu carry on instead of reloading from Markdown.
 *
 * Sessions are kept per QueryClient (so a sign-out or a test starts clean),
 * per Thread and artifact. A session no view has taken back within
 * `RELEASED_FOR` is let go, saving what it holds first.
 */
import type { ThreadId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import type { ArtifactDocument } from "../artifacts-api.js";
import { ArtifactSession } from "./artifact-session.js";

const RELEASED_FOR = 10 * 60_000;

interface Entry {
  readonly session: ArtifactSession;
  /** Letting the session go, while no view has it. */
  timer: ReturnType<typeof setTimeout> | undefined;
}

const byClient = new WeakMap<QueryClient, Map<string, Entry>>();

const keyOf = (threadId: ThreadId, artifactId: string) =>
  `${threadId}\n${artifactId}`;

const entriesOf = (queryClient: QueryClient) => {
  let entries = byClient.get(queryClient);
  if (entries === undefined) {
    entries = new Map();
    byClient.set(queryClient, entries);
  }
  return entries;
};

const letGo = (entries: Map<string, Entry>, key: string, entry: Entry) => {
  if (entry.timer !== undefined) clearTimeout(entry.timer);
  entry.timer = setTimeout(() => {
    if (entries.get(key) !== entry || entry.session.attached) return;
    entries.delete(key);
    entry.session.dispose();
  }, RELEASED_FOR);
};

/**
 * The session for an artifact: the one a previous view left, else a new one.
 * Two editors of one artifact on screen at once share it, and show the same.
 */
export const artifactSessionFor = (
  queryClient: QueryClient,
  options: Omit<
    ConstructorParameters<typeof ArtifactSession>[0],
    "queryClient"
  >,
): ArtifactSession => {
  const entries = entriesOf(queryClient);
  const key = keyOf(options.threadId, options.initial.artifact.id);
  // A moved pane renders its new editor before the old one unmounts, so the
  // session may still be shown; both views share it until the old one goes.
  const kept = entries.get(key);
  if (kept !== undefined) return kept.session;
  const session = new ArtifactSession({ ...options, queryClient });
  const entry: Entry = { session, timer: undefined };
  entries.set(key, entry);
  // Let go if no view ever takes it (a render React discarded).
  letGo(entries, key, entry);
  return session;
};

/** A view took the session: keep it. */
export const holdArtifactSession = (
  queryClient: QueryClient,
  threadId: ThreadId,
  initial: ArtifactDocument,
  session: ArtifactSession,
) => {
  const entry = entriesOf(queryClient).get(
    keyOf(threadId, initial.artifact.id),
  );
  if (entry?.session !== session || entry.timer === undefined) return;
  clearTimeout(entry.timer);
  entry.timer = undefined;
};

/** The view let the session go: keep it a while for the next view. */
export const releaseArtifactSession = (
  queryClient: QueryClient,
  threadId: ThreadId,
  initial: ArtifactDocument,
  session: ArtifactSession,
) => {
  const entries = entriesOf(queryClient);
  const key = keyOf(threadId, initial.artifact.id);
  const entry = entries.get(key);
  if (entry?.session === session && !session.attached)
    letGo(entries, key, entry);
};
