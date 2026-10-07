-- Workspace members (0.2.8): shareable invite links, a workspace Mode Dial,
-- and Threads that a workspace member starts in another member's workspace
-- Project.

-- Invite links replace the never-used invite capability table. A link has no
-- usage limit; it stops working when it expires or an admin revokes it. The
-- token itself is stored encrypted so admins can copy the link again; lookup
-- uses its SHA-256 hash.
DROP TABLE workspace_invite_capability;

CREATE TABLE workspace_invite_link (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  token_hash TEXT NOT NULL
    CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^a-f0-9]*'),
  token_envelope_json TEXT NOT NULL
    CHECK (json_valid(token_envelope_json) AND length(token_envelope_json) <= 4096),
  expires_at TEXT CHECK (expires_at IS NULL OR length(expires_at) BETWEEN 20 AND 40),
  use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
  created_by_user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE UNIQUE INDEX workspace_invite_link_token_hash_uidx
  ON workspace_invite_link (token_hash);

CREATE INDEX workspace_invite_link_organization_created_idx
  ON workspace_invite_link (organization_id, created_at DESC, id DESC);

-- One row per (workspace, profile, mode) override. Resolution order is
-- personal override, then workspace override, then the shipped default.
CREATE TABLE workspace_mode_profile_override (
  workspace_id TEXT NOT NULL REFERENCES organization (id) ON DELETE CASCADE,
  profile_id TEXT NOT NULL CHECK (profile_id = 'default'),
  mode TEXT NOT NULL CHECK (mode IN ('low', 'medium', 'high', 'ultra')),
  config TEXT NOT NULL CHECK (json_valid(config)),
  updated_by_user_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, profile_id, mode)
);

-- A Thread belonged to a Project owned by the same user. A workspace member
-- can now start a Thread in a workspace Project another member created, so
-- the Thread's Project reference no longer includes the owner. SQLite cannot
-- alter a foreign key, and D1 cannot disable foreign keys, so the Thread table
-- and every table that references it are rebuilt with unchanged rows.
PRAGMA defer_foreign_keys = on;

-- Rename the Thread table family aside. Renaming rewrites the foreign keys
-- between these tables, so the old family stays self-consistent until it is
-- dropped leaf-first below, after every row has been copied.
ALTER TABLE threads RENAME TO threads_0066;
ALTER TABLE execution_workspace RENAME TO execution_workspace_0066;
ALTER TABLE startup_phase_event RENAME TO startup_phase_event_0066;
ALTER TABLE thread_activity RENAME TO thread_activity_0066;
ALTER TABLE thread_activity_submission RENAME TO thread_activity_submission_0066;
ALTER TABLE thread_changes_state RENAME TO thread_changes_state_0066;
ALTER TABLE thread_changes_capture_lease RENAME TO thread_changes_capture_lease_0066;
ALTER TABLE thread_changes_mutation_lease RENAME TO thread_changes_mutation_lease_0066;
ALTER TABLE thread_pin_history RENAME TO thread_pin_history_0066;
ALTER TABLE thread_source_snapshot RENAME TO thread_source_snapshot_0066;
ALTER TABLE thread_source_authority RENAME TO thread_source_authority_0066;
ALTER TABLE thread_source_finalization_assertion RENAME TO thread_source_finalization_assertion_0066;
ALTER TABLE thread_source_intent RENAME TO thread_source_intent_0066;
ALTER TABLE thread_source_intent_assertion RENAME TO thread_source_intent_assertion_0066;
ALTER TABLE source_control_operation RENAME TO source_control_operation_0066;
ALTER TABLE trusted_plugin_invocation_audit RENAME TO trusted_plugin_invocation_audit_0066;

