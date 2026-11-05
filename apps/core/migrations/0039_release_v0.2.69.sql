-- Bug reports forwarded between deployments (#1661).
--
-- On the central deployment, a report another deployment forwarded keeps
-- where it came from: the sender its intake key names, the origin the
-- sender gave, and the report's ID and Thread ID there. Its
-- `reporter_user_id` is `intake:<sender>`, which no person's ID matches, so
-- only report readers open it. A sender's retry of the same report finds the
-- row by (sender, report ID) instead of keeping it twice.
ALTER TABLE bug_report ADD COLUMN source_sender TEXT;
ALTER TABLE bug_report ADD COLUMN source_origin TEXT;
ALTER TABLE bug_report ADD COLUMN source_report_id TEXT;
ALTER TABLE bug_report ADD COLUMN source_thread_id TEXT;

CREATE UNIQUE INDEX bug_report_source
  ON bug_report (source_sender, source_report_id)
  WHERE source_sender IS NOT NULL;

-- The intake counts each sender's reports in the last hour.
CREATE INDEX bug_report_source_created
  ON bug_report (source_sender, created_at)
  WHERE source_sender IS NOT NULL;

-- On a sending deployment, each report still to forward to the central
-- deployment. A delivery claims the row by moving `next_attempt_at` ahead,
-- so the send right after a report and the cron's retry do not both send.
CREATE TABLE bug_report_forward (
  report_id TEXT PRIMARY KEY
    REFERENCES bug_report (id) ON DELETE CASCADE,
  destination TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  -- Set once the destination accepted it.
  forwarded_at TEXT,
  -- Set when it stopped trying: refused, or 24 hours without success.
  failed_at TEXT,
  last_status INTEGER,
  created_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX bug_report_forward_due
  ON bug_report_forward (next_attempt_at)
  WHERE forwarded_at IS NULL AND failed_at IS NULL;

-- Git Remote Aliases (#1199): other URLs of a Project's primary repository,
-- such as a mirror or an SSH remote. `url` is the canonical form people see;
-- `web_url` is the HTTPS identity dx matches a repository by. Nothing clones
-- an alias, and no credential is stored.
CREATE TABLE project_remote_alias (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9),
  url TEXT NOT NULL CHECK (
    length(url) BETWEEN 8 AND 600
    AND instr(url, '?') = 0 AND instr(url, '#') = 0
    AND (substr(url, 1, 8) = 'https://' AND instr(url, '@') = 0
      OR substr(url, 1, 6) = 'ssh://' OR instr(url, '://') = 0)
  ),
  web_url TEXT NOT NULL CHECK (
    length(web_url) BETWEEN 12 AND 600 AND substr(web_url, 1, 8) = 'https://'
    AND instr(web_url, '@') = 0
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, position),
  UNIQUE (project_id, url)
);

CREATE INDEX project_remote_alias_web_url
  ON project_remote_alias (web_url COLLATE NOCASE);

-- Rebuilt from 0139_project_ship_behavior.sql, plus remote_aliases_json.
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
  projects.dx_co_author,
  (SELECT json_group_array(alias.url)
     FROM (SELECT url FROM project_remote_alias
            WHERE project_id = projects.id ORDER BY position) AS alias
  ) AS remote_aliases_json
FROM projects LEFT JOIN project_repository ON project_repository.project_id = projects.id
WHERE projects.deleted_at IS NULL;

-- Notify agent's wakes, coalesced (#1765).
--
-- With a person's Notify agent flag on, a Notify or a comment that mentions
-- @dx wakes the agent right away and opens a 15-second window for its
-- Thread. Notifies and mentions inside the window join it: `joined` lists
-- them (a JSON array of {"kind":"comment","id"} and
-- {"kind":"notify","artifactId"}), and once the window closes the sweep
-- sends one trailing wake built from them, then sets `trailing_sent`. The
-- next event after that opens a new window. Additive: no existing table
-- changes.
CREATE TABLE thread_artifact_agent_wake (
  thread_id TEXT PRIMARY KEY REFERENCES threads (id) ON DELETE CASCADE,
  window_start INTEGER NOT NULL,
  joined TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(joined)),
  trailing_sent INTEGER NOT NULL DEFAULT 0 CHECK (trailing_sent IN (0, 1))
) WITHOUT ROWID;

-- The sweep reads windows that hold joined events and still owe a wake.
CREATE INDEX thread_artifact_agent_wake_due
  ON thread_artifact_agent_wake (window_start)
  WHERE trailing_sent = 0 AND joined <> '[]';
