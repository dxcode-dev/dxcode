-- Native Git credential issuance records invocation_source 'git-helper'.
-- Migration 0031 predates that source, so every native Git credential audit
-- violated this CHECK and Core withheld the credential. Rebuild the
-- append-only audit table with the complete invocation-source contract while
-- preserving every row, index, and trigger (capabilities as of 0036).
CREATE TABLE source_control_operation_audit_0057 (
  operation_id TEXT PRIMARY KEY CHECK (length(operation_id) BETWEEN 1 AND 128),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40),
  actor_user_id TEXT NOT NULL CHECK (length(actor_user_id) BETWEEN 1 AND 128),
  project_id TEXT CHECK (project_id IS NULL OR length(project_id) BETWEEN 1 AND 128),
  thread_id TEXT CHECK (thread_id IS NULL OR length(thread_id) BETWEEN 1 AND 128),
  provider TEXT CHECK (provider IS NULL OR provider IN ('github', 'gitlab', 'forgejo')),
  provider_repository_id TEXT CHECK (
    provider_repository_id IS NULL OR length(provider_repository_id) BETWEEN 1 AND 256
  ),
  requested_capabilities_json TEXT NOT NULL CHECK (
    length(requested_capabilities_json) <= 2048
    AND json_valid(requested_capabilities_json)
    AND json_type(requested_capabilities_json) = 'array'
    AND json_array_length(requested_capabilities_json) BETWEEN 1 AND 16
  ),
  credential_class TEXT NOT NULL CHECK (
    credential_class IN ('none', 'github-app-installation')
  ),
  invocation_source TEXT NOT NULL CHECK (
    invocation_source IN (
      'checkout', 'agent-command', 'git-helper', 'setup-hook', 'resume-hook', 'system'
    )
  ),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('success', 'denied', 'provider-failed', 'callback-failed', 'interrupted')
  ),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 128),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  CHECK (provider_repository_id IS NULL OR provider IS NOT NULL),
  CHECK (credential_class = 'none' OR provider_repository_id IS NOT NULL)
);

INSERT INTO source_control_operation_audit_0057 (
  operation_id, occurred_at, actor_user_id, project_id, thread_id,
  provider, provider_repository_id, requested_capabilities_json,
  credential_class, invocation_source, outcome, reason, duration_ms
)
SELECT
  operation_id, occurred_at, actor_user_id, project_id, thread_id,
  provider, provider_repository_id, requested_capabilities_json,
  credential_class, invocation_source, outcome, reason, duration_ms
FROM source_control_operation_audit;

-- DROP TABLE removes the old table's triggers before its implicit deletion,
-- so the retention-gated DELETE trigger does not block the rebuild.
DROP TABLE source_control_operation_audit;
ALTER TABLE source_control_operation_audit_0057
  RENAME TO source_control_operation_audit;

CREATE INDEX source_control_audit_thread_time_idx
  ON source_control_operation_audit(thread_id, occurred_at DESC, operation_id DESC);
CREATE INDEX source_control_audit_actor_time_idx
  ON source_control_operation_audit(actor_user_id, occurred_at DESC, operation_id DESC);
CREATE INDEX source_control_audit_outcome_time_idx
  ON source_control_operation_audit(outcome, occurred_at DESC, operation_id DESC);

CREATE TRIGGER source_control_operation_audit_validate_capabilities
BEFORE INSERT ON source_control_operation_audit
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.requested_capabilities_json)
   WHERE type != 'text' OR value NOT IN (
     'checkout', 'fetch', 'repository-read', 'contents-push',
     'pull-request-read', 'pull-request-write', 'issue-read', 'issue-write',
     'actions-read', 'actions-write', 'workflow-write', 'checks-status-read',
     'provider-auth-read'
   )
)
BEGIN
  SELECT RAISE(ABORT, 'invalid source-control audit capability');
END;

CREATE TRIGGER source_control_operation_audit_immutable_update
BEFORE UPDATE ON source_control_operation_audit
BEGIN
  SELECT RAISE(ABORT, 'source-control operation audit is immutable');
END;

CREATE TRIGGER source_control_operation_audit_immutable_delete
BEFORE DELETE ON source_control_operation_audit
WHEN NOT EXISTS (
  SELECT 1 FROM source_control_audit_retention_gate
   WHERE id = 1
     AND OLD.occurred_at < delete_before
     AND strftime('%s', expires_at) > strftime('%s', 'now')
)
BEGIN
  SELECT RAISE(ABORT, 'source-control operation audit is immutable');
END;

-- Last New Thread composer choices, remembered per user across devices.
-- NULL means the user has not chosen that value yet.
ALTER TABLE personal_account
  ADD COLUMN composer_project TEXT
  CHECK (composer_project IS NULL OR composer_project = 'none' OR length(composer_project) BETWEEN 1 AND 64);

ALTER TABLE personal_account
  ADD COLUMN composer_mode TEXT
  CHECK (composer_mode IS NULL OR composer_mode IN ('low', 'medium', 'high', 'ultra'));

ALTER TABLE personal_account
  ADD COLUMN composer_model TEXT
  CHECK (composer_model IS NULL OR length(composer_model) BETWEEN 3 AND 385);

ALTER TABLE personal_account
  ADD COLUMN composer_runner_profile_id TEXT
  CHECK (composer_runner_profile_id IS NULL OR length(composer_runner_profile_id) BETWEEN 1 AND 64);
