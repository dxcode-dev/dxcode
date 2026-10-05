-- First-party plugin platform, phase 1 (wiki/plugin-platform-direction.md).

-- Workspace policy may deny personal plugin configuration overrides.
ALTER TABLE workspace_policy ADD COLUMN allow_personal_plugin_overrides INTEGER NOT NULL DEFAULT 1
  CHECK (allow_personal_plugin_overrides IN (0, 1));

-- One row per plugin per personal or workspace scope. Enablement is
-- three-valued: NULL is unset. A scope holds at most one configuration: a
-- provider plus its credential, encrypted with the shared configuration
-- envelope. Deployment scope comes from bindings and is never stored here.
CREATE TABLE plugin_setting (
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 128),
  plugin_id TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 1 AND 64),
  enablement TEXT CHECK (enablement IS NULL OR enablement IN ('enabled', 'disabled')),
  provider_id TEXT CHECK (provider_id IS NULL OR length(provider_id) BETWEEN 1 AND 64),
  envelope_version INTEGER CHECK (envelope_version IS NULL OR envelope_version = 1),
  key_version INTEGER CHECK (key_version IS NULL OR key_version >= 1),
  value_nonce TEXT CHECK (value_nonce IS NULL OR length(value_nonce) = 16),
  ciphertext TEXT CHECK (ciphertext IS NULL OR length(ciphertext) BETWEEN 24 AND 65536),
  wrapped_key_nonce TEXT CHECK (wrapped_key_nonce IS NULL OR length(wrapped_key_nonce) = 16),
  wrapped_key TEXT CHECK (wrapped_key IS NULL OR length(wrapped_key) = 64),
  configured_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, target_id, plugin_id),
  CHECK (
    (provider_id IS NULL AND envelope_version IS NULL AND key_version IS NULL
      AND value_nonce IS NULL AND ciphertext IS NULL AND wrapped_key_nonce IS NULL
      AND wrapped_key IS NULL AND configured_at IS NULL)
    OR (provider_id IS NOT NULL AND envelope_version IS NOT NULL AND key_version IS NOT NULL
      AND value_nonce IS NOT NULL AND ciphertext IS NOT NULL AND wrapped_key_nonce IS NOT NULL
      AND wrapped_key IS NOT NULL AND configured_at IS NOT NULL)
  )
);

-- The plugin tool set each submission mounted, resolved once at the
-- submission boundary. Retries and recovery of the same submission reuse the
-- first row; history keeps explaining tool calls whose plugin later went away.
CREATE TABLE submission_plugin_tools (
  thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 128),
  submission_id TEXT NOT NULL CHECK (length(submission_id) BETWEEN 1 AND 256),
  owner_user_id TEXT NOT NULL,
  tool_set_json TEXT NOT NULL CHECK (json_valid(tool_set_json) AND json_type(tool_set_json) = 'array'),
  resolved_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > resolved_at),
  PRIMARY KEY (thread_id, submission_id)
);

CREATE INDEX submission_plugin_tools_expiry_idx
  ON submission_plugin_tools (expires_at);

CREATE TRIGGER submission_plugin_tools_immutable_update
BEFORE UPDATE ON submission_plugin_tools
BEGIN
  SELECT RAISE(ABORT, 'submission plugin tools are immutable');
END;

-- Metered provider calls. Same retention, attribution, and immutability
-- pattern as usage_event; credential scope is the billing dimension.
CREATE TABLE plugin_usage_event (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_user_id TEXT NOT NULL,
  workspace_id TEXT,
  thread_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  submission_id TEXT,
  plugin_id TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 1 AND 64),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 64),
  capability TEXT NOT NULL CHECK (length(capability) BETWEEN 1 AND 64),
  credential_scope TEXT NOT NULL CHECK (credential_scope IN ('personal', 'workspace', 'deployment')),
  unit TEXT NOT NULL CHECK (unit IN ('request')),
  units INTEGER NOT NULL CHECK (units >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'error')),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  occurred_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > occurred_at)
);