-- Source-control operations reference this composite key, so it must exist on
-- the new table before rows are copied.
DROP INDEX threads_source_operation_tenant_idx;

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, agent_instructions TEXT NOT NULL DEFAULT ''
    CHECK (length(agent_instructions) <= 10000), agent_instructions_revision INTEGER NOT NULL DEFAULT 0
    CHECK (agent_instructions_revision >= 0), agent_instructions_version INTEGER NOT NULL DEFAULT 1
    CHECK (agent_instructions_version = 1), visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'workspace')), workspace_policy_revision INTEGER NOT NULL DEFAULT 0
    CHECK (workspace_policy_revision >= 0), workspace_policy_migration_state TEXT NOT NULL DEFAULT 'grandfathered'
    CHECK (workspace_policy_migration_state IN ('grandfathered', 'current')), skill_snapshot_json TEXT NOT NULL DEFAULT '[]'
    CHECK (length(skill_snapshot_json) <= 32768)
    CHECK (
      json_valid(skill_snapshot_json)
      AND json_type(skill_snapshot_json) = 'array'
      AND json_array_length(skill_snapshot_json) <= 40
    ), plugin_snapshot_json TEXT NOT NULL DEFAULT '[]'
    CHECK (length(plugin_snapshot_json) <= 32768)
    CHECK (
      json_valid(plugin_snapshot_json)
      AND json_type(plugin_snapshot_json) = 'array'
      AND json_array_length(plugin_snapshot_json) <= 40
    ), lifecycle_state TEXT NOT NULL DEFAULT 'active'
  CHECK (lifecycle_state IN ('active', 'archived', 'deleted')), last_activity_at TEXT, activity_status TEXT NOT NULL DEFAULT 'idle'
  CHECK (activity_status IN ('idle', 'working')), pinned_at TEXT, title TEXT NOT NULL DEFAULT 'Untitled thread'
CHECK (length(title) BETWEEN 1 AND 80), model_selection TEXT NOT NULL
  DEFAULT '{"kind":"mode","profileId":"default","mode":"medium"}'
  CHECK (json_valid(model_selection)), runner_profile_id TEXT
    CHECK (runner_profile_id IS NULL OR length(runner_profile_id) BETWEEN 1 AND 64), title_pending_until TEXT
  CHECK (title_pending_until IS NULL OR length(title_pending_until) BETWEEN 20 AND 40),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE UNIQUE INDEX threads_source_operation_tenant_idx
  ON threads(id, project_id, owner_user_id);

