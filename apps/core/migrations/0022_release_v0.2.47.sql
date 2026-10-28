-- A new person's username comes from their email address: the part before
-- the @ (and before any +tag), lowercased, with . and _ as -. When that is
-- taken or shorter than 3 characters, the first free of four suffixes (two
-- digits, then three digits) wins. An address that yields no valid name, or a
-- name with every suffix taken, falls back to user-<24 hex>.
--
-- The suffix digits come from the last characters of the user id, which is a
-- random UUID. random() would not work: SQLite may evaluate it separately
-- where a candidate is checked and where it is stored.
DROP TRIGGER personal_account_after_user_insert;

CREATE TRIGGER personal_account_after_user_insert
AFTER INSERT ON "user"
BEGIN
  INSERT INTO personal_account (
    user_id,
    display_name,
    username,
    created_at,
    updated_at
  )
  SELECT
    NEW.id,
    CASE
      WHEN length(trim(NEW.name)) = 0 THEN 'User'
      ELSE substr(trim(NEW.name), 1, 128)
    END ,
    coalesce(
      (
        SELECT slug.base || suffix.digits
        FROM
          (
            SELECT rtrim(substr(trim(
              replace(replace(replace(
                replace(replace(
                  substr(address.local, 1, instr(address.local || '+', '+') - 1),
                  '.', '-'), '_', '-'),
                '--', '-'), '--', '-'), '--', '-'),
              '-'), 1, 29), '-') AS base
            FROM (
              SELECT lower(substr(NEW.email, 1, instr(NEW.email, '@') - 1))
                AS local
            ) AS address
          ) AS slug,
          (
            SELECT 0 AS preference, '' AS digits
            UNION ALL
            SELECT 1, 10 + (
              ifnull(unicode(substr(NEW.id, -1, 1)), 0) * 31
              + ifnull(unicode(substr(NEW.id, -2, 1)), 0)
            ) % 90
            UNION ALL
            SELECT 2, 100 + (
              ifnull(unicode(substr(NEW.id, -3, 1)), 0) * 961
              + ifnull(unicode(substr(NEW.id, -4, 1)), 0) * 31
              + ifnull(unicode(substr(NEW.id, -5, 1)), 0)
            ) % 900
            UNION ALL
            SELECT 3, 100 + (
              ifnull(unicode(substr(NEW.id, -6, 1)), 0) * 961
              + ifnull(unicode(substr(NEW.id, -7, 1)), 0) * 31
              + ifnull(unicode(substr(NEW.id, -8, 1)), 0)
            ) % 900
            UNION ALL
            SELECT 4, 100 + (
              ifnull(unicode(substr(NEW.id, -9, 1)), 0) * 961
              + ifnull(unicode(substr(NEW.id, -10, 1)), 0) * 31
              + ifnull(unicode(substr(NEW.id, -11, 1)), 0)
            ) % 900
          ) AS suffix
        WHERE slug.base <> ''
          AND slug.base NOT GLOB '*[^a-z0-9-]*'
          AND length(slug.base || suffix.digits) >= 3
          AND NOT EXISTS (
            SELECT 1
            FROM personal_account AS taken
            WHERE taken.username = slug.base || suffix.digits
          )
        ORDER BY suffix.preference
        LIMIT 1
      ),
      'user-' || lower(hex(randomblob(12)))
    ),
    datetime('now'),
    datetime('now');
END;

