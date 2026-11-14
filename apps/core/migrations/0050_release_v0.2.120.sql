-- Agents no longer ask people in a "Plan" artifact: the request_attention
-- tool is gone, and asks go in the agent's reply. Each Plan artifact it made
-- holds only such asks. Delete the ones nobody engaged with: made by the
-- agent, never edited or commented on by a person, and with no open ask.
-- The rows stay with `deleted_at` set; the artifact sweep removes their
-- bodies, as it does for any deleted artifact.
UPDATE thread_artifact
   SET deleted_at = CAST(unixepoch('subsec') * 1000 AS INTEGER)
 WHERE deleted_at IS NULL
   AND created_by_kind = 'agent'
   AND kind = 'document'
   AND folder = ''
   AND lower(title) = 'plan'
   AND NOT EXISTS (
     SELECT 1 FROM thread_artifact_revision AS revision
      WHERE revision.artifact_id = thread_artifact.id
        AND revision.author_kind = 'user')
   AND NOT EXISTS (
     SELECT 1 FROM thread_artifact_comment AS comment
      WHERE comment.artifact_id = thread_artifact.id
        AND comment.author_kind = 'user')
   AND NOT EXISTS (
     SELECT 1 FROM thread_artifact_ask AS ask
      WHERE ask.artifact_id = thread_artifact.id)
   AND NOT EXISTS (
     SELECT 1 FROM thread_open_ask AS open_ask
      WHERE open_ask.artifact_id = thread_artifact.id);

-- Who an artifact is for. 'people' (the default) lists for everyone who can
-- open its Thread. 'agent' is the agent's own notes on long-running work:
-- people's artifact lists and the Artifacts library leave it out unless a
-- person chooses to show agent notes. It is not secret: anyone who can open
-- the Thread can still read it.
ALTER TABLE thread_artifact ADD COLUMN audience TEXT NOT NULL DEFAULT 'people'
  CHECK (audience IN ('people', 'agent'));

-- Standalone artifacts without a Thread. An artifact made from the
-- Artifacts library (or by the agent with `standalone: true`) belongs
-- directly to its owner: `thread_id` is NULL and `owner_user_id` names the
-- owner. Its sharing is its own: `workspace_access` ('none', 'view', or
-- 'edit') with `shared_workspace_id`, the owner's workspace. A Thread's
-- artifacts keep `thread_id`, no owner, and no sharing of their own; they
-- share with their Thread. Revision bodies of a standalone artifact live at
-- standalone-artifacts/<artifact>/<revision>-<sha256>.md and its images
-- under standalone-artifacts/<artifact>/images/.
--
-- Until now each standalone artifact lived in a hidden "artifact home"
-- Thread (0189). Their artifacts become standalone here, keeping the
-- home's sharing, and the homes are deleted. R2 cannot move in SQL, so
-- `standalone_artifact_move` lists each one whose bodies and images still
-- sit under its old home; the minute sweep moves them and deletes the row
-- (apps/core/src/artifact-library/moves.ts).
--
-- SQLite cannot make a column nullable in place, and D1 cannot disable
-- foreign keys, so the artifact table and every table that references it
-- are rebuilt, as 0067 rebuilt the Thread family: renamed aside (which
-- rewrites the foreign keys between them, so the old family stays
-- self-consistent), recreated, copied, then dropped leaf-first.
PRAGMA defer_foreign_keys = on;

-- The account-deletion triggers name these tables; they are recreated below.
DROP TRIGGER IF EXISTS thread_artifact_account_deleted;
DROP TRIGGER IF EXISTS thread_artifact_ask_account_deleted;

ALTER TABLE thread_artifact RENAME TO thread_artifact_0191;
ALTER TABLE thread_artifact_revision RENAME TO thread_artifact_revision_0191;
ALTER TABLE thread_artifact_comment RENAME TO thread_artifact_comment_0191;
ALTER TABLE thread_artifact_ask RENAME TO thread_artifact_ask_0191;
ALTER TABLE thread_open_ask RENAME TO thread_open_ask_0191;

CREATE TABLE thread_artifact (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND substr(id, 1, 4) = 'art_'),
  thread_id TEXT REFERENCES threads (id) ON DELETE CASCADE,
  owner_user_id TEXT,
  shared_workspace_id TEXT,
  workspace_access TEXT NOT NULL DEFAULT 'none'
    CHECK (workspace_access IN ('none', 'view', 'edit')),
  folder TEXT NOT NULL DEFAULT ''
    CHECK (length(folder) <= 64 AND instr(folder, '/') = 0),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  current_revision INTEGER NOT NULL CHECK (current_revision >= 1),
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  stored_bytes INTEGER NOT NULL CHECK (stored_bytes >= 0),
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('user', 'agent')),
  created_by_user_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  kind TEXT NOT NULL DEFAULT 'document' CHECK (kind IN ('document', 'board')),
  audience TEXT NOT NULL DEFAULT 'people'
    CHECK (audience IN ('people', 'agent')),
  -- In a Thread, or standalone with an owner: never both, never neither.
  CHECK ((thread_id IS NULL) != (owner_user_id IS NULL)),
  -- Only a standalone artifact has sharing of its own.
  CHECK (thread_id IS NULL OR (workspace_access = 'none' AND shared_workspace_id IS NULL)),
  CHECK (workspace_access = 'none' OR shared_workspace_id IS NOT NULL)
);