CREATE TABLE "execution_workspace" (
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
  ), runner_profile_id TEXT CHECK (
  runner_profile_id IS NULL OR length(runner_profile_id) BETWEEN 1 AND 64
), account_scope TEXT CHECK (
  account_scope IS NULL
    OR account_scope IN ('deployment', 'workspace', 'personal')
), account_owner_id TEXT CHECK (
  account_owner_id IS NULL OR length(account_owner_id) BETWEEN 1 AND 128
), provider_account TEXT CHECK (
  provider_account IS NULL OR length(provider_account) BETWEEN 1 AND 128
), provider_template TEXT CHECK (
  provider_template IS NULL OR length(provider_template) BETWEEN 1 AND 256
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

CREATE TABLE startup_phase_event (
  journey TEXT NOT NULL CHECK (journey IN ('thread_create', 'submission', 'submission_daemon_activation', 'terminal')),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  thread_id TEXT NOT NULL,
  submission_id TEXT NOT NULL DEFAULT '' CHECK (length(submission_id) <= 128),
  phase TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 30),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40),
  expires_at TEXT NOT NULL CHECK (expires_at > occurred_at),
  outcome TEXT NOT NULL CHECK (outcome IN ('reached', 'failed', 'cancelled')),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  operation_count INTEGER CHECK (operation_count IS NULL OR operation_count >= 0),
  PRIMARY KEY (journey, request_id, thread_id, submission_id, phase),
  UNIQUE (journey, request_id, thread_id, submission_id, ordinal),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
  CHECK ((journey = 'submission') = (submission_id <> '') OR journey = 'submission_daemon_activation'),
  CHECK ((phase = 'context_discovered') = (operation_count IS NOT NULL)),
  CHECK (
    (journey = 'thread_create' AND (
      (phase = 'request_admitted' AND ordinal = 0) OR
      (phase = 'source_authorized' AND ordinal = 1) OR
      (phase = 'budget_admitted' AND ordinal = 2) OR
      (phase = 'thread_persisted' AND ordinal = 3) OR
      (phase = 'response_ready' AND ordinal = 4)
    )) OR
    (journey = 'submission' AND (
      (phase = 'request_admitted' AND ordinal = 0) OR
      (phase = 'submission_accepted' AND ordinal = 1) OR
      (phase = 'flue_queued' AND ordinal = 2) OR
      (phase = 'flue_running' AND ordinal = 3) OR
      (phase = 'workspace_resolved' AND ordinal = 4) OR
      (phase = 'source_activated' AND ordinal = 5) OR
      (phase = 'changes_synced' AND ordinal = 6) OR
      (phase = 'context_discovered' AND ordinal = 7) OR
      (phase = 'model_requested' AND ordinal = 8) OR
      (phase = 'model_first_token' AND ordinal = 9) OR
      (phase = 'settled' AND ordinal = 10)
    )) OR
    (journey = 'submission_daemon_activation' AND (
      (phase = 'requested' AND ordinal = 0) OR
      (phase = 'release_loaded' AND ordinal = 1) OR
      (phase = 'installed' AND ordinal = 2) OR
      (phase = 'connected' AND ordinal = 3) OR
      (phase = 'environment_ready' AND ordinal = 4) OR
      (phase = 'workspace_ready' AND ordinal = 5)
    )) OR
    (journey = 'terminal' AND (
      (phase = 'request_received' AND ordinal = 0) OR
      (phase = 'authenticated' AND ordinal = 1) OR
      (phase = 'thread_authorized' AND ordinal = 2) OR
      (phase = 'websocket_admitted' AND ordinal = 3) OR
      (phase = 'durable_object_reached' AND ordinal = 4) OR
      (phase = 'runner_profile_resolved' AND ordinal = 5) OR
      (phase = 'runner_budget_admitted' AND ordinal = 6) OR
      (phase = 'workspace_lock_acquired' AND ordinal = 7) OR
      (phase = 'workspace_state_resolved' AND ordinal = 8) OR
      (phase IN ('workspace_starting', 'workspace_waking') AND ordinal = 9) OR
      (phase = 'provider_connected' AND ordinal = 10) OR
      (phase = 'workspace_resolved' AND ordinal = 11) OR
      (phase = 'source_activated' AND ordinal = 12) OR
      (phase = 'changes_sync_settled' AND ordinal = 13) OR
      (phase = 'tmux_session_checked' AND ordinal = 14) OR
      (phase = 'tmux_history_configured' AND ordinal = 15) OR
      (phase = 'tmux_display_configured' AND ordinal = 16) OR
      (phase = 'pty_created' AND ordinal = 17) OR
      (phase = 'tmux_attach_requested' AND ordinal = 18) OR
      (phase = 'tmux_replay_captured' AND ordinal = 19) OR
      (phase = 'inactivity_deadline_armed' AND ordinal = 20) OR
      (phase = 'tmux_ready' AND ordinal = 21) OR
      (phase = 'initial_resize_applied' AND ordinal = 22) OR
      (phase = 'daemon_ready' AND ordinal = 24) OR
      (phase = 'resident_open_dispatched' AND ordinal = 25) OR
      (phase = 'resident_ready' AND ordinal = 26) OR
      (phase = 'resident_attach_dispatched' AND ordinal = 27) OR
      (phase = 'resident_replay_started' AND ordinal = 28) OR
      (phase = 'resident_attachment_ready' AND ordinal = 29) OR
      (phase = 'terminal_ready' AND ordinal = 30)
    ))
  )
);

CREATE TABLE thread_activity (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('created', 'submitted', 'settled')),
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (thread_id, event_key),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE TABLE thread_activity_submission (
  thread_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('working', 'settled')),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, submission_id),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE TABLE thread_changes_state (
  thread_id TEXT PRIMARY KEY,
  mutation_generation INTEGER NOT NULL DEFAULT 0 CHECK (mutation_generation >= 0),
  latest_capture_id TEXT CHECK (
    latest_capture_id IS NULL OR length(latest_capture_id) BETWEEN 8 AND 128
  ),
  latest_capture_generation INTEGER CHECK (
    latest_capture_generation IS NULL OR latest_capture_generation >= 0
  ),
  latest_fingerprint TEXT CHECK (
    latest_fingerprint IS NULL OR (
      length(latest_fingerprint) = 64
      AND latest_fingerprint NOT GLOB '*[^a-f0-9]*'
    )
  ),
  latest_captured_at TEXT CHECK (
    latest_captured_at IS NULL OR length(latest_captured_at) BETWEEN 20 AND 40
  ),
  dirty_since TEXT CHECK (
    dirty_since IS NULL OR length(dirty_since) BETWEEN 20 AND 40
  ),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40), shadow_refresh_token TEXT CHECK (
  shadow_refresh_token IS NULL OR (
    length(shadow_refresh_token) BETWEEN 16 AND 64
    AND shadow_refresh_token NOT GLOB '*[^A-Za-z0-9_-]*'
  )
), summary_additions INTEGER CHECK (
  summary_additions IS NULL OR summary_additions >= 0
), summary_deletions INTEGER CHECK (
  summary_deletions IS NULL OR summary_deletions >= 0
), summary_files INTEGER CHECK (
  summary_files IS NULL OR summary_files >= 0
),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
  CHECK (
    (latest_capture_id IS NULL) = (latest_capture_generation IS NULL)
    AND (latest_capture_id IS NULL) = (latest_fingerprint IS NULL)
    AND (latest_capture_id IS NULL) = (latest_captured_at IS NULL)
  ),
  CHECK (
    latest_capture_generation IS NULL
    OR latest_capture_generation <= mutation_generation
  )
);