CREATE INDEX plugin_usage_event_owner_time_idx
  ON plugin_usage_event (owner_user_id, occurred_at DESC, id DESC);

CREATE INDEX plugin_usage_event_workspace_time_idx
  ON plugin_usage_event (workspace_id, occurred_at DESC, id DESC);

CREATE INDEX plugin_usage_event_expiry_idx
  ON plugin_usage_event (expires_at);

CREATE TRIGGER plugin_usage_event_immutable_update
BEFORE UPDATE ON plugin_usage_event
BEGIN
  SELECT RAISE(ABORT, 'plugin usage events are immutable');
END;

-- One encrypted bearer token per MCP server, entered on the server itself.
-- Kept apart from environment_variable so it never reaches a Thread sandbox:
-- only the Core MCP path reads this table.
CREATE TABLE mcp_server_credential (
  server_id TEXT NOT NULL PRIMARY KEY
    REFERENCES mcp_server(id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  target_id TEXT NOT NULL,
  envelope_version INTEGER NOT NULL CHECK (envelope_version = 1),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  value_nonce TEXT NOT NULL CHECK (length(value_nonce) = 16),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 24 AND 65536),
  wrapped_key_nonce TEXT NOT NULL CHECK (length(wrapped_key_nonce) = 16),
  wrapped_key TEXT NOT NULL CHECK (length(wrapped_key) = 64),
  created_at TEXT NOT NULL,
  rotated_at TEXT NOT NULL
);

-- First-party plugin platform, phase 2: the Speech plugin
-- (wiki/plugin-platform-direction.md).
--
-- Composer dictation is metered but belongs to no Thread or Project, and
-- Speech meters audio seconds. Rebuild plugin_usage_event so Thread and
-- Project are both present or both absent and `audio_second` is a unit,
-- keeping every existing row.
CREATE TABLE plugin_usage_event_0063 (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_user_id TEXT NOT NULL,
  workspace_id TEXT,
  thread_id TEXT,
  project_id TEXT,
  submission_id TEXT,
  plugin_id TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 1 AND 64),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 64),
  capability TEXT NOT NULL CHECK (length(capability) BETWEEN 1 AND 64),
  credential_scope TEXT NOT NULL CHECK (credential_scope IN ('personal', 'workspace', 'deployment')),
  unit TEXT NOT NULL CHECK (unit IN ('request', 'audio_second')),
  units INTEGER NOT NULL CHECK (units >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'error')),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  occurred_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > occurred_at),
  CHECK ((thread_id IS NULL) = (project_id IS NULL))
);

INSERT INTO plugin_usage_event_0063 (
  id, owner_user_id, workspace_id, thread_id, project_id, submission_id,
  plugin_id, provider_id, capability, credential_scope, unit, units, outcome,
  duration_ms, occurred_at, expires_at
)
SELECT
  id, owner_user_id, workspace_id, thread_id, project_id, submission_id,
  plugin_id, provider_id, capability, credential_scope, unit, units, outcome,
  duration_ms, occurred_at, expires_at
FROM plugin_usage_event;

DROP TABLE plugin_usage_event;
ALTER TABLE plugin_usage_event_0063 RENAME TO plugin_usage_event;

CREATE INDEX plugin_usage_event_owner_time_idx
  ON plugin_usage_event (owner_user_id, occurred_at DESC, id DESC);

CREATE INDEX plugin_usage_event_workspace_time_idx
  ON plugin_usage_event (workspace_id, occurred_at DESC, id DESC);

CREATE INDEX plugin_usage_event_expiry_idx
  ON plugin_usage_event (expires_at);

CREATE TRIGGER plugin_usage_event_immutable_update
BEFORE UPDATE ON plugin_usage_event
BEGIN
  SELECT RAISE(ABORT, 'plugin usage events are immutable');
END;