CREATE TABLE thread_artifact_revision (
  artifact_id TEXT NOT NULL REFERENCES thread_artifact (id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  base_revision INTEGER,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'agent')),
  author_user_id TEXT,
  submission_id TEXT CHECK (submission_id IS NULL OR length(submission_id) <= 128),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 0 AND 2097152),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, revision)
) WITHOUT ROWID;

CREATE TABLE thread_artifact_comment (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND substr(id, 1, 4) = 'cmt_'),
  artifact_id TEXT NOT NULL REFERENCES thread_artifact (id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES thread_artifact_comment (id) ON DELETE CASCADE,
  quote TEXT NOT NULL CHECK (length(quote) <= 1000),
  anchor_revision INTEGER,
  anchor_start INTEGER,
  anchor_end INTEGER,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'agent')),
  author_user_id TEXT,
  submission_id TEXT CHECK (submission_id IS NULL OR length(submission_id) <= 128),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  target TEXT CHECK (target IS NULL OR length(target) <= 128)
);

-- Asks and open-ask markers belong to Thread artifacts only.
CREATE TABLE thread_artifact_ask (
  artifact_id TEXT NOT NULL REFERENCES thread_artifact (id) ON DELETE CASCADE,
  item_key TEXT NOT NULL CHECK (length(item_key) = 64),
  mentioned_user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) <= 500),
  line INTEGER NOT NULL CHECK (line >= 1),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  waiting_since INTEGER NOT NULL,
  PRIMARY KEY (artifact_id, item_key, mentioned_user_id)
) WITHOUT ROWID;

