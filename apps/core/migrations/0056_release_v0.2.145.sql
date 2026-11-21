-- A Project's Orb scripts now hold its whole Orb preparation: setup runs once
-- when dx prepares a fresh Orb and resume each time the Orb starts or wakes,
-- in place of the repository's `.agents/setup` and `.agents/resume`, which dx
-- no longer reads. Pre-setup ran just before `.agents/setup`, so each saved
-- pre-setup becomes the Project's setup; the one-time import appends the
-- repository's `.agents/setup` after it.
--
-- SQLite cannot change a CHECK constraint in place, so both tables are
-- rebuilt. Nothing references them, so each is recreated aside, copied, and
-- swapped in.
CREATE TABLE project_orb_script_0209 (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('pre-clone', 'setup', 'resume', 'desktop-resume')),
  body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) BETWEEN 1 AND 32768),
  updated_by_user_id TEXT NOT NULL CHECK (length(updated_by_user_id) BETWEEN 1 AND 128),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  PRIMARY KEY (project_id, kind)
);

INSERT INTO project_orb_script_0209
  (project_id, kind, body, updated_by_user_id, updated_at)
SELECT project_id,
       CASE kind WHEN 'pre-setup' THEN 'setup' ELSE kind END ,
       body, updated_by_user_id, updated_at
  FROM project_orb_script;

DROP TABLE project_orb_script;
ALTER TABLE project_orb_script_0209 RENAME TO project_orb_script;

-- The audit keeps its historic pre-setup rows and records the one-time
-- import of the repository's files as action 'import'.
DROP TRIGGER project_orb_script_audit_immutable_update;
DROP TRIGGER project_orb_script_audit_immutable_delete;
DROP INDEX project_orb_script_audit_project_time_idx;

CREATE TABLE project_orb_script_audit_0209 (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
  kind TEXT NOT NULL CHECK (
    kind IN ('pre-clone', 'setup', 'resume', 'desktop-resume', 'pre-setup')
  ),
  action TEXT NOT NULL CHECK (action IN ('set', 'clear', 'import')),
  body_sha256 TEXT CHECK (
    (action IN ('set', 'import') AND length(body_sha256) = 64)
    OR (action = 'clear' AND body_sha256 IS NULL)
  ),
  actor_user_id TEXT NOT NULL CHECK (length(actor_user_id) BETWEEN 1 AND 128),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  occurred_at TEXT NOT NULL
);

INSERT INTO project_orb_script_audit_0209
  (id, project_id, kind, action, body_sha256, actor_user_id, request_id,
   occurred_at)
SELECT id, project_id, kind, action, body_sha256, actor_user_id, request_id,
       occurred_at
  FROM project_orb_script_audit;

DROP TABLE project_orb_script_audit;
ALTER TABLE project_orb_script_audit_0209 RENAME TO project_orb_script_audit;

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

-- A Project whose repository's Orb files dx has imported, or found it has no
-- connection to read. A Project without a row is imported the next time dx
-- reads its scripts or prepares one of its Orbs.
CREATE TABLE project_orb_import (
  project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  imported_at TEXT NOT NULL CHECK (length(imported_at) BETWEEN 20 AND 40)
);

-- The last failed read of a Project's repository files, so reads back off
-- for a few minutes instead of reaching the provider on every request.
CREATE TABLE project_orb_import_attempt (
  project_id TEXT PRIMARY KEY NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  attempted_at TEXT NOT NULL CHECK (length(attempted_at) BETWEEN 20 AND 40)
);