-- Each dictation job remembers the provider and credential scope it was
-- dispatched with, so every poll can recheck that the user's current Speech
-- configuration is still that one. Jobs already at a provider were
-- dispatched with the deployment Sarvam key (or the local fixture); jobs not
-- yet dispatched expire as stale.
ALTER TABLE dictation_job ADD COLUMN provider_id TEXT
  CHECK (provider_id IS NULL OR length(provider_id) BETWEEN 1 AND 64);
ALTER TABLE dictation_job ADD COLUMN credential_scope TEXT
  CHECK (credential_scope IS NULL OR credential_scope IN ('personal', 'workspace', 'deployment'));

UPDATE dictation_job
SET provider_id = CASE provider_job_id
    WHEN 'local-fixture' THEN 'fixture'
    ELSE 'sarvam'
  END ,
  credential_scope = 'deployment'
WHERE provider_job_id IS NOT NULL;

-- First-party plugin platform, phase 4d: Cloudflare Containers as a second
-- Orb provider (wiki/plugin-platform-direction.md, "What phase 4d shipped").
--
-- execution_workspace pins each Thread's provider and sandbox identity. Its
-- provider was fixed to 'e2b'; it may now also be 'cloudflare'. A new Thread's
-- row still starts as 'e2b' and 'uninitialized'; the provider may change
-- exactly once, in the same update that leaves 'uninitialized' for
-- 'provisioning' (the first activation claims the row), and is immutable
-- afterwards. Workload identity audits name the same provider. Both tables are
-- rebuilt because SQLite cannot alter a CHECK constraint; every row is kept.
CREATE TABLE execution_workspace_0064 (
  thread_id TEXT NOT NULL PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'e2b' CHECK (provider IN ('e2b', 'cloudflare')),
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
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
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

INSERT INTO execution_workspace_0064 (
  thread_id, provider, state, provider_sandbox_id, initialization_attempt_id,
  conflict_count, created_at, updated_at, ready_at, preparation_status
)
SELECT
  thread_id, provider, state, provider_sandbox_id, initialization_attempt_id,
  conflict_count, created_at, updated_at, ready_at, preparation_status
FROM execution_workspace;

DROP TRIGGER execution_workspace_after_thread_insert;
DROP TABLE execution_workspace;
ALTER TABLE execution_workspace_0064 RENAME TO execution_workspace;

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

CREATE TRIGGER execution_workspace_provider_immutable_before_update
BEFORE UPDATE ON execution_workspace
WHEN NEW.provider != OLD.provider
  AND NOT (OLD.state = 'uninitialized' AND NEW.state = 'provisioning')
BEGIN
  SELECT RAISE(ABORT, 'execution workspace provider is immutable');
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
    OR (OLD.state = 'legacy' AND NEW.state IN ('initialized', 'legacy_unavailable', 'conflict'))
    OR (OLD.state = 'initialized' AND NEW.state = 'lost')
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid execution workspace transition');
END;

CREATE TRIGGER execution_workspace_readiness_immutable_before_update
BEFORE UPDATE OF ready_at ON execution_workspace
WHEN OLD.ready_at IS NOT NULL
  AND NEW.ready_at IS NOT OLD.ready_at
BEGIN
  SELECT RAISE(ABORT, 'execution workspace readiness is immutable');
END;

CREATE TABLE workload_identity_issuance_audit_0064 (
  issuance_id TEXT PRIMARY KEY CHECK (
    length(issuance_id) = 40 AND issuance_id GLOB 'wid_*'
  ),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40),
  actor_user_id TEXT CHECK (
    actor_user_id IS NULL OR length(actor_user_id) BETWEEN 1 AND 128
  ),
  project_id TEXT CHECK (
    project_id IS NULL OR length(project_id) BETWEEN 1 AND 128
  ),
  workspace_id TEXT CHECK (
    workspace_id IS NULL OR length(workspace_id) BETWEEN 1 AND 128
  ),
  thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 128),
  runtime_provider TEXT NOT NULL CHECK (
    runtime_provider IN ('local', 'e2b', 'cloudflare')
  ),
  runtime_identity_digest TEXT CHECK (
    runtime_identity_digest IS NULL
      OR (
        length(runtime_identity_digest) = 43
        AND runtime_identity_digest NOT GLOB '*[^A-Za-z0-9_-]*'
      )
  ),
  runtime_assurance TEXT NOT NULL CHECK (
    runtime_assurance IN ('dx_dxd_channel_v1', 'dx_provider_attested_v1')
  ),
  audience TEXT NOT NULL CHECK (
    length(audience) BETWEEN 1 AND 256
    AND audience NOT GLOB '*[^ -~]*'
    AND audience NOT LIKE '% %'
  ),
  requested_ttl_seconds INTEGER CHECK (
    requested_ttl_seconds IS NULL
      OR requested_ttl_seconds BETWEEN 60 AND 3600
  ),
  effective_ttl_seconds INTEGER NOT NULL CHECK (
    effective_ttl_seconds BETWEEN 60 AND 3600
  ),
  expires_at INTEGER,
  signing_kid TEXT CHECK (
    signing_kid IS NULL
      OR (
        length(signing_kid) BETWEEN 8 AND 64
        AND signing_kid NOT GLOB '*[^A-Za-z0-9_-]*'
      )
  ),
  outcome TEXT NOT NULL CHECK (outcome IN ('issued', 'denied', 'error')),
  reason TEXT CHECK (
    reason IS NULL OR reason IN ('authority', 'configuration', 'signing', 'audit')
  ),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  CHECK (
    (outcome = 'issued'
      AND actor_user_id IS NOT NULL
      AND project_id IS NOT NULL
      AND runtime_identity_digest IS NOT NULL
      AND expires_at IS NOT NULL
      AND signing_kid IS NOT NULL
      AND reason IS NULL)
    OR
    (outcome IN ('denied', 'error')
      AND expires_at IS NULL
      AND signing_kid IS NULL
      AND reason IS NOT NULL)
  )
);