CREATE TABLE thread_changes_capture_lease (
  thread_id TEXT PRIMARY KEY,
  lease_token TEXT NOT NULL CHECK (length(lease_token) BETWEEN 8 AND 128),
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  FOREIGN KEY (thread_id) REFERENCES thread_changes_state(thread_id) ON DELETE CASCADE
);

CREATE TABLE thread_changes_mutation_lease (
  thread_id TEXT NOT NULL,
  lease_token TEXT NOT NULL CHECK (length(lease_token) BETWEEN 8 AND 128),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  PRIMARY KEY (thread_id, lease_token),
  FOREIGN KEY (thread_id) REFERENCES thread_changes_state(thread_id) ON DELETE CASCADE
);

CREATE TABLE thread_pin_history (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  pinned_at TEXT,
  changed_at TEXT NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE TABLE thread_source_snapshot (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
  provider TEXT NOT NULL CHECK (provider IN ('github', 'bitbucket', 'git')),
  repository_full_name TEXT NOT NULL CHECK (length(repository_full_name) BETWEEN 3 AND 512),
  clone_url TEXT NOT NULL CHECK (
    (((provider = 'github' AND clone_url LIKE 'https://github.com/%/%.git')
      OR (provider = 'bitbucket' AND clone_url LIKE 'https://bitbucket.org/%/%.git'))
      AND instr(substr(clone_url, 9), '@') = 0
      AND instr(clone_url, '?') = 0 AND instr(clone_url, '#') = 0)
    OR (provider = 'git' AND substr(clone_url, 1, 8) = 'https://'
      AND instr(substr(clone_url, 9), '/') > 1
      AND substr(clone_url, 8 + instr(substr(clone_url, 9), '/') + 1) != ''
      AND instr(clone_url, '@') = 0 AND instr(clone_url, '?') = 0 AND instr(clone_url, '#') = 0)
  ),
  default_branch TEXT NOT NULL,
  initial_ref TEXT NOT NULL,
  initial_commit_sha TEXT NOT NULL CHECK (length(initial_commit_sha) = 40 AND initial_commit_sha NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL
);

CREATE TABLE thread_source_authority (
  thread_id TEXT PRIMARY KEY REFERENCES thread_source_snapshot(thread_id) ON DELETE CASCADE,
  owner_grant_id TEXT NOT NULL,
  installation_id TEXT,
  provider_workspace_id TEXT,
  provider_repository_id TEXT NOT NULL,
  authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 1),
  installation_epoch INTEGER NOT NULL CHECK (installation_epoch >= 0),
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 0),
  private_submodule_repository_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(private_submodule_repository_ids_json) AND json_type(private_submodule_repository_ids_json) = 'array' AND json_array_length(private_submodule_repository_ids_json) <= 16),
  CHECK ((installation_id IS NOT NULL AND provider_workspace_id IS NULL AND installation_epoch >= 1)
    OR (installation_id IS NULL AND provider_workspace_id IS NOT NULL
      AND ((length(provider_workspace_id) = 36 AND provider_workspace_id GLOB '????????-????-????-????-????????????')
        OR (length(provider_workspace_id) = 38 AND provider_workspace_id GLOB '{????????-????-????-????-????????????}'))
      AND installation_epoch = 0))
);

CREATE TABLE thread_source_finalization_assertion (thread_id TEXT NOT NULL UNIQUE REFERENCES thread_source_snapshot(thread_id) ON DELETE CASCADE);

