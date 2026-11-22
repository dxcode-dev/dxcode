-- Why an archived Thread can never be restored, beside a deleted Project
-- (which stays derived from projects.deleted_at). `orb-removed`: dx removed
-- its unused Orb after the deployment's retention, and archived the Thread
-- for good. NULL for every other Thread.
ALTER TABLE threads ADD COLUMN archive_locked_reason TEXT
  CHECK (archive_locked_reason IS NULL OR archive_locked_reason IN ('orb-removed'));

-- The Orbs running now, one row per Thread whose Orb daemon is connected:
-- its execution object writes the row when a run starts and deletes it when
-- the run ends (thread-usage/orb-running.ts). Finished runs stay in
-- thread_orb_session. A deployment's admin lists these; nothing else reads
-- them. Provider, size and account come from execution_workspace.
CREATE TABLE orb_running (
  thread_id TEXT NOT NULL PRIMARY KEY CHECK (length(thread_id) BETWEEN 1 AND 128),
  started_at INTEGER NOT NULL CHECK (started_at > 0)
) WITHOUT ROWID;

CREATE INDEX orb_running_started_idx ON orb_running (started_at);

-- Deployment Orb accounts: a deployment's admin adds its own accounts of an
-- Orb provider (an Agent37 workspace, a Cloudflare account other than the
-- one dx runs on) from data instead of secrets. Each one is a connection at
-- scope 'deployment', its target the account's own ID, prepared and pinned
-- the way a person's or workspace's connection is.
--
-- 1. orb_connection accepts scope 'deployment'. SQLite cannot widen a CHECK
--    in place, so the table is rebuilt: renamed aside, recreated, copied,
--    dropped. Nothing references it by foreign key, and it has no triggers
--    or indexes beyond its primary key.
-- 2. A Thread on one of these accounts pins it like a connection: scope
--    'deployment' with the account's ID, the provider account, and the
--    target its preparation made. A pin on the deployment's own secret or
--    binding keeps naming no owner and no account.

ALTER TABLE orb_connection RENAME TO orb_connection_0215;

CREATE TABLE orb_connection (
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace', 'deployment')),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 128),
  provider_id TEXT NOT NULL CHECK (
    length(provider_id) BETWEEN 1 AND 64
    AND provider_id NOT GLOB '*[^a-z0-9-]*'
  ),
  envelope_version INTEGER NOT NULL CHECK (envelope_version = 1),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  value_nonce TEXT NOT NULL CHECK (length(value_nonce) = 16),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 24 AND 65536),
  wrapped_key_nonce TEXT NOT NULL CHECK (length(wrapped_key_nonce) = 16),
  wrapped_key TEXT NOT NULL CHECK (length(wrapped_key) = 64),
  configured_at TEXT NOT NULL CHECK (length(configured_at) BETWEEN 20 AND 40),
  recipe TEXT CHECK (recipe IS NULL OR length(recipe) BETWEEN 1 AND 64),
  account TEXT CHECK (account IS NULL OR length(account) BETWEEN 1 AND 128),
  status TEXT NOT NULL CHECK (status IN ('preparing', 'ready', 'failed')),
  state_json TEXT NOT NULL CHECK (
    json_valid(state_json) AND length(state_json) BETWEEN 2 AND 16384
  ),
  progress_json TEXT CHECK (
    progress_json IS NULL
      OR (json_valid(progress_json) AND length(progress_json) <= 1024)
  ),
  error TEXT CHECK (error IS NULL OR length(error) BETWEEN 1 AND 500),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, target_id, provider_id),
  CHECK ((status = 'failed') = (error IS NOT NULL))
);

INSERT INTO orb_connection (
  scope, target_id, provider_id, envelope_version, key_version, value_nonce,
  ciphertext, wrapped_key_nonce, wrapped_key, configured_at, recipe, account,
  status, state_json, progress_json, error, revision, updated_at
)
SELECT scope, target_id, provider_id, envelope_version, key_version,
       value_nonce, ciphertext, wrapped_key_nonce, wrapped_key, configured_at,
       recipe, account, status, state_json, progress_json, error, revision,
       updated_at
  FROM orb_connection_0215;

DROP TABLE orb_connection_0215;

DROP TRIGGER execution_workspace_pin_written_before_update;
CREATE TRIGGER execution_workspace_pin_written_before_update
BEFORE UPDATE OF account_scope ON execution_workspace
WHEN OLD.account_scope IS NULL
  AND NEW.account_scope IS NOT NULL
  AND NOT (
    OLD.state = 'uninitialized'
    AND NEW.state = 'uninitialized'
    AND NEW.runner_profile_id IS NOT NULL
    AND (
      -- The deployment's own secret or binding.
      (NEW.account_scope = 'deployment'
        AND NEW.account_owner_id IS NULL
        AND NEW.provider_account IS NULL)
      -- A connection: a person's, a workspace's, or a deployment account's.
      OR (NEW.account_scope IN ('workspace', 'personal', 'deployment')
        AND NEW.account_owner_id IS NOT NULL
        AND NEW.provider_account IS NOT NULL
        AND NEW.provider_template IS NOT NULL)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid execution workspace pin');
END;

-- Which deployment Orb account an ended Orb run used (0221's accounts), as
-- the run is recorded. NULL for a person's own account, a workspace's, or
-- the deployment's default provider settings. Reading usage per account
-- then needs no join from every session to its Thread's workspace, which
-- also names only the account the Thread uses now.

ALTER TABLE thread_orb_session ADD COLUMN deployment_account_id TEXT;

-- Runs recorded before: the account their Thread's workspace uses now, as
-- usage per account read them until this migration.
UPDATE thread_orb_session
   SET deployment_account_id = (
     SELECT w.account_owner_id
       FROM execution_workspace w
      WHERE w.thread_id = thread_orb_session.thread_id
        AND w.account_scope = 'deployment'
   );
