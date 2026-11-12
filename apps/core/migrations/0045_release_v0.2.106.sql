-- Artifact types. Every artifact so far is a Markdown document; a board is a
-- drawing board whose body is JSON in Excalidraw's element format (see
-- packages/domain/src/artifacts/board.ts). More types (flowcharts, mind
-- maps) add a value here and register themselves in
-- apps/core/src/thread-artifacts/kinds.ts and the web app's kinds registry.
-- Revisions, retention, comments, and sharing are the same for every type.
ALTER TABLE thread_artifact
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'document'
  CHECK (kind IN ('document', 'board'));

-- What a comment sits on in an artifact that is not text: a board shape's
-- id. Null for a document's comments, which sit on `quote`, and for a
-- board comment whose shape was deleted (it shows as detached).
ALTER TABLE thread_artifact_comment
  ADD COLUMN target TEXT CHECK (target IS NULL OR length(target) <= 128);

-- Huddle (experimental flag `huddle`): the RealtimeKit meeting each Thread's
-- huddle runs in. A Space's huddle is its own Thread's. The first person to
-- join creates the meeting; everyone after joins the same one, so the row is
-- written once and never changes. Deleting the Thread deletes the row; the
-- meeting stays on RealtimeKit, idle.
CREATE TABLE thread_huddles (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