CREATE TABLE thread_source_intent (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
  provider TEXT NOT NULL CHECK (provider IN ('github', 'bitbucket', 'git')),
  repository_full_name TEXT NOT NULL CHECK (length(repository_full_name) BETWEEN 3 AND 512),
  clone_url TEXT NOT NULL CHECK (
    (((provider = 'github' AND clone_url LIKE 'https://github.com/%/%.git')
      OR (provider = 'bitbucket' AND clone_url LIKE 'https://bitbucket.org/%/%.git'))
      AND instr(substr(clone_url, 9), '@') = 0
      AND instr(clone_url, '?') = 0 AND instr(clone_url, '#') = 0)
    OR (provider = 'git' AND substr(clone_url, 1, 8) = 'https://'
      AND instr(substr(clone_url, 9), '/') > 1
      AND substr(clone_url, 8 + instr(substr(clone_url, 9), '/') + 1) != ''
      AND instr(clone_url, '@') = 0 AND instr(clone_url, '?') = 0 AND instr(clone_url, '#') = 0)
  ),
  created_at TEXT NOT NULL
);

CREATE TABLE thread_source_intent_assertion (thread_id TEXT NOT NULL UNIQUE REFERENCES thread_source_intent(thread_id) ON DELETE CASCADE);

CREATE TABLE source_control_operation (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  idempotency_key_hash TEXT NOT NULL CHECK (length(idempotency_key_hash) = 64 AND idempotency_key_hash NOT GLOB '*[^a-f0-9]*'),
  actor_user_id TEXT NOT NULL CHECK (length(actor_user_id) BETWEEN 1 AND 128),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
  thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 128),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
  provider_repository_id TEXT NOT NULL CHECK (length(provider_repository_id) BETWEEN 1 AND 256),
  semantic_kind TEXT NOT NULL CHECK (semantic_kind IN ('contents-push', 'workflow-write', 'pull-request-write', 'issue-write', 'actions-write')),
  expected_remote_sha TEXT CHECK (expected_remote_sha IS NULL OR (length(expected_remote_sha) = 40 AND expected_remote_sha NOT GLOB '*[^a-f0-9]*')),
  intended_sha TEXT CHECK (intended_sha IS NULL OR (length(intended_sha) = 40 AND intended_sha NOT GLOB '*[^a-f0-9]*')),
  input_identity_hash TEXT CHECK (input_identity_hash IS NULL OR (length(input_identity_hash) = 64 AND input_identity_hash NOT GLOB '*[^a-f0-9]*')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'executing', 'succeeded', 'failed', 'reconcile-required')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 100),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  provider_result_opaque_id TEXT CHECK (provider_result_opaque_id IS NULL OR length(provider_result_opaque_id) BETWEEN 1 AND 256),
  provider_result_category TEXT CHECK (provider_result_category IS NULL OR provider_result_category IN ('applied', 'rejected', 'conflict', 'not-observed', 'unavailable')),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  completed_at TEXT CHECK (completed_at IS NULL OR length(completed_at) BETWEEN 20 AND 40),
  FOREIGN KEY (thread_id, project_id, actor_user_id) REFERENCES threads(id, project_id, owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (thread_id) REFERENCES thread_source_authority(thread_id) ON DELETE RESTRICT,
  UNIQUE(thread_id, provider, provider_repository_id, idempotency_key_hash),
  CHECK (expected_remote_sha IS NULL OR semantic_kind IN ('contents-push', 'workflow-write')),
  CHECK (intended_sha IS NULL OR semantic_kind IN ('contents-push', 'workflow-write')),
  CHECK (expected_remote_sha IS NULL OR intended_sha IS NOT NULL),
  CHECK (input_identity_hash IS NOT NULL OR intended_sha IS NOT NULL),
  CHECK ((state IN ('pending', 'executing', 'reconcile-required') AND completed_at IS NULL) OR (state IN ('succeeded', 'failed') AND completed_at IS NOT NULL))
);

CREATE TABLE trusted_plugin_invocation_audit (
  invocation_id TEXT NOT NULL PRIMARY KEY
    CHECK (length(invocation_id) BETWEEN 1 AND 128),
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE RESTRICT,
  plugin_id TEXT NOT NULL REFERENCES trusted_plugin(id) ON DELETE RESTRICT,
  version TEXT NOT NULL CHECK (length(version) BETWEEN 5 AND 64),
  capability_kind TEXT NOT NULL CHECK (capability_kind IN ('tool', 'lifecycle')),
  capability_name TEXT NOT NULL CHECK (length(capability_name) BETWEEN 1 AND 128),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'rejected', 'failed', 'limited')),
  duration_ms INTEGER NOT NULL CHECK (duration_ms BETWEEN 0 AND 60000),
  created_at TEXT NOT NULL,
  FOREIGN KEY (plugin_id, version)
    REFERENCES trusted_plugin_version(plugin_id, version) ON DELETE RESTRICT
);

