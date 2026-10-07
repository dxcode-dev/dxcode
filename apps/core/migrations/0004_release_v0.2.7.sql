-- Additional repositories cloned beside a Project's primary checkout, under
-- ~/workspace/repos/<name>. Identity only: native Git in the Thread workspace
-- uses the Thread owner's credential, so no grant or authority is stored.
CREATE TABLE project_additional_repository (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 9),
  provider TEXT NOT NULL CHECK (provider IN ('git', 'github', 'bitbucket')),
  full_name TEXT NOT NULL CHECK (length(full_name) BETWEEN 3 AND 512),
  web_url TEXT NOT NULL CHECK (length(web_url) BETWEEN 12 AND 600),
  clone_url TEXT NOT NULL CHECK (
    clone_url = web_url || '.git'
    AND substr(clone_url, 1, 8) = 'https://'
    AND instr(clone_url, '@') = 0 AND instr(clone_url, '?') = 0
    AND instr(clone_url, '#') = 0
    AND (provider = 'git'
      OR (provider = 'github' AND clone_url LIKE 'https://github.com/%/%.git')
      OR (provider = 'bitbucket' AND clone_url LIKE 'https://bitbucket.org/%/%.git'))
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, position),
  UNIQUE (project_id, clone_url)
);

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
  ) AS additional_repositories_json
FROM projects LEFT JOIN project_repository ON project_repository.project_id = projects.id;
