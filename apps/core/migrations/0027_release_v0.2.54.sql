-- A bug report a person sent from a Thread. The message and the redacted
-- diagnostics they chose live in DX_STORAGE under `bug-reports/<id>/`; this
-- row lists the report under Your Reports and records where Core filed it:
-- a new issue (`filed`), a comment on an open issue it duplicates
-- (`commented`), nowhere because the deployment names no repository
-- (`saved`), or not at all (`failed`).
CREATE TABLE bug_report (
  id TEXT PRIMARY KEY CHECK (id GLOB 'bug_*' AND length(id) = 36),
  reporter_user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 10000),
  status TEXT NOT NULL
    CHECK (status IN ('filing', 'filed', 'commented', 'saved', 'failed')),
  issue_number INTEGER CHECK (issue_number IS NULL OR issue_number > 0),
  issue_url TEXT CHECK (issue_url IS NULL OR length(issue_url) <= 2048),
  image_count INTEGER NOT NULL CHECK (image_count BETWEEN 0 AND 5),
  diagnostics TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX bug_report_reporter_created
  ON bug_report (reporter_user_id, created_at DESC);

-- Thread families (issue #1100). `parent_thread_id` stays the family's root,
-- which sharing, archive, and delete act on. `started_by_thread_id` records
-- the family member whose agent started the Thread, so clients can show the
-- family as a tree. NULL for a root, and for a Thread started before this
-- column existed or whose starter was deleted: those list under the root.
ALTER TABLE threads ADD COLUMN started_by_thread_id TEXT
  REFERENCES threads (id) ON DELETE SET NULL;

CREATE INDEX threads_started_by_idx ON threads (started_by_thread_id)
  WHERE started_by_thread_id IS NOT NULL;

-- Scripts saved in a Project's Orb settings, so a repository works in Orbs
-- without committing setup files. Pre-clone runs before dx clones the
-- repository and pre-setup runs before `.agents/setup`; desktop-resume is
-- reserved for the Desktop. An empty script is deleted, not stored.
CREATE TABLE project_orb_script (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pre-clone', 'pre-setup', 'desktop-resume')),
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) BETWEEN 1 AND 32768),
  updated_by_user_id TEXT NOT NULL CHECK (length(updated_by_user_id) BETWEEN 1 AND 128),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  PRIMARY KEY (project_id, kind)
);

-- Every change to a script, kept after the Project is gone. Scripts run in
-- every member's Orbs, so the audit names who changed which script and the
-- digest of what it became.
CREATE TABLE project_orb_script_audit (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK (kind IN ('pre-clone', 'pre-setup', 'desktop-resume')),
  action TEXT NOT NULL CHECK (action IN ('set', 'clear')),
  body_sha256 TEXT CHECK (
    (action = 'set' AND length(body_sha256) = 64)
    OR (action = 'clear' AND body_sha256 IS NULL)
  ),
  actor_user_id TEXT NOT NULL CHECK (length(actor_user_id) BETWEEN 1 AND 128),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  occurred_at TEXT NOT NULL
);

CREATE INDEX project_orb_script_audit_project_time_idx
ON project_orb_script_audit(project_id, occurred_at DESC, id DESC);

CREATE TRIGGER project_orb_script_audit_immutable_update
BEFORE UPDATE ON project_orb_script_audit
BEGIN
  SELECT RAISE(ABORT, 'project orb script audit is immutable');
END;

CREATE TRIGGER project_orb_script_audit_immutable_delete
BEFORE DELETE ON project_orb_script_audit
BEGIN
  SELECT RAISE(ABORT, 'project orb script audit is immutable');
END;

-- A plugin row is either a code plugin or a bundle in Claude Code's format.
-- A bundle's skills and MCP servers live in their own stores and point back
-- at the plugin that installed them; a disabled or removed bundle hides them
-- from new Threads.
ALTER TABLE trusted_plugin ADD COLUMN kind TEXT NOT NULL DEFAULT 'code'
  CHECK (kind IN ('code', 'bundle'));

ALTER TABLE skill ADD COLUMN plugin_id TEXT
  REFERENCES trusted_plugin (id) ON DELETE RESTRICT;

ALTER TABLE mcp_server ADD COLUMN plugin_id TEXT
  REFERENCES trusted_plugin (id) ON DELETE RESTRICT;

CREATE INDEX skill_plugin_idx ON skill (plugin_id) WHERE plugin_id IS NOT NULL;

CREATE INDEX mcp_server_plugin_idx ON mcp_server (plugin_id)
  WHERE plugin_id IS NOT NULL;