CREATE TABLE thread_open_ask (
  artifact_id TEXT PRIMARY KEY REFERENCES thread_artifact (id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- A home's artifact becomes standalone with the home's owner and sharing:
-- Contribute (which never ended for a home) is edit.
INSERT INTO thread_artifact
  (id, thread_id, owner_user_id, shared_workspace_id, workspace_access,
   folder, title, current_revision, size_bytes, stored_bytes,
   created_by_kind, created_by_user_id, created_at, updated_at, deleted_at,
   kind, audience)
SELECT artifact.id,
       CASE WHEN home.id IS NULL THEN artifact.thread_id END ,
       home.owner_user_id,
       CASE WHEN home.workspace_access IN ('view', 'contribute')
            THEN home.shared_workspace_id END ,
       CASE WHEN home.shared_workspace_id IS NULL THEN 'none'
            WHEN home.workspace_access = 'contribute' THEN 'edit'
            WHEN home.workspace_access = 'view' THEN 'view'
            ELSE 'none' END ,
       CASE WHEN home.id IS NULL THEN artifact.folder ELSE '' END ,
       artifact.title, artifact.current_revision, artifact.size_bytes,
       artifact.stored_bytes, artifact.created_by_kind,
       artifact.created_by_user_id, artifact.created_at, artifact.updated_at,
       artifact.deleted_at, artifact.kind, artifact.audience
  FROM thread_artifact_0191 AS artifact
  LEFT JOIN threads AS home
    ON home.id = artifact.thread_id AND home.artifact_home = 1;

INSERT INTO thread_artifact_revision SELECT * FROM thread_artifact_revision_0191;

INSERT INTO thread_artifact_comment
  (id, artifact_id, parent_id, quote, anchor_revision, anchor_start,
   anchor_end, author_kind, author_user_id, submission_id, body, created_at,
   resolved_at, target)
SELECT id, artifact_id, parent_id, quote, anchor_revision, anchor_start,
       anchor_end, author_kind, author_user_id, submission_id, body,
       created_at, resolved_at, target
  FROM thread_artifact_comment_0191;

INSERT INTO thread_artifact_ask
SELECT ask.* FROM thread_artifact_ask_0191 AS ask
  JOIN thread_artifact AS artifact ON artifact.id = ask.artifact_id
 WHERE artifact.thread_id IS NOT NULL;

INSERT INTO thread_open_ask
SELECT marker.* FROM thread_open_ask_0191 AS marker
  JOIN thread_artifact AS artifact ON artifact.id = marker.artifact_id
 WHERE artifact.thread_id IS NOT NULL;

-- Each moved artifact whose R2 objects are still under its old home.
CREATE TABLE standalone_artifact_move (
  artifact_id TEXT PRIMARY KEY REFERENCES thread_artifact (id) ON DELETE CASCADE,
  from_thread_id TEXT NOT NULL CHECK (length(from_thread_id) BETWEEN 1 AND 128)
) WITHOUT ROWID;

INSERT INTO standalone_artifact_move (artifact_id, from_thread_id)
SELECT artifact.id, artifact.thread_id
  FROM thread_artifact_0191 AS artifact
  JOIN threads AS home
    ON home.id = artifact.thread_id AND home.artifact_home = 1;

DROP TABLE thread_open_ask_0191;
DROP TABLE thread_artifact_ask_0191;
DROP TABLE thread_artifact_comment_0191;
DROP TABLE thread_artifact_revision_0191;
DROP TABLE thread_artifact_0191;

-- The homes held nothing else: no messages, no agent, no Orb. Their stored
-- images stay in thread_storage_files until the move copies them.
DELETE FROM threads WHERE artifact_home = 1;

-- Nothing reads or writes `threads.artifact_home` any more; it stays 0.
DROP INDEX IF EXISTS threads_artifact_home_idx;

CREATE INDEX thread_artifact_thread_idx
  ON thread_artifact (thread_id, deleted_at, folder, updated_at DESC);

-- A person's standalone artifacts, and those shared with a workspace.
CREATE INDEX thread_artifact_owner_idx
  ON thread_artifact (owner_user_id, updated_at DESC)
  WHERE thread_id IS NULL AND deleted_at IS NULL;

CREATE INDEX thread_artifact_shared_idx
  ON thread_artifact (shared_workspace_id, updated_at DESC)
  WHERE workspace_access != 'none' AND deleted_at IS NULL;

CREATE INDEX thread_artifact_purge_idx
  ON thread_artifact (deleted_at)
  WHERE deleted_at IS NOT NULL AND stored_bytes > 0;

CREATE INDEX thread_artifact_creator_idx
  ON thread_artifact (created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;

CREATE INDEX thread_artifact_revision_author_idx
  ON thread_artifact_revision (author_user_id)
  WHERE author_user_id IS NOT NULL;

CREATE INDEX thread_artifact_comment_artifact_idx
  ON thread_artifact_comment (artifact_id, created_at);

CREATE INDEX thread_artifact_comment_author_idx
  ON thread_artifact_comment (author_user_id)
  WHERE author_user_id IS NOT NULL;

CREATE INDEX thread_artifact_ask_person_idx
  ON thread_artifact_ask (mentioned_user_id, waiting_since);

CREATE INDEX thread_open_ask_thread_idx ON thread_open_ask (thread_id);

-- Deleting an account deletes the artifacts of the Threads it owned and its
-- standalone artifacts (the cron sweep then removes their bodies and
-- comments), and forgets it as the author of revisions and comments in
-- other people's artifacts.
CREATE TRIGGER thread_artifact_account_deleted
AFTER DELETE ON "user"
BEGIN
  UPDATE thread_artifact
     SET deleted_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
   WHERE deleted_at IS NULL
     AND (owner_user_id = OLD.id
          OR thread_id IN (SELECT id FROM threads WHERE owner_user_id = OLD.id));
  UPDATE thread_artifact SET created_by_user_id = NULL
   WHERE created_by_user_id = OLD.id;
  UPDATE thread_artifact_revision SET author_user_id = NULL
   WHERE author_user_id = OLD.id;
  UPDATE thread_artifact_comment SET author_user_id = NULL
   WHERE author_user_id = OLD.id;
END;

CREATE TRIGGER thread_artifact_ask_account_deleted
AFTER DELETE ON "user"
BEGIN
  DELETE FROM thread_artifact_ask WHERE mentioned_user_id = OLD.id;
END;

-- The Artifacts library, per person: pins and personal folders. Both
-- change only that person's library, never the artifact or anyone else's
-- view of it. A folder is one level deep and holds artifacts the person
-- may open; an artifact sits in at most one of a person's folders. These
-- are not a Thread's artifact folders (`thread_artifact.folder`), which
-- everyone in the Thread shares.
CREATE TABLE artifact_pin (
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  artifact_id TEXT NOT NULL REFERENCES thread_artifact (id) ON DELETE CASCADE,
  pinned_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, artifact_id)
) WITHOUT ROWID;

CREATE INDEX artifact_pin_artifact_idx ON artifact_pin (artifact_id);

CREATE TABLE artifact_folder (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND substr(id, 1, 4) = 'afd_'),
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, name)
);

CREATE TABLE artifact_folder_item (
  user_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL REFERENCES thread_artifact (id) ON DELETE CASCADE,
  folder_id TEXT NOT NULL REFERENCES artifact_folder (id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, artifact_id)
) WITHOUT ROWID;

CREATE INDEX artifact_folder_item_folder_idx
  ON artifact_folder_item (folder_id);
CREATE INDEX artifact_folder_item_artifact_idx
  ON artifact_folder_item (artifact_id);
