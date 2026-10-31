-- Deleting a workspace (#1158) is a soft delete. The organization row stays,
-- so projects, audit rows, and usage still point at it, but it has no
-- members and its short name is released. Its projects are soft deleted
-- too: a deleted project leaves every list and picker, and its name can be
-- used again. A Thread in a deleted project stays with its owner, archived
-- and read-only.
ALTER TABLE organization ADD COLUMN deletedAt TEXT;

ALTER TABLE projects ADD COLUMN deleted_at TEXT;

-- Project reads never see a deleted project.
DROP VIEW project_read_model;
CREATE VIEW project_read_model AS
SELECT projects.id, projects.owner_user_id, projects.workspace_id, projects.name,
  projects.description, projects.icon_key, projects.revision,
  project_repository.provider AS repository_provider,
  project_repository.binding_revision AS repository_binding_revision,
  project_repository.full_name AS repository_full_name,
  project_repository.web_url AS repository_web_url,
  project_repository.clone_url AS repository_clone_url,
  projects.ship_action, projects.commit_author_preference,
  projects.commit_author_name, projects.commit_author_email,
  projects.signing_preference, projects.runner_profile_id,
  projects.public_code_enabled, projects.created_at, projects.updated_at,
  (SELECT json_group_array(json_object(
      'provider', additional.provider, 'fullName', additional.full_name,
      'webUrl', additional.web_url, 'cloneUrl', additional.clone_url))
     FROM (SELECT * FROM project_additional_repository
            WHERE project_id = projects.id ORDER BY position) AS additional
  ) AS additional_repositories_json,
  projects.deleted_at
FROM projects LEFT JOIN project_repository ON project_repository.project_id = projects.id
WHERE projects.deleted_at IS NULL;

DROP INDEX projects_personal_name_unique_idx;
CREATE UNIQUE INDEX projects_personal_name_unique_idx
  ON projects(owner_user_id, name COLLATE NOCASE)
  WHERE workspace_id IS NULL AND name != 'No Project' AND deleted_at IS NULL;

DROP INDEX projects_workspace_name_unique_idx;
CREATE UNIQUE INDEX projects_workspace_name_unique_idx
  ON projects(workspace_id, name COLLATE NOCASE)
  WHERE workspace_id IS NOT NULL AND name != 'No Project' AND deleted_at IS NULL;

DROP INDEX projects_projectless_personal_unique_idx;
CREATE UNIQUE INDEX projects_projectless_personal_unique_idx
  ON projects(owner_user_id)
  WHERE workspace_id IS NULL AND name = 'No Project' AND deleted_at IS NULL;

DROP INDEX projects_projectless_workspace_unique_idx;
CREATE UNIQUE INDEX projects_projectless_workspace_unique_idx
  ON projects(owner_user_id, workspace_id)
  WHERE workspace_id IS NOT NULL AND name = 'No Project' AND deleted_at IS NULL;

-- The owner may hand the workspace to another member: the new owner is
-- promoted first, then the old owner steps down. A workspace never loses
-- its last owner.
DROP TRIGGER workspace_owner_role_immutable_before_update;
CREATE TRIGGER workspace_owner_role_immutable_before_update
BEFORE UPDATE OF role ON member
WHEN OLD.role = 'owner' AND NEW.role <> 'owner'
  AND (
    SELECT count(*)
    FROM member
    WHERE organizationId = OLD.organizationId
      AND role = 'owner'
  ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'workspace owner is immutable');
END;

-- What a Thread asks of its owner, listed in their Needs-you inbox. The
-- agent's request_attention tool writes a 'question' or an 'approval' with a
-- one-line ask and an optional link; a root Thread's failed turn writes
-- 'failed' when nothing else is asked. The Thread's next turn starting, or
-- the owner's Dismiss, deletes the row.
CREATE TABLE thread_attention_request (
  thread_id TEXT PRIMARY KEY REFERENCES threads (id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('question', 'approval', 'failed')),
  summary TEXT CHECK (summary IS NULL OR length(summary) BETWEEN 1 AND 300),
  url TEXT CHECK (url IS NULL OR length(url) BETWEEN 1 AND 2048),
  requested_at TEXT NOT NULL CHECK (length(requested_at) BETWEEN 20 AND 40)
);

-- The GitHub issues and pull requests a Thread works on. A comment
-- subscription on one links it, as does the agent's `link_github_issue`
-- tool; the link outlives the subscription. The Thread header lists them,
-- and find_thread's `issue:owner/repo#N` finds the Thread from one.
-- Webhooks keep the title and state current; no view reads GitHub.
CREATE TABLE thread_github_link (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  -- owner/name as GitHub spells it; repository_key is it lowercased.
  repository TEXT NOT NULL CHECK (length(repository) BETWEEN 3 AND 200),
  repository_key TEXT NOT NULL CHECK (repository_key = lower(repository)),
  number INTEGER NOT NULL CHECK (number > 0),
  kind TEXT NOT NULL CHECK (kind IN ('issue', 'pull')),
  subject_json TEXT CHECK (
    subject_json IS NULL
    OR (json_valid(subject_json) AND length(subject_json) <= 2000)
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, repository_key, number)
);

CREATE INDEX thread_github_link_target_idx
ON thread_github_link (repository_key, number);

-- Threads that already follow an issue's or a PR's comments.
INSERT OR IGNORE INTO thread_github_link (
  thread_id, repository, repository_key, number, kind, subject_json,
  created_at
)
SELECT thread_id, repository, lower(repository),
       CAST(json_extract(filter_json,
         CASE filter_kind WHEN 'pr-comments' THEN '$.prNumber'
                          ELSE '$.issueNumber' END) AS INTEGER),
       CASE filter_kind WHEN 'pr-comments' THEN 'pull' ELSE 'issue' END ,
       subject_json,
       created_at
  FROM github_subscription
 WHERE destination = 'this-thread'
   AND filter_kind IN ('pr-comments', 'issue-comments')
   AND CAST(json_extract(filter_json,
         CASE filter_kind WHEN 'pr-comments' THEN '$.prNumber'
                          ELSE '$.issueNumber' END) AS INTEGER) > 0;

-- "Add dx as co-author" (#1303). A project snapshots it at creation, like
-- its commit author; when it is on and the person authors commits, each
-- commit gets a `Co-authored-by: dxcodeagent <agent@dxcode.dev>` trailer.
-- Existing projects keep crediting dx. Defaults store NULL until someone
-- chooses, which resolves to on.
ALTER TABLE projects
  ADD COLUMN dx_co_author INTEGER NOT NULL DEFAULT 1
    CHECK (dx_co_author IN (0, 1));

ALTER TABLE personal_project_defaults
  ADD COLUMN dx_co_author INTEGER
    CHECK (dx_co_author IS NULL OR dx_co_author IN (0, 1));

ALTER TABLE workspace_project_defaults
  ADD COLUMN dx_co_author INTEGER
    CHECK (dx_co_author IS NULL OR dx_co_author IN (0, 1));

DROP VIEW project_read_model;
CREATE VIEW project_read_model AS
SELECT projects.id, projects.owner_user_id, projects.workspace_id, projects.name,
  projects.description, projects.icon_key, projects.revision,
  project_repository.provider AS repository_provider,
  project_repository.binding_revision AS repository_binding_revision,
  project_repository.full_name AS repository_full_name,
  project_repository.web_url AS repository_web_url,
  project_repository.clone_url AS repository_clone_url,
  projects.ship_action, projects.commit_author_preference,
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

-- The person's desktop sidebar panel, shared by every device they sign in on
-- and returned with their sidebar layout (`sidebar_layout_entry`): the width
-- they dragged it to (NULL until they resize it, so the default applies) and
-- whether they keep it collapsed. Without a row the sidebar opens at its
-- default width; a width the current schema no longer accepts falls back to
-- the default too.
CREATE TABLE sidebar_panel (
  user_id TEXT PRIMARY KEY NOT NULL,
  width INTEGER CHECK (width IS NULL OR width BETWEEN 1 AND 4096),
  collapsed INTEGER NOT NULL DEFAULT 0 CHECK (collapsed IN (0, 1)),
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

-- When E2B refuses a Thread's create with a client error it makes no
-- sandbox, and the resolver returns the attempt to 'uninitialized' so the
-- next request creates again. The transition trigger rejected that step, so
-- the record stayed 'provisioning' with no sandbox and every later request
-- failed. Allow it only back to an empty record.
DROP TRIGGER execution_workspace_transition_before_update;

CREATE TRIGGER execution_workspace_transition_before_update
BEFORE UPDATE ON execution_workspace
WHEN NEW.state IS NOT OLD.state
  AND NOT (
    (OLD.state = 'uninitialized' AND NEW.state = 'provisioning')
    OR (OLD.state = 'provisioning' AND NEW.state IN ('initialized', 'conflict'))
    OR (OLD.state = 'provisioning' AND NEW.state = 'uninitialized'
      AND OLD.provider_sandbox_id IS NULL
      AND NEW.provider_sandbox_id IS NULL
      AND NEW.initialization_attempt_id IS NULL)
    OR (OLD.state = 'legacy' AND NEW.state IN ('initialized', 'legacy_unavailable', 'conflict'))
    OR (OLD.state = 'initialized' AND NEW.state = 'lost')
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid execution workspace transition');
END;
