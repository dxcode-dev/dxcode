-- execution_workspace stops requiring a Thread. Its row pins an Orb's
-- provider, size, and account and records the provider's handle; until now
-- every Orb belonged to a Thread, so thread_id referenced threads(id) with
-- ON DELETE CASCADE. A plugin Orb (wiki/plugin-platform-direction.md
-- "Plugin Orb") is an Orb that belongs to plugin installs, not to a Thread:
-- it is addressed by an ID in the Thread ID format that no threads row has,
-- so it needs a row here without a Thread. The column keeps its name; every
-- existing row is a Thread's.
--
-- SQLite cannot drop a foreign key in place, so the table is rebuilt as 0098
-- rebuilt it: copied, dropped, renamed, with every trigger recreated
-- unchanged. Nothing references execution_workspace, so no other table moves.
-- The cascade becomes a trigger: deleting a Thread still deletes its row.
PRAGMA defer_foreign_keys = on;

CREATE TABLE execution_workspace_0236 (
  thread_id TEXT NOT NULL PRIMARY KEY CHECK (length(thread_id) BETWEEN 1 AND 128),
  provider TEXT NOT NULL DEFAULT 'e2b' CHECK (
    length(provider) BETWEEN 1 AND 64
    AND provider NOT GLOB '*[^a-z0-9-]*'
  ),
  state TEXT NOT NULL CHECK (
    state IN (
      'uninitialized',
      'provisioning',
      'initialized',
      'lost',
      'legacy',
      'legacy_unavailable',
      'conflict'
    )
  ),
  provider_sandbox_id TEXT CHECK (
    provider_sandbox_id IS NULL
      OR length(provider_sandbox_id) BETWEEN 1 AND 128
  ),
  initialization_attempt_id TEXT CHECK (
    initialization_attempt_id IS NULL
      OR length(initialization_attempt_id) BETWEEN 1 AND 128
  ),
  conflict_count INTEGER CHECK (
    conflict_count IS NULL OR conflict_count > 0
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ready_at TEXT,
  preparation_status TEXT CHECK (
    preparation_status IS NULL
      OR length(preparation_status) BETWEEN 1 AND 160
  ),
  runner_profile_id TEXT CHECK (
    runner_profile_id IS NULL OR length(runner_profile_id) BETWEEN 1 AND 64
  ),
  account_scope TEXT CHECK (
    account_scope IS NULL
      OR account_scope IN ('deployment', 'workspace', 'personal')
  ),
  account_owner_id TEXT CHECK (
    account_owner_id IS NULL OR length(account_owner_id) BETWEEN 1 AND 128
  ),
  provider_account TEXT CHECK (
    provider_account IS NULL OR length(provider_account) BETWEEN 1 AND 128
  ),
  provider_template TEXT CHECK (
    provider_template IS NULL OR length(provider_template) BETWEEN 1 AND 256
  ),
  CHECK (
    (state IN ('uninitialized', 'legacy', 'legacy_unavailable')
      AND provider_sandbox_id IS NULL
      AND initialization_attempt_id IS NULL
      AND conflict_count IS NULL)
    OR (state = 'provisioning'
      AND provider_sandbox_id IS NULL
      AND initialization_attempt_id IS NOT NULL
      AND conflict_count IS NULL)
    OR (state IN ('initialized', 'lost')
      AND provider_sandbox_id IS NOT NULL
      AND initialization_attempt_id IS NULL
      AND conflict_count IS NULL)
    OR (state = 'conflict'
      AND provider_sandbox_id IS NULL
      AND conflict_count IS NOT NULL)
  )
);

INSERT INTO execution_workspace_0236 (
  thread_id,
  provider,
  state,
  provider_sandbox_id,
  initialization_attempt_id,
  conflict_count,
  created_at,
  updated_at,
  ready_at,
  preparation_status,
  runner_profile_id,
  account_scope,
  account_owner_id,
  provider_account,
  provider_template
)
SELECT
  thread_id,
  provider,
  state,
  provider_sandbox_id,
  initialization_attempt_id,
  conflict_count,
  created_at,
  updated_at,
  ready_at,
  preparation_status,
  runner_profile_id,
  account_scope,
  account_owner_id,
  provider_account,
  provider_template
FROM execution_workspace;

-- The Thread insert trigger names the table; recreated below. DROP TABLE
-- removes the table's own triggers, recreated below unchanged.
DROP TRIGGER execution_workspace_after_thread_insert;
DROP TABLE execution_workspace;
ALTER TABLE execution_workspace_0236 RENAME TO execution_workspace;

CREATE TRIGGER execution_workspace_after_thread_insert
AFTER INSERT ON threads
BEGIN
  INSERT INTO execution_workspace (
    thread_id,
    provider,
    state,
    provider_sandbox_id,
    initialization_attempt_id,
    conflict_count,
    created_at,
    updated_at
  ) VALUES (
    NEW.id,
    'e2b',
    'uninitialized',
    NULL,
    NULL,
    NULL,
    NEW.created_at,
    NEW.created_at
  );
END;

-- What ON DELETE CASCADE did: a deleted Thread takes its Orb's row.
CREATE TRIGGER execution_workspace_after_thread_delete
AFTER DELETE ON threads
BEGIN
  DELETE FROM execution_workspace WHERE thread_id = OLD.id;
END;

CREATE TRIGGER execution_workspace_pin_immutable_before_update
BEFORE UPDATE ON execution_workspace
WHEN OLD.account_scope IS NOT NULL
  AND (
    NEW.provider IS NOT OLD.provider
    OR NEW.runner_profile_id IS NOT OLD.runner_profile_id
    OR NEW.account_scope IS NOT OLD.account_scope
    OR NEW.account_owner_id IS NOT OLD.account_owner_id
    OR NEW.provider_account IS NOT OLD.provider_account
    OR NEW.provider_template IS NOT OLD.provider_template
  )
BEGIN
  SELECT RAISE(ABORT, 'execution workspace pin is immutable');
END;

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

CREATE TRIGGER execution_workspace_provider_immutable_before_update
BEFORE UPDATE ON execution_workspace
WHEN NEW.provider != OLD.provider
  AND NOT (OLD.state = 'uninitialized' AND NEW.state = 'provisioning')
  AND NOT (
    OLD.state = 'uninitialized'
    AND NEW.state = 'uninitialized'
    AND OLD.account_scope IS NULL
    AND NEW.account_scope IS NOT NULL
  )
BEGIN
  SELECT RAISE(ABORT, 'execution workspace provider is immutable');
END;

CREATE TRIGGER execution_workspace_readiness_immutable_before_update
BEFORE UPDATE OF ready_at ON execution_workspace
WHEN OLD.ready_at IS NOT NULL
  AND NEW.ready_at IS NOT OLD.ready_at
BEGIN
  SELECT RAISE(ABORT, 'execution workspace readiness is immutable');
END;

CREATE TRIGGER execution_workspace_sandbox_immutable_before_update
BEFORE UPDATE ON execution_workspace
WHEN OLD.provider_sandbox_id IS NOT NULL
  AND NEW.provider_sandbox_id IS NOT OLD.provider_sandbox_id
BEGIN
  SELECT RAISE(ABORT, 'execution workspace sandbox is immutable');
END;

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

-- The latest state of each plugin view described as data, one row per
-- install and view (apps/core/src/plugins/views/state.ts). Plugin code sets
-- it with ctx.views.set from any runtime; open browsers hear each change on
-- the realtime connection. `version` counts every write, so a browser that
-- missed one refetches. State is at most 512 KB of JSON.
CREATE TABLE IF NOT EXISTS plugin_view_state (
  plugin_id TEXT NOT NULL REFERENCES trusted_plugin (id) ON DELETE CASCADE,
  view_id TEXT NOT NULL CHECK (length(view_id) BETWEEN 1 AND 48),
  state_json TEXT NOT NULL
    CHECK (length(state_json) <= 524288)
    CHECK (json_valid(state_json)),
  version INTEGER NOT NULL CHECK (version >= 1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, view_id)
);

-- Plugin Orbs and plugin services (wiki/plugin-platform-direction.md
-- "Plugin services"). A plugin's service is a program dxd keeps running on a
-- plugin Orb: one shared Orb per person and one per workspace, or an Orb of
-- the plugin's own. A plugin Orb is not a Thread: its ID has the Thread ID
-- format so the execution stack (provider handles, dxd's key, the execution
-- object, idle sleep, meters) addresses it as it does a Thread's Orb, but no
-- threads row has it, so nothing that lists or reads Threads sees it.
-- execution_workspace holds its pin (0236 let a row exist without a Thread).

-- One row per plugin Orb. `plugin_id` is NULL for a shared Orb and names
-- the install for an Orb of its own. `payer_user_id` is the person who
-- installed the plugins it runs (owner decision 2026-11-25): on an account
-- dx bills for, they pay per minute, for a personal and a workspace install
-- alike, so a workspace's plugins share one Orb per installer and each
-- Orb's minutes are wholly one person's. Its dxd runs as them.
-- `stopped_reason` says why a stopped Orb is not running (the payer left,
-- no credit, every service turned off), so Settings can say what to do.
CREATE TABLE plugin_orb (
  id TEXT NOT NULL PRIMARY KEY CHECK (
    length(id) = 40 AND id GLOB 'thr_*'
  ),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 128),
  -- No foreign keys: a row outlives its install, its payer, or its
  -- workspace until the minute sweep has destroyed the Orb it names, so no
  -- cascade can leave an Orb running with nothing pointing at it.
  plugin_id TEXT CHECK (plugin_id IS NULL OR length(plugin_id) BETWEEN 1 AND 128),
  payer_user_id TEXT NOT NULL CHECK (length(payer_user_id) BETWEEN 1 AND 128),
  runner_profile_id TEXT NOT NULL CHECK (
    length(runner_profile_id) BETWEEN 1 AND 64
  ),
  -- Where the size came from: the plugin's own choice, the person's, the
  -- workspace's, or the deployment's default.
  chosen_by TEXT NOT NULL CHECK (
    chosen_by IN ('plugin', 'personal', 'workspace', 'deployment')
  ),
  keep_running INTEGER NOT NULL DEFAULT 0 CHECK (keep_running IN (0, 1)),
  state TEXT NOT NULL DEFAULT 'active' CHECK (
    state IN ('active', 'stopped', 'removing')
  ),
  stopped_reason TEXT CHECK (
    stopped_reason IS NULL
      OR stopped_reason IN ('payer-left', 'no-credit', 'services-off', 'orb-failed')
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- At most one shared Orb per scope and payer, and one own Orb per install.
CREATE UNIQUE INDEX plugin_orb_shared_idx
  ON plugin_orb (scope, target_id, payer_user_id)
  WHERE plugin_id IS NULL;
CREATE UNIQUE INDEX plugin_orb_own_idx
  ON plugin_orb (plugin_id)
  WHERE plugin_id IS NOT NULL;
CREATE INDEX plugin_orb_payer_idx ON plugin_orb (payer_user_id);

-- The Orb size plugins run on, chosen in Settings → Orb Providers → Plugins:
-- a person's (`personal`, target the user), a workspace's (`workspace`,
-- target the workspace, set by its admins), or one install's own
-- (`plugin`, target the trusted_plugin id). Resolution order for a personal
-- install: plugin, personal, workspace, the deployment's default; for a
-- workspace install: plugin, workspace, the deployment's default. None of
-- these refuses the install's service with where to choose one.
CREATE TABLE plugin_orb_choice (
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace', 'plugin')),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 128),
  runner_profile_id TEXT NOT NULL CHECK (
    length(runner_profile_id) BETWEEN 1 AND 64
  ),
  updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, target_id)
);

-- An install's service: which Orb runs it and how it last went, for the
-- plugin's "Runs on" row and its refusals. Its schedules' next runs are in
-- plugin_service_schedule.
CREATE TABLE plugin_service (
  plugin_id TEXT NOT NULL PRIMARY KEY
    REFERENCES trusted_plugin (id) ON DELETE CASCADE,
  orb_id TEXT CHECK (orb_id IS NULL OR length(orb_id) = 40),
  status TEXT NOT NULL CHECK (
    status IN ('starting', 'running', 'sleeping', 'failed', 'refused', 'off')
  ),
  message TEXT CHECK (message IS NULL OR length(message) <= 1000),
  version TEXT,
  updated_at TEXT NOT NULL
);

CREATE INDEX plugin_service_orb_idx ON plugin_service (orb_id);

-- Each declared schedule of an install's service. The minute sweep claims
-- a due row by its next_run_at (compare and set), wakes the plugin Orb, and
-- sends POST /jobs/<name>. No model runs.
CREATE TABLE plugin_service_schedule (
  plugin_id TEXT NOT NULL REFERENCES trusted_plugin (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 48),
  spec TEXT NOT NULL CHECK (length(spec) BETWEEN 1 AND 100),
  next_run_at TEXT NOT NULL,
  last_run_at TEXT,
  last_status TEXT CHECK (
    last_status IS NULL OR last_status IN ('ok', 'failed', 'refused')
  ),
  last_message TEXT CHECK (last_message IS NULL OR length(last_message) <= 500),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, name)
);