INSERT INTO threads SELECT * FROM threads_0066;
INSERT INTO execution_workspace SELECT * FROM execution_workspace_0066;
INSERT INTO startup_phase_event SELECT * FROM startup_phase_event_0066;
INSERT INTO thread_activity SELECT * FROM thread_activity_0066;
INSERT INTO thread_activity_submission SELECT * FROM thread_activity_submission_0066;
INSERT INTO thread_changes_state SELECT * FROM thread_changes_state_0066;
INSERT INTO thread_changes_capture_lease SELECT * FROM thread_changes_capture_lease_0066;
INSERT INTO thread_changes_mutation_lease SELECT * FROM thread_changes_mutation_lease_0066;
INSERT INTO thread_pin_history SELECT * FROM thread_pin_history_0066;
INSERT INTO thread_source_snapshot SELECT * FROM thread_source_snapshot_0066;
INSERT INTO thread_source_authority SELECT * FROM thread_source_authority_0066;
INSERT INTO thread_source_finalization_assertion SELECT * FROM thread_source_finalization_assertion_0066;
INSERT INTO thread_source_intent SELECT * FROM thread_source_intent_0066;
INSERT INTO thread_source_intent_assertion SELECT * FROM thread_source_intent_assertion_0066;
INSERT INTO source_control_operation SELECT * FROM source_control_operation_0066;
INSERT INTO trusted_plugin_invocation_audit SELECT * FROM trusted_plugin_invocation_audit_0066;

DROP TABLE trusted_plugin_invocation_audit_0066;
DROP TABLE source_control_operation_0066;
DROP TABLE thread_source_intent_assertion_0066;
DROP TABLE thread_source_intent_0066;
DROP TABLE thread_source_finalization_assertion_0066;
DROP TABLE thread_source_authority_0066;
DROP TABLE thread_source_snapshot_0066;
DROP TABLE thread_pin_history_0066;
DROP TABLE thread_changes_mutation_lease_0066;
DROP TABLE thread_changes_capture_lease_0066;
DROP TABLE thread_changes_state_0066;
DROP TABLE thread_activity_submission_0066;
DROP TABLE thread_activity_0066;
DROP TABLE startup_phase_event_0066;
DROP TABLE execution_workspace_0066;
DROP TABLE threads_0066;

CREATE INDEX threads_owner_created_idx
  ON threads(owner_user_id, created_at DESC, id DESC);

CREATE INDEX threads_owner_project_created_idx
  ON threads(owner_user_id, project_id, created_at DESC, id DESC);

CREATE INDEX threads_workspace_inspection_state_idx
  ON threads (owner_user_id, visibility, lifecycle_state, id);

CREATE INDEX threads_owner_activity_idx
  ON threads(owner_user_id, last_activity_at DESC, id DESC);

CREATE INDEX threads_owner_project_activity_idx
  ON threads(owner_user_id, project_id, last_activity_at DESC, id DESC);

CREATE INDEX threads_owner_pinned_activity_id_idx
  ON threads(owner_user_id, pinned_at DESC, last_activity_at DESC, id DESC);


CREATE TRIGGER threads_activity_after_insert
AFTER INSERT ON threads
BEGIN
  UPDATE threads
  SET last_activity_at = NEW.created_at,
      activity_status = 'idle'
  WHERE id = NEW.id;

  INSERT INTO thread_activity (
    thread_id,
    event_key,
    kind,
    occurred_at,
    recorded_at
  ) VALUES (
    NEW.id,
    'created',
    'created',
    NEW.created_at,
    NEW.created_at
  );
END;

CREATE TRIGGER threads_pin_history_after_update
AFTER UPDATE OF pinned_at ON threads
WHEN OLD.pinned_at IS NOT NEW.pinned_at
BEGIN
  INSERT INTO thread_pin_history (thread_id, pinned_at, changed_at)
  VALUES (NEW.id, NEW.pinned_at, NEW.updated_at);
END;

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

