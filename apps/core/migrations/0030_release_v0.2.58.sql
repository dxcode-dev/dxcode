-- A deployment's own account of a provider that is prepared at runtime
-- (Boat with BOAT_API_KEY): one row per provider, holding the connector's
-- preparation, never a credential. Every person's Threads on the
-- deployment's account start from what it prepared.
CREATE TABLE orb_deployment_preparation (
  provider_id TEXT NOT NULL PRIMARY KEY CHECK (
    length(provider_id) BETWEEN 1 AND 64
    AND provider_id NOT GLOB '*[^a-z0-9-]*'
  ),
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
  updated_at TEXT NOT NULL
);

-- A Thread on the deployment's account of a prepared provider pins the
-- target its preparation made, as a connection's Thread does.
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
      (NEW.account_scope = 'deployment'
        AND NEW.account_owner_id IS NULL
        AND NEW.provider_account IS NULL)
      OR (NEW.account_scope IN ('workspace', 'personal')
        AND NEW.account_owner_id IS NOT NULL
        AND NEW.provider_account IS NOT NULL
        AND NEW.provider_template IS NOT NULL)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid execution workspace pin');
END;