INSERT INTO workload_identity_issuance_audit_0064 (
  issuance_id, occurred_at, actor_user_id, project_id, workspace_id,
  thread_id, runtime_provider, runtime_identity_digest, runtime_assurance,
  audience, requested_ttl_seconds, effective_ttl_seconds, expires_at,
  signing_kid, outcome, reason, duration_ms
)
SELECT
  issuance_id, occurred_at, actor_user_id, project_id, workspace_id,
  thread_id, runtime_provider, runtime_identity_digest, runtime_assurance,
  audience, requested_ttl_seconds, effective_ttl_seconds, expires_at,
  signing_kid, outcome, reason, duration_ms
FROM workload_identity_issuance_audit;

-- DROP TABLE runs no DELETE trigger, and the rows were copied above.
DROP TABLE workload_identity_issuance_audit;
ALTER TABLE workload_identity_issuance_audit_0064
  RENAME TO workload_identity_issuance_audit;

CREATE INDEX workload_identity_audit_thread_time_idx
  ON workload_identity_issuance_audit(thread_id, occurred_at DESC, issuance_id DESC);

CREATE INDEX workload_identity_audit_actor_time_idx
  ON workload_identity_issuance_audit(actor_user_id, occurred_at DESC, issuance_id DESC);

CREATE INDEX workload_identity_audit_outcome_time_idx
  ON workload_identity_issuance_audit(outcome, occurred_at DESC, issuance_id DESC);

CREATE TRIGGER workload_identity_issuance_audit_immutable_update
BEFORE UPDATE ON workload_identity_issuance_audit
BEGIN
  SELECT RAISE(ABORT, 'workload identity issuance audit is immutable');
END;

