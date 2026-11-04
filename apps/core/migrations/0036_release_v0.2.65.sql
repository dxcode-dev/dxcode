-- Invite links get an optional use limit. NULL keeps a link unlimited. A join
-- inserts the member only while use_count < max_uses, in the same batch that
-- counts the use, so people joining at once cannot oversubscribe a link.
ALTER TABLE workspace_invite_link
  ADD COLUMN max_uses INTEGER
    CHECK (max_uses IS NULL OR max_uses BETWEEN 1 AND 1000);

-- A renamed workspace keeps its old short names as aliases (#1382), so saved
-- and shared /workspaces/<old>/... links still open it for its members.
-- An alias lasts until another workspace takes that short name, which is
-- allowed at once and drops the alias. A workspace keeps its 20 newest
-- aliases. The triggers keep the table right for every write to
-- organization: a rename, a new workspace, and a deletion.
CREATE TABLE workspace_short_name_alias (
  short_name TEXT NOT NULL PRIMARY KEY COLLATE NOCASE
    CHECK (length(short_name) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL
    REFERENCES organization(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX workspace_short_name_alias_workspace_idx
  ON workspace_short_name_alias (workspace_id, created_at);

-- A rename keeps the old name as an alias, takes the new name from any
-- alias holding it (this workspace's own, when renaming back), and drops
-- the oldest aliases past 20. A deletion renames to deleted-...; it
-- keeps no alias.
CREATE TRIGGER workspace_short_name_alias_after_rename
AFTER UPDATE OF slug ON organization
WHEN OLD.slug <> NEW.slug AND NEW.deletedAt IS NULL
BEGIN
  DELETE FROM workspace_short_name_alias WHERE short_name = NEW.slug;
  INSERT OR REPLACE INTO workspace_short_name_alias (short_name, workspace_id)
    VALUES (OLD.slug, NEW.id);
  DELETE FROM workspace_short_name_alias
   WHERE workspace_id = NEW.id
     AND rowid NOT IN (
       SELECT rowid FROM workspace_short_name_alias
        WHERE workspace_id = NEW.id
        ORDER BY created_at DESC, rowid DESC
        LIMIT 20
     );
END;

-- A new workspace takes its short name from any alias holding it.
CREATE TRIGGER workspace_short_name_alias_after_create
AFTER INSERT ON organization
BEGIN
  DELETE FROM workspace_short_name_alias WHERE short_name = NEW.slug;
END;

-- A deleted workspace keeps its row (0113) but no aliases.
CREATE TRIGGER workspace_short_name_alias_after_delete
AFTER UPDATE OF deletedAt ON organization
WHEN NEW.deletedAt IS NOT NULL
BEGIN
  DELETE FROM workspace_short_name_alias WHERE workspace_id = NEW.id;
END;

-- Autosave Files, for this person on every device: whether a file tab writes
-- edits to disk 5 seconds after typing stops. Off keeps an edit a draft until
-- Ctrl+S.
ALTER TABLE personal_account
  ADD COLUMN files_autosave INTEGER NOT NULL DEFAULT 0
  CHECK (files_autosave IN (0, 1));

-- Ship Behavior (#1196): the main action in a Thread's Changes pane. Ship
-- has the agent land the work on the base branch, Push to Branch has it push
-- a feature branch, and Custom Ship sends the project's own prompt. A project
-- keeps its custom prompt when it switches back, for the next time.
--
-- `ship_action` only accepts 'ship' and 'commit', and changing a CHECK
-- would mean rebuilding the table, so the behavior moves to new columns.
-- Nothing ever read 'commit'; its nearest behavior is Push to Branch.
-- `ship_action` stays as an unread column.
ALTER TABLE projects
  ADD COLUMN ship_behavior TEXT NOT NULL DEFAULT 'ship'
    CHECK (ship_behavior IN ('ship', 'push', 'custom'));

ALTER TABLE projects
  ADD COLUMN ship_prompt TEXT
    CHECK (ship_prompt IS NULL OR length(ship_prompt) BETWEEN 1 AND 10000);

UPDATE projects SET ship_behavior = 'push' WHERE ship_action = 'commit';

-- Project defaults choose Ship or Push to Branch for new projects. Their
-- Custom Ship default and its prompt are #1131's.
ALTER TABLE personal_project_defaults
  ADD COLUMN ship_behavior TEXT
    CHECK (ship_behavior IS NULL OR ship_behavior IN ('ship', 'push', 'custom'));

ALTER TABLE personal_project_defaults
  ADD COLUMN ship_prompt TEXT
    CHECK (ship_prompt IS NULL OR length(ship_prompt) BETWEEN 1 AND 10000);

UPDATE personal_project_defaults
  SET ship_behavior = CASE ship_action WHEN 'commit' THEN 'push' ELSE ship_action END
  WHERE ship_action IS NOT NULL;

ALTER TABLE workspace_project_defaults
  ADD COLUMN ship_behavior TEXT
    CHECK (ship_behavior IS NULL OR ship_behavior IN ('ship', 'push', 'custom'));

ALTER TABLE workspace_project_defaults
  ADD COLUMN ship_prompt TEXT
    CHECK (ship_prompt IS NULL OR length(ship_prompt) BETWEEN 1 AND 10000);

UPDATE workspace_project_defaults
  SET ship_behavior = CASE ship_action WHEN 'commit' THEN 'push' ELSE ship_action END
  WHERE ship_action IS NOT NULL;

DROP VIEW project_read_model;
CREATE VIEW project_read_model AS
SELECT projects.id, projects.owner_user_id, projects.workspace_id, projects.name,
  projects.description, projects.icon_key, projects.revision,
  project_repository.provider AS repository_provider,
  project_repository.binding_revision AS repository_binding_revision,
  project_repository.full_name AS repository_full_name,
  project_repository.web_url AS repository_web_url,
  project_repository.clone_url AS repository_clone_url,
  projects.ship_behavior, projects.ship_prompt,
  projects.commit_author_preference,
  projects.commit_author_name, projects.commit_author_email,
  projects.signing_preference, projects.runner_profile_id,
  projects.public_code_enabled, projects.created_at, projects.updated_at,
  (SELECT json_group_array(json_object(
      'provider', additional.provider, 'fullName', additional.full_name,
      'webUrl', additional.web_url, 'cloneUrl', additional.clone_url))
     FROM (SELECT * FROM project_additional_repository
            WHERE project_id = projects.id ORDER BY position) AS additional
  ) AS additional_repositories_json,
  projects.deleted_at,
  projects.dx_co_author
FROM projects LEFT JOIN project_repository ON project_repository.project_id = projects.id
WHERE projects.deleted_at IS NULL;

-- Artifacts: Markdown documents that belong to one Thread, edited by its
-- agent and the people who can contribute to it. Each save is a revision;
-- its body is one immutable R2 object at
-- thread-artifacts/<thread>/<artifact>/<revision>-<sha256>.md.
--
-- `current_revision` is the compare-and-swap point: a save names the
-- revision it started from and applies only while that is still current.
-- `stored_bytes` sums the kept revisions' sizes, so a Thread's total stays
-- bounded. Deleting an artifact keeps its row, with `deleted_at` set, and
-- removes its revisions, bodies, and comments; deleting the Thread removes
-- everything.
CREATE TABLE thread_artifact (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND substr(id, 1, 4) = 'art_'),
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
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
  deleted_at INTEGER
);

CREATE INDEX thread_artifact_thread_idx
  ON thread_artifact (thread_id, deleted_at, folder, updated_at DESC);

-- Deleted artifacts whose bodies are not yet removed, for the cron sweep.
CREATE INDEX thread_artifact_purge_idx
  ON thread_artifact (deleted_at)
  WHERE deleted_at IS NOT NULL AND stored_bytes > 0;

CREATE INDEX thread_artifact_creator_idx
  ON thread_artifact (created_by_user_id)
  WHERE created_by_user_id IS NOT NULL;

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

CREATE INDEX thread_artifact_revision_author_idx
  ON thread_artifact_revision (author_user_id)
  WHERE author_user_id IS NOT NULL;

-- Comments sit beside the Markdown, never in it. A top-level comment holds
-- the text it is on (`quote`) and where that text was found last
-- (`anchor_*`, UTF-16 offsets); each save finds the quote again, and a
-- comment whose text is gone has a null anchor. Replies point at their
-- parent and follow it.
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
  resolved_at INTEGER
);

CREATE INDEX thread_artifact_comment_artifact_idx
  ON thread_artifact_comment (artifact_id, created_at);

CREATE INDEX thread_artifact_comment_author_idx
  ON thread_artifact_comment (author_user_id)
  WHERE author_user_id IS NOT NULL;

-- Deleting an account deletes the artifacts of the Threads it owned (the
-- cron sweep then removes their bodies and comments) and forgets it as the
-- author of revisions and comments in other people's Threads.
CREATE TRIGGER thread_artifact_account_deleted
AFTER DELETE ON "user"
BEGIN
  UPDATE thread_artifact
     SET deleted_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
   WHERE deleted_at IS NULL
     AND thread_id IN (SELECT id FROM threads WHERE owner_user_id = OLD.id);
  UPDATE thread_artifact SET created_by_user_id = NULL
   WHERE created_by_user_id = OLD.id;
  UPDATE thread_artifact_revision SET author_user_id = NULL
   WHERE author_user_id = OLD.id;
  UPDATE thread_artifact_comment SET author_user_id = NULL
   WHERE author_user_id = OLD.id;
END;

-- Asks in artifacts: each open checklist item that mentions a person, once
-- per person it mentions, rebuilt from the artifact's current revision on
-- every save. The Needs-you page reads a person's asks across their Threads
-- from here instead of every artifact's Markdown. `item_key` names the item
-- across revisions (its text and which repeat of it it is), so
-- `waiting_since` keeps the time it was first seen.
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

CREATE INDEX thread_artifact_ask_person_idx
  ON thread_artifact_ask (mentioned_user_id, waiting_since);

-- When an artifact edit last woke each Thread, so wakes stay at most one per
-- interval per Thread.
CREATE TABLE thread_artifact_wake (
  thread_id TEXT PRIMARY KEY REFERENCES threads (id) ON DELETE CASCADE,
  woke_at INTEGER NOT NULL
) WITHOUT ROWID;

-- The artifact holding an ask the agent listed with request_attention.
ALTER TABLE thread_attention_request ADD COLUMN artifact_id TEXT;

-- A deleted account waits on nothing.
CREATE TRIGGER thread_artifact_ask_account_deleted
AFTER DELETE ON "user"
BEGIN
  DELETE FROM thread_artifact_ask WHERE mentioned_user_id = OLD.id;
END;