-- Orb providers are a list (packages/domain/src/orb-providers), so the
-- tables that store a provider ID stop naming the set: a new provider needs
-- no table rebuild (wiki/plugin-platform-direction.md "Adding an Orb
-- provider"). execution_workspace.provider and
-- workload_identity_issuance_audit.runtime_provider now take any provider
-- ID, checked like orb_connection.provider_id: 1-64 characters of
-- [a-z0-9-]. SQLite cannot alter a CHECK constraint, so both tables are
-- rebuilt with their triggers and indexes unchanged; every row is kept.
CREATE TABLE execution_workspace_0087 (
  thread_id TEXT NOT NULL PRIMARY KEY,
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

INSERT INTO execution_workspace_0087 (
  thread_id, provider, state, provider_sandbox_id, initialization_attempt_id,
  conflict_count, created_at, updated_at, ready_at, preparation_status,
  runner_profile_id, account_scope, account_owner_id, provider_account,
  provider_template
)
SELECT
  thread_id, provider, state, provider_sandbox_id, initialization_attempt_id,
  conflict_count, created_at, updated_at, ready_at, preparation_status,
  runner_profile_id, account_scope, account_owner_id, provider_account,
  provider_template
FROM execution_workspace;

-- The Thread insert trigger names the table; recreated below.
DROP TRIGGER execution_workspace_after_thread_insert;
DROP TABLE execution_workspace;
ALTER TABLE execution_workspace_0087 RENAME TO execution_workspace;

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
        AND NEW.account_owner_id IS NOT NULL
        AND NEW.provider_account IS NOT NULL
        AND NEW.provider_template IS NOT NULL)
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid execution workspace pin');
END;

CREATE TABLE workload_identity_issuance_audit_0087 (
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
    length(runtime_provider) BETWEEN 1 AND 64
    AND runtime_provider NOT GLOB '*[^a-z0-9-]*'
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

INSERT INTO workload_identity_issuance_audit_0087 (
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
ALTER TABLE workload_identity_issuance_audit_0087
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

-- MCP servers gain an explicit auth type (none, bearer token, or OAuth), an
-- optional client name sent to the server, an optional own OAuth app, extra
-- request headers, and an editable module ID that Code imports use.
ALTER TABLE mcp_server ADD COLUMN auth_type TEXT NOT NULL DEFAULT 'none'
  CHECK (auth_type IN ('none', 'bearer', 'oauth'));

UPDATE mcp_server
   SET auth_type = 'bearer'
 WHERE auth_environment_variable_id IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM mcp_server_credential
       WHERE mcp_server_credential.server_id = mcp_server.id
    );

ALTER TABLE mcp_server ADD COLUMN client_name TEXT
  CHECK (client_name IS NULL OR length(client_name) BETWEEN 1 AND 80);

ALTER TABLE mcp_server ADD COLUMN oauth_client_id TEXT
  CHECK (oauth_client_id IS NULL OR length(oauth_client_id) BETWEEN 1 AND 512);

-- [{"name": "X-Org", "value": "acme"}, {"name": "X-Api-Key", "secret": true}]
-- Secret header values live encrypted in mcp_server_secret.
ALTER TABLE mcp_server ADD COLUMN headers_json TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(headers_json) AND json_type(headers_json) = 'array');

ALTER TABLE mcp_server ADD COLUMN module_id TEXT
  CHECK (
    module_id IS NULL OR (
      length(module_id) BETWEEN 1 AND 64 AND
      module_id NOT GLOB '*[^a-z0-9_-]*'
    )
  );

CREATE UNIQUE INDEX mcp_server_module_id_idx
  ON mcp_server (scope, target_id, module_id)
  WHERE module_id IS NOT NULL;

-- Encrypted per-server values other than the bearer token: secret header
-- values ("header:<lowercase name>") and an own OAuth app's client secret
-- ("oauth-client-secret"). Like mcp_server_credential, never part of a
-- Thread sandbox environment.
CREATE TABLE mcp_server_secret (
  server_id TEXT NOT NULL REFERENCES mcp_server(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  target_id TEXT NOT NULL,
  envelope_version INTEGER NOT NULL CHECK (envelope_version = 1),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  value_nonce TEXT NOT NULL CHECK (length(value_nonce) = 16),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 24 AND 65536),
  wrapped_key_nonce TEXT NOT NULL CHECK (length(wrapped_key_nonce) = 16),
  wrapped_key TEXT NOT NULL CHECK (length(wrapped_key) = 64),
  created_at TEXT NOT NULL,
  rotated_at TEXT NOT NULL,
  PRIMARY KEY (server_id, name)
);

-- OAuth sign-ins are always per person, for personal and workspace servers
-- alike: a Thread uses its owner's grant. The encrypted payload holds the
-- registered client, the tokens, and the authorization server it came from.
-- `version` serializes refreshes: a refresh writes only over the version it
-- read, so two concurrent refreshes cannot both rotate the refresh token.
CREATE TABLE mcp_oauth_grant (
  server_id TEXT NOT NULL REFERENCES mcp_server(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 2048),
  version INTEGER NOT NULL CHECK (version >= 1),
  envelope_version INTEGER NOT NULL CHECK (envelope_version = 1),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  value_nonce TEXT NOT NULL CHECK (length(value_nonce) = 16),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 24 AND 65536),
  wrapped_key_nonce TEXT NOT NULL CHECK (length(wrapped_key_nonce) = 16),
  wrapped_key TEXT NOT NULL CHECK (length(wrapped_key) = 64),
  access_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (server_id, user_id)
);

CREATE INDEX mcp_oauth_grant_user_idx ON mcp_oauth_grant (user_id, server_id);

-- One pending sign-in. Only the SHA-256 of `state` is stored; the PKCE
-- verifier and registered client are encrypted. Single use, session bound,
-- and short lived.
CREATE TABLE mcp_oauth_transaction (
  id TEXT NOT NULL PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE
    CHECK (length(state_hash) = 64 AND state_hash NOT GLOB '*[^a-f0-9]*'),
  server_id TEXT NOT NULL REFERENCES mcp_server(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  browser_session_id TEXT NOT NULL,
  endpoint TEXT NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 2048),
  return_to TEXT NOT NULL CHECK (length(return_to) BETWEEN 1 AND 512),
  envelope_version INTEGER NOT NULL CHECK (envelope_version = 1),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  value_nonce TEXT NOT NULL CHECK (length(value_nonce) = 16),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 24 AND 65536),
  wrapped_key_nonce TEXT NOT NULL CHECK (length(wrapped_key_nonce) = 16),
  wrapped_key TEXT NOT NULL CHECK (length(wrapped_key) = 64),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX mcp_oauth_transaction_expiry_idx
  ON mcp_oauth_transaction (expires_at);