CREATE INDEX plugin_service_schedule_due_idx
  ON plugin_service_schedule (next_run_at);

-- A Thread a service opened under a key, so the same key opens one Thread:
-- while that Thread is active, opening the key again returns it.
CREATE TABLE plugin_thread_key (
  plugin_id TEXT NOT NULL REFERENCES trusted_plugin (id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 200),
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
);

-- Orb time names its owner: a Thread's Orb or a plugin Orb. Thread usage
-- views join threads, so they never count a plugin Orb's minutes; a
-- plugin's "cost this month" reads its plugin Orb's sessions by
-- `thread_id` (the plugin Orb's ID) where `owner_kind` is 'plugin-orb'.
ALTER TABLE thread_orb_session ADD COLUMN owner_kind TEXT NOT NULL
  DEFAULT 'thread' CHECK (owner_kind IN ('thread', 'plugin-orb'));

CREATE TRIGGER thread_orb_session_plugin_orb
AFTER INSERT ON thread_orb_session
WHEN EXISTS (SELECT 1 FROM plugin_orb WHERE id = NEW.thread_id)
BEGIN
  UPDATE thread_orb_session SET owner_kind = 'plugin-orb'
   WHERE thread_id = NEW.thread_id AND started_at = NEW.started_at;
END;

-- Plugin panes were removed (M4): plugins describe their screens as views
-- (plugin_view_state). Nothing reads or writes pane posts, open requests,
-- calls, or snapshots any more, and no quick action opens a pane. The CHECK
-- on plugin_quick_action.action still allows 'open-pane'; rebuilding the
-- table to drop it is not worth the copy.
DELETE FROM plugin_quick_action WHERE action = 'open-pane';

DROP INDEX IF EXISTS plugin_pane_event_kind_time;
DROP INDEX IF EXISTS plugin_pane_event_pane;
DROP TABLE IF EXISTS plugin_pane_event;

DROP INDEX IF EXISTS plugin_pane_snapshot_plugin_idx;
DROP TABLE IF EXISTS plugin_pane_snapshot;

-- The port a plugin's program listens on while it runs (dxd assigns it),
-- so the plugin Orb's Portal can let a person reach the plugin's own page
-- (`service.app`) on that port and nothing else on the Orb. NULL while the
-- program is not running.
ALTER TABLE plugin_service ADD COLUMN port INTEGER CHECK (
  port IS NULL OR port BETWEEN 1 AND 65535
);

-- Hot reload of an installed personal plugin (`dxd plugin dev`) is gone:
-- a plugin is built as a draft in one Thread (`dxd plugin load`), whose
-- state lives in that Thread's execution object, and kept with manage_dx
-- (wiki/plugin-platform-direction.md#draft-plugins).
DROP TABLE IF EXISTS plugin_dev_link;

-- Plugin trust tiers are gone (owner, 2026-11-25: no tiers, on screen or in
-- code; installing a plugin is the trust decision). Nothing reads or writes
-- a workspace's tier cap, trusted repositories, or trusted signing keys any
-- more, so their columns go. Each column's CHECK names only that column, so
-- SQLite drops it in place.
ALTER TABLE workspace_policy DROP COLUMN plugin_tier_cap;
ALTER TABLE workspace_policy DROP COLUMN trusted_plugin_project_ids;
ALTER TABLE workspace_policy DROP COLUMN trusted_plugin_signers;