CREATE INDEX startup_phase_expiry_idx ON startup_phase_event(expires_at);

CREATE INDEX startup_phase_submission_idx
  ON startup_phase_event(thread_id, submission_id, ordinal);

CREATE INDEX startup_phase_slo_idx
  ON startup_phase_event(journey, phase, occurred_at, outcome, duration_ms);

CREATE TRIGGER startup_phase_event_monotonic_insert
BEFORE INSERT ON startup_phase_event
WHEN NOT EXISTS (
  SELECT 1 FROM startup_phase_event AS duplicate
   WHERE duplicate.journey = NEW.journey
     AND duplicate.request_id = NEW.request_id
     AND duplicate.thread_id = NEW.thread_id
     AND duplicate.submission_id = NEW.submission_id
     AND duplicate.phase = NEW.phase
) AND (
  EXISTS (
    SELECT 1 FROM startup_phase_event AS prior
     WHERE prior.journey = NEW.journey
       AND prior.request_id = NEW.request_id
       AND prior.thread_id = NEW.thread_id
       AND prior.submission_id = NEW.submission_id
       AND prior.ordinal >= NEW.ordinal
  ) OR EXISTS (
    SELECT 1 FROM startup_phase_event AS terminal
     WHERE terminal.journey = NEW.journey
       AND terminal.request_id = NEW.request_id
       AND terminal.thread_id = NEW.thread_id
       AND terminal.submission_id = NEW.submission_id
       AND terminal.outcome IN ('failed', 'cancelled')
       AND terminal.ordinal < NEW.ordinal
  )
)
BEGIN
  SELECT RAISE(ABORT, 'startup phase transition rejected');
END;

CREATE TRIGGER startup_phase_event_immutable_update
BEFORE UPDATE ON startup_phase_event
BEGIN
  SELECT RAISE(ABORT, 'startup phase events are immutable');
END;

CREATE TRIGGER startup_phase_event_retained_delete
BEFORE DELETE ON startup_phase_event
WHEN EXISTS (SELECT 1 FROM threads WHERE id = OLD.thread_id)
  AND NOT EXISTS (
    SELECT 1 FROM startup_phase_retention_gate
     WHERE singleton = 1 AND OLD.expires_at <= delete_before
  )
BEGIN
  SELECT RAISE(ABORT, 'startup phase events are immutable');
END;

CREATE INDEX thread_activity_snapshot_idx
  ON thread_activity(thread_id, sequence, occurred_at DESC);

CREATE INDEX thread_changes_mutation_lease_expiry_idx
  ON thread_changes_mutation_lease(expires_at);

CREATE INDEX thread_pin_history_snapshot_idx
  ON thread_pin_history(thread_id, sequence DESC);

CREATE INDEX thread_source_snapshot_project_idx ON thread_source_snapshot(project_id, binding_revision, thread_id);

CREATE TRIGGER thread_source_snapshot_immutable_update BEFORE UPDATE ON thread_source_snapshot BEGIN SELECT RAISE(ABORT, 'thread source snapshots are immutable'); END;

CREATE TRIGGER thread_source_snapshot_immutable_delete BEFORE DELETE ON thread_source_snapshot WHEN EXISTS (SELECT 1 FROM threads WHERE id = OLD.thread_id) BEGIN SELECT RAISE(ABORT, 'thread source snapshots are immutable'); END;

CREATE INDEX thread_source_authority_grant_idx ON thread_source_authority(owner_grant_id, installation_id, provider_repository_id);

CREATE TRIGGER thread_source_authority_grant_insert BEFORE INSERT ON thread_source_authority
WHEN NOT EXISTS (
  SELECT 1 FROM thread_source_snapshot AS snapshot WHERE snapshot.thread_id = NEW.thread_id AND (
    (snapshot.provider = 'github' AND NEW.provider_workspace_id IS NULL AND EXISTS (
      SELECT 1 FROM github_owner_grant WHERE id = NEW.owner_grant_id AND installation_id = NEW.installation_id)) OR
    (snapshot.provider = 'bitbucket' AND NEW.installation_id IS NULL AND EXISTS (
      SELECT 1 FROM bitbucket_connection WHERE id = NEW.owner_grant_id))
  )
) BEGIN SELECT RAISE(ABORT, 'thread source authority grant is invalid'); END;

CREATE TRIGGER thread_source_authority_immutable_update BEFORE UPDATE ON thread_source_authority BEGIN SELECT RAISE(ABORT, 'thread source authority is immutable'); END;