CREATE TRIGGER workload_identity_issuance_audit_immutable_delete
BEFORE DELETE ON workload_identity_issuance_audit
WHEN NOT EXISTS (
  SELECT 1 FROM workload_identity_audit_retention_gate
   WHERE id = 1
     AND OLD.occurred_at < delete_before
     AND strftime('%s', expires_at) > strftime('%s', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'workload identity issuance audit is immutable');
END;

-- First-party plugin platform, phase 4b: bring-your-own keys for key-based
-- Orb providers (wiki/plugin-platform-direction.md, "What phase 4b shipped").
--
-- 1. execution_workspace pins the account, not just the provider. Thread
--    creation records the runner profile (size), whose key pays (the
--    credential scope and owner, stored as account_scope and
--    account_owner_id; no key material), the provider account (the E2B
--    team), and for a person's or workspace's own key the template built
--    into that team. A row without a
--    pin (every Thread from before 4b, and the local runtime) is the
--    deployment's. The pin is written once, while the workspace is still
--    'uninitialized', and is immutable afterwards.
-- 2. execution_account_template tracks the Orb template build in each
--    person's or workspace's own E2B team.
-- 3. workspace_policy gains the explicit opt-in for members' own Orb keys on
--    workspace projects (default off).
-- 4. Runner usage rows record the credential scope that paid.
--
-- Every change adds columns, a table, or triggers; no row is rewritten.

ALTER TABLE execution_workspace ADD COLUMN runner_profile_id TEXT CHECK (
  runner_profile_id IS NULL OR length(runner_profile_id) BETWEEN 1 AND 64
);
ALTER TABLE execution_workspace ADD COLUMN account_scope TEXT CHECK (
  account_scope IS NULL
    OR account_scope IN ('deployment', 'workspace', 'personal')
);
ALTER TABLE execution_workspace ADD COLUMN account_owner_id TEXT CHECK (
  account_owner_id IS NULL OR length(account_owner_id) BETWEEN 1 AND 128
);
ALTER TABLE execution_workspace ADD COLUMN provider_account TEXT CHECK (
  provider_account IS NULL OR length(provider_account) BETWEEN 1 AND 128
);
ALTER TABLE execution_workspace ADD COLUMN provider_template TEXT CHECK (
  provider_template IS NULL OR length(provider_template) BETWEEN 1 AND 256
);

-- The provider may now also change while the pin is first written
-- (Thread creation), not only when the first activation claims the row.
DROP TRIGGER execution_workspace_provider_immutable_before_update;

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
      (NEW.account_scope = 'deployment'
        AND NEW.account_owner_id IS NULL
        AND NEW.provider_account IS NULL
        AND NEW.provider_template IS NULL)
      OR (NEW.account_scope IN ('workspace', 'personal')
        AND NEW.provider = 'e2b'
        AND NEW.account_owner_id IS NOT NULL
        AND NEW.provider_account IS NOT NULL
        AND NEW.provider_template IS NOT NULL)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid execution workspace pin');
END;

CREATE TABLE execution_account_template (
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 128),
  provider_id TEXT NOT NULL CHECK (provider_id = 'e2b'),
  -- The plugin_setting configuration this build belongs to.
  configured_at TEXT NOT NULL CHECK (length(configured_at) BETWEEN 20 AND 40),
  recipe TEXT NOT NULL CHECK (length(recipe) BETWEEN 1 AND 64),
  -- The provider account the key belongs to (the E2B team), once known.
  account TEXT CHECK (account IS NULL OR length(account) BETWEEN 1 AND 128),
  state TEXT NOT NULL CHECK (state IN ('building', 'ready', 'failed')),
  builds_json TEXT NOT NULL CHECK (length(builds_json) BETWEEN 2 AND 8192),
  error TEXT CHECK (error IS NULL OR length(error) BETWEEN 1 AND 500),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, target_id, provider_id),
  CHECK ((state = 'failed') = (error IS NOT NULL))
);

ALTER TABLE workspace_policy ADD COLUMN allow_personal_execution_overrides
  INTEGER NOT NULL DEFAULT 0
  CHECK (allow_personal_execution_overrides IN (0, 1));

ALTER TABLE usage_event ADD COLUMN runner_credential_scope TEXT CHECK (
  runner_credential_scope IS NULL
    OR runner_credential_scope IN ('deployment', 'workspace', 'personal')
);