CREATE TRIGGER thread_source_authority_immutable_delete BEFORE DELETE ON thread_source_authority WHEN EXISTS (SELECT 1 FROM threads WHERE id = OLD.thread_id) BEGIN SELECT RAISE(ABORT, 'thread source authority is immutable'); END;

CREATE INDEX thread_source_intent_project_idx ON thread_source_intent(project_id, binding_revision, thread_id);

CREATE TRIGGER thread_source_intent_immutable_update BEFORE UPDATE ON thread_source_intent BEGIN SELECT RAISE(ABORT, 'thread source intents are immutable'); END;

CREATE TRIGGER thread_source_intent_finalized_delete BEFORE DELETE ON thread_source_intent
WHEN EXISTS (SELECT 1 FROM threads WHERE id = OLD.thread_id) AND NOT EXISTS (
  SELECT 1 FROM thread_source_snapshot AS snapshot WHERE snapshot.thread_id = OLD.thread_id
    AND snapshot.project_id = OLD.project_id AND snapshot.binding_revision = OLD.binding_revision
    AND snapshot.provider = OLD.provider AND snapshot.repository_full_name = OLD.repository_full_name
    AND snapshot.clone_url = OLD.clone_url
) BEGIN SELECT RAISE(ABORT, 'thread source intents may only be deleted after finalization'); END;

CREATE INDEX source_control_operation_thread_time_idx ON source_control_operation(thread_id, updated_at DESC, id DESC);

CREATE INDEX source_control_operation_reconcile_idx ON source_control_operation(state, updated_at, id) WHERE state IN ('executing', 'reconcile-required');

CREATE TRIGGER source_control_operation_intent_immutable BEFORE UPDATE ON source_control_operation
WHEN NEW.id != OLD.id OR NEW.idempotency_key_hash != OLD.idempotency_key_hash OR NEW.actor_user_id != OLD.actor_user_id
 OR NEW.project_id != OLD.project_id OR NEW.thread_id != OLD.thread_id OR NEW.provider != OLD.provider
 OR NEW.provider_repository_id != OLD.provider_repository_id OR NEW.semantic_kind != OLD.semantic_kind
 OR NEW.expected_remote_sha IS NOT OLD.expected_remote_sha OR NEW.intended_sha IS NOT OLD.intended_sha
 OR NEW.input_identity_hash IS NOT OLD.input_identity_hash OR NEW.created_at != OLD.created_at
BEGIN SELECT RAISE(ABORT, 'source-control operation intent is immutable'); END;

CREATE TRIGGER source_control_operation_transition BEFORE UPDATE ON source_control_operation
WHEN NOT ((OLD.state = 'pending' AND NEW.state IN ('executing', 'failed'))
 OR (OLD.state = 'executing' AND NEW.state IN ('succeeded', 'failed', 'reconcile-required'))
 OR (OLD.state = 'reconcile-required' AND NEW.state IN ('executing', 'succeeded', 'failed')))
 OR NEW.version != OLD.version + 1 OR NEW.attempt != OLD.attempt + CASE WHEN NEW.state = 'executing' THEN 1 ELSE 0 END
BEGIN SELECT RAISE(ABORT, 'invalid source-control operation transition'); END;

CREATE TRIGGER source_control_operation_terminal_immutable BEFORE UPDATE ON source_control_operation
WHEN OLD.state IN ('succeeded', 'failed') BEGIN SELECT RAISE(ABORT, 'source-control operation is terminal'); END;

CREATE TRIGGER source_control_operation_no_delete BEFORE DELETE ON source_control_operation
BEGIN SELECT RAISE(ABORT, 'source-control operation cannot be deleted'); END;

CREATE INDEX trusted_plugin_audit_plugin_idx
  ON trusted_plugin_invocation_audit (plugin_id, created_at, invocation_id);

CREATE TRIGGER trusted_plugin_invocation_audit_no_update
BEFORE UPDATE ON trusted_plugin_invocation_audit
BEGIN
  SELECT RAISE(ABORT, 'plugin invocation audit is immutable');
END;

CREATE TRIGGER trusted_plugin_invocation_audit_no_delete
BEFORE DELETE ON trusted_plugin_invocation_audit
BEGIN
  SELECT RAISE(ABORT, 'plugin invocation audit is immutable');
END;
