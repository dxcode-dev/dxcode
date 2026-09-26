CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, owner_user_id)
);

CREATE INDEX projects_owner_created_idx
  ON projects(owner_user_id, created_at DESC, id DESC);

CREATE TABLE threads (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id, owner_user_id)
    REFERENCES projects(id, owner_user_id)
);

CREATE INDEX threads_owner_created_idx
  ON threads(owner_user_id, created_at DESC, id DESC);

CREATE INDEX threads_owner_project_created_idx
  ON threads(owner_user_id, project_id, created_at DESC, id DESC);

create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null);

create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade, "activeOrganizationId" text);

create table "account" ("id" text not null primary key, "issuer" text not null, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create table "organization" ("id" text not null primary key, "name" text not null, "slug" text not null unique, "logo" text, "createdAt" date not null, "metadata" text);

create table "member" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "role" text not null, "createdAt" date not null);

create table "invitation" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "email" text not null, "role" text, "status" text not null, "expiresAt" date not null, "createdAt" date not null, "inviterId" text not null references "user" ("id") on delete cascade);

create table "apikey" ("id" text not null primary key, "configId" text not null, "name" text, "start" text, "referenceId" text not null, "prefix" text, "key" text not null, "refillInterval" integer, "refillAmount" integer, "lastRefillAt" date, "enabled" integer, "rateLimitEnabled" integer, "rateLimitTimeWindow" integer, "rateLimitMax" integer, "requestCount" integer, "remaining" integer, "lastRequest" date, "expiresAt" date, "createdAt" date not null, "updatedAt" date not null, "permissions" text, "metadata" text);

create index "session_userId_idx" on "session" ("userId");

create index "account_userId_idx" on "account" ("userId");

create index "verification_identifier_idx" on "verification" ("identifier");

create index "member_organizationId_idx" on "member" ("organizationId");

create index "member_userId_idx" on "member" ("userId");

create index "invitation_organizationId_idx" on "invitation" ("organizationId");

create index "invitation_email_idx" on "invitation" ("email");

create index "apikey_configId_idx" on "apikey" ("configId");

create index "apikey_referenceId_idx" on "apikey" ("referenceId");

create index "apikey_key_idx" on "apikey" ("key");

create unique index "account_issuer_accountId_uidx" on "account" ("issuer", "accountId");

create unique index "member_organizationId_userId_uidx" on "member" ("organizationId", "userId");

create unique index "apikey_key_uidx" on "apikey" ("key");

create index "apikey_configId_referenceId_idx" on "apikey" ("configId", "referenceId");

CREATE TABLE "rateLimit" (
  "id" text NOT NULL PRIMARY KEY,
  "key" text NOT NULL UNIQUE,
  "count" integer NOT NULL,
  "lastRequest" integer NOT NULL
);

UPDATE "apikey"
SET
  "rateLimitEnabled" = 0,
  "rateLimitTimeWindow" = NULL,
  "rateLimitMax" = NULL,
  "requestCount" = 0,
  "remaining" = NULL,
  "lastRequest" = NULL
WHERE "configId" IN ('user-keys', 'org-keys');

CREATE TABLE personal_account (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
  display_name TEXT NOT NULL
    CHECK (display_name = trim(display_name))
    CHECK (length(display_name) BETWEEN 1 AND 128),
  username TEXT NOT NULL COLLATE NOCASE
    CHECK (username = lower(username))
    CHECK (length(username) BETWEEN 3 AND 32)
    CHECK (username NOT GLOB '*[^a-z0-9-]*')
    CHECK (substr(username, 1, 1) GLOB '[a-z0-9]')
    CHECK (substr(username, -1, 1) GLOB '[a-z0-9]'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX personal_account_username_uidx
  ON personal_account (username COLLATE NOCASE);

INSERT INTO personal_account (
  user_id,
  display_name,
  username,
  created_at,
  updated_at
)
SELECT
  id,
  CASE
    WHEN length(trim(name)) = 0 THEN 'User'
    ELSE substr(trim(name), 1, 128)
  END ,
  'user-' || lower(hex(randomblob(12))),
  datetime('now'),
  datetime('now')
FROM "user";

CREATE TRIGGER personal_account_after_user_insert
AFTER INSERT ON "user"
BEGIN
  INSERT INTO personal_account (
    user_id,
    display_name,
    username,
    created_at,
    updated_at
  ) VALUES (
    NEW.id,
    CASE
      WHEN length(trim(NEW.name)) = 0 THEN 'User'
      ELSE substr(trim(NEW.name), 1, 128)
    END ,
    'user-' || lower(hex(randomblob(12))),
    datetime('now'),
    datetime('now')
  );
END;

CREATE TABLE personal_agent_instructions (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '' CHECK (length(content) <= 10000),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version = 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT INTO personal_agent_instructions (
  user_id,
  content,
  revision,
  version,
  created_at,
  updated_at
)
SELECT id, '', 0, 1, datetime('now'), datetime('now')
FROM "user";

CREATE TRIGGER personal_agent_instructions_after_user_insert
AFTER INSERT ON "user"
BEGIN
  INSERT INTO personal_agent_instructions (
    user_id,
    content,
    revision,
    version,
    created_at,
    updated_at
  ) VALUES (NEW.id, '', 0, 1, datetime('now'), datetime('now'));
END;

ALTER TABLE threads
  ADD COLUMN agent_instructions TEXT NOT NULL DEFAULT ''
    CHECK (length(agent_instructions) <= 10000);

ALTER TABLE threads
  ADD COLUMN agent_instructions_revision INTEGER NOT NULL DEFAULT 0
    CHECK (agent_instructions_revision >= 0);

ALTER TABLE threads
  ADD COLUMN agent_instructions_version INTEGER NOT NULL DEFAULT 1
    CHECK (agent_instructions_version = 1);

ALTER TABLE organization
  ADD COLUMN lifecycleState TEXT NOT NULL DEFAULT 'active'
    CHECK (lifecycleState IN (
      'active',
      'deletion-pending',
      'deleting',
      'deletion-failed'
    ));

CREATE UNIQUE INDEX member_userId_uidx
  ON member (userId);

CREATE UNIQUE INDEX organization_slug_nocase_uidx
  ON organization (slug COLLATE NOCASE);

CREATE TRIGGER workspace_organization_profile_before_insert
BEFORE INSERT ON organization
WHEN
  NEW.name <> trim(NEW.name)
  OR length(NEW.name) NOT BETWEEN 1 AND 128
  OR NEW.slug <> lower(NEW.slug)
  OR length(NEW.slug) NOT BETWEEN 3 AND 63
  OR NEW.slug GLOB '*[^a-z0-9-]*'
  OR substr(NEW.slug, 1, 1) NOT GLOB '[a-z0-9]'
  OR substr(NEW.slug, -1, 1) NOT GLOB '[a-z0-9]'
BEGIN
  SELECT RAISE(ABORT, 'invalid workspace profile');
END;

CREATE TRIGGER workspace_organization_profile_before_update
BEFORE UPDATE OF name, slug ON organization
WHEN
  NEW.name <> trim(NEW.name)
  OR length(NEW.name) NOT BETWEEN 1 AND 128
  OR NEW.slug <> lower(NEW.slug)
  OR length(NEW.slug) NOT BETWEEN 3 AND 63
  OR NEW.slug GLOB '*[^a-z0-9-]*'
  OR substr(NEW.slug, 1, 1) NOT GLOB '[a-z0-9]'
  OR substr(NEW.slug, -1, 1) NOT GLOB '[a-z0-9]'
BEGIN
  SELECT RAISE(ABORT, 'invalid workspace profile');
END;

CREATE TABLE workspace_invite_capability (
  id TEXT NOT NULL PRIMARY KEY,
  organization_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE CASCADE,
  capability_hash TEXT NOT NULL
    CHECK (
      length(capability_hash) = 64
      AND capability_hash NOT GLOB '*[^a-f0-9]*'
    ),
  kind TEXT NOT NULL CHECK (kind IN ('email', 'link')),
  email TEXT,
  domain TEXT,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role = 'member'),
  expires_at INTEGER NOT NULL,
  max_uses INTEGER NOT NULL CHECK (max_uses BETWEEN 1 AND 100),
  use_count INTEGER NOT NULL DEFAULT 0
    CHECK (use_count BETWEEN 0 AND max_uses),
  created_at INTEGER NOT NULL,
  created_by_user_id TEXT NOT NULL
    REFERENCES user (id) ON DELETE CASCADE,
  revoked_at INTEGER,
  last_used_at INTEGER,
  last_acceptance_id TEXT,
  CHECK (
    (kind = 'email' AND email IS NOT NULL AND domain IS NULL AND max_uses = 1)
    OR (kind = 'link' AND email IS NULL)
  )
);

CREATE INDEX workspace_invite_capability_organization_created_idx
  ON workspace_invite_capability (organization_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX workspace_invite_capability_hash_uidx
  ON workspace_invite_capability (capability_hash);

CREATE TRIGGER workspace_invite_capability_normalized_before_insert
BEFORE INSERT ON workspace_invite_capability
WHEN
  (NEW.email IS NOT NULL AND (
    NEW.email <> lower(trim(NEW.email))
    OR instr(NEW.email, '@') <= 1
  ))
  OR (NEW.domain IS NOT NULL AND (
    NEW.domain <> lower(trim(NEW.domain))
    OR length(NEW.domain) NOT BETWEEN 1 AND 253
    OR NEW.domain GLOB '*[^a-z0-9.-]*'
    OR substr(NEW.domain, 1, 1) NOT GLOB '[a-z0-9]'
    OR substr(NEW.domain, -1, 1) NOT GLOB '[a-z0-9]'
  ))
BEGIN
  SELECT RAISE(ABORT, 'invalid workspace invitation target');
END;

CREATE TRIGGER workspace_member_role_before_insert
BEFORE INSERT ON member
WHEN NEW.role NOT IN ('owner', 'admin', 'member')
BEGIN
  SELECT RAISE(ABORT, 'invalid workspace role');
END;

CREATE TRIGGER workspace_member_role_before_update
BEFORE UPDATE OF role ON member
WHEN NEW.role NOT IN ('owner', 'admin', 'member')
BEGIN
  SELECT RAISE(ABORT, 'invalid workspace role');
END;

CREATE TRIGGER workspace_owner_role_immutable_before_update
BEFORE UPDATE OF role ON member
WHEN OLD.role = 'owner' AND NEW.role <> 'owner'
BEGIN
  SELECT RAISE(ABORT, 'workspace owner is immutable');
END;

CREATE TRIGGER workspace_admin_coverage_before_update
BEFORE UPDATE OF role ON member
WHEN
  OLD.role IN ('owner', 'admin')
  AND NEW.role = 'member'
  AND (
    SELECT count(*)
    FROM member
    WHERE organizationId = OLD.organizationId
      AND role IN ('owner', 'admin')
  ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'workspace admin coverage required');
END;

CREATE TABLE security_recent_authentication (
  session_id TEXT NOT NULL PRIMARY KEY
    REFERENCES session (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL
    REFERENCES user (id) ON DELETE CASCADE,
  authority TEXT NOT NULL
    CHECK (authority IN ('local-password', 'cloudflare-access')),
  verified_at INTEGER NOT NULL
);

CREATE INDEX security_recent_authentication_user_idx
  ON security_recent_authentication (user_id, verified_at DESC);

CREATE INDEX session_user_active_updated_idx
  ON session (userId, expiresAt, updatedAt DESC, id DESC);

CREATE INDEX apikey_reference_config_created_idx
  ON apikey (referenceId, configId, createdAt DESC, id DESC);

UPDATE apikey
SET permissions = '{"dx":["projects:read","projects:write","threads:read","threads:write","agents:access","settings:read","settings:write"]}'
WHERE configId = 'user-keys'
  AND (
    permissions IS NULL
    OR permissions = '{"dx":["personal"]}'
  );

CREATE TABLE environment_variable (
  id TEXT NOT NULL PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'project', 'workspace')),
  target_id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE BINARY
    CHECK (length(name) BETWEEN 1 AND 64)
    CHECK (name NOT GLOB '*[^A-Z0-9_]*')
    CHECK (substr(name, 1, 1) GLOB '[A-Z_]'),
  kind TEXT NOT NULL CHECK (kind IN ('secret', 'variable')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  policy_locked INTEGER NOT NULL DEFAULT 0
    CHECK (policy_locked IN (0, 1))
    CHECK (policy_locked = 0 OR scope = 'workspace'),
  envelope_version INTEGER NOT NULL CHECK (envelope_version = 1),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  value_nonce TEXT NOT NULL CHECK (length(value_nonce) = 16),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 24 AND 65536),
  wrapped_key_nonce TEXT NOT NULL CHECK (length(wrapped_key_nonce) = 16),
  wrapped_key TEXT NOT NULL CHECK (length(wrapped_key) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rotated_at TEXT NOT NULL,
  UNIQUE (scope, target_id, name)
);

CREATE INDEX environment_variable_target_name_idx
  ON environment_variable (scope, target_id, name, id);

CREATE INDEX environment_variable_target_enabled_idx
  ON environment_variable (scope, target_id, enabled, policy_locked, name);

CREATE TABLE model_connection (
  id TEXT NOT NULL PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  target_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK (
    kind IN (
      'workers-ai-binding',
      'built-in-deployment',
      'openai-platform',
      'openai-compatible'
    )
  ),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
  endpoint TEXT CHECK (endpoint IS NULL OR length(endpoint) BETWEEN 1 AND 2048),
  credential_reference_id TEXT REFERENCES environment_variable(id) ON DELETE RESTRICT,
  retention TEXT NOT NULL CHECK (
    retention IN ('provider-policy', 'zero-data-retention', 'may-retain')
  ),
  configured_models TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(configured_models)),
  health_state TEXT NOT NULL DEFAULT 'untested'
    CHECK (health_state IN ('untested', 'healthy', 'unhealthy', 'unavailable')),
  health_code TEXT NOT NULL DEFAULT 'NOT_TESTED' CHECK (length(health_code) BETWEEN 1 AND 64),
  health_checked_at TEXT,
  health_latency_ms INTEGER CHECK (health_latency_ms BETWEEN 0 AND 30000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope, target_id, name)
);

CREATE INDEX model_connection_target_idx
  ON model_connection (scope, target_id, name, id);

CREATE TABLE model_routing_policy (
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  target_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  policy TEXT NOT NULL CHECK (json_valid(policy)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, target_id)
);

ALTER TABLE threads ADD COLUMN model_route_snapshot TEXT NOT NULL DEFAULT
  '{"version":1,"profile":{"id":"medium","version":1},"sourceScope":"personal","configurationRevision":0,"alias":"default","selected":{"connectionId":"deployment-workers-ai","providerId":"cloudflare","modelId":"@cf/zai-org/glm-5.2","model":"cloudflare/@cf/zai-org/glm-5.2","credentialOwner":"deployment","retention":"provider-policy"},"candidates":[{"connectionId":"deployment-workers-ai","providerId":"cloudflare","modelId":"@cf/zai-org/glm-5.2","model":"cloudflare/@cf/zai-org/glm-5.2","credentialOwner":"deployment","retention":"provider-policy"}],"thinkingLevel":"medium","compaction":{"reserveTokens":20000,"keepRecentTokens":8000}}'
  CHECK (json_valid(model_route_snapshot));

CREATE TABLE mcp_server (
  id TEXT NOT NULL PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 128),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  target_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  endpoint TEXT NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 2048),
  transport TEXT NOT NULL DEFAULT 'streamable-http'
    CHECK (transport = 'streamable-http'),
  auth_environment_variable_id TEXT,
  timeout_ms INTEGER NOT NULL DEFAULT 10000
    CHECK (timeout_ms BETWEEN 1000 AND 30000),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  project_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(project_ids_json) AND json_type(project_ids_json) = 'array'),
  roles_json TEXT NOT NULL DEFAULT '["owner","admin","member"]'
    CHECK (json_valid(roles_json) AND json_type(roles_json) = 'array'),
  health_status TEXT NOT NULL DEFAULT 'unchecked'
    CHECK (health_status IN ('unchecked', 'healthy', 'unhealthy')),
  health_checked_at TEXT,
  health_error_code TEXT CHECK (
    health_error_code IS NULL OR length(health_error_code) BETWEEN 1 AND 64
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope, target_id, name)
);

CREATE INDEX mcp_server_target_idx
  ON mcp_server (scope, target_id, name, id);

CREATE INDEX mcp_server_execution_idx
  ON mcp_server (enabled, scope, target_id, id);

CREATE TABLE mcp_tool (
  server_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  description TEXT NOT NULL CHECK (length(description) <= 4096),
  input_schema_json TEXT NOT NULL
    CHECK (length(input_schema_json) BETWEEN 2 AND 32768)
    CHECK (json_valid(input_schema_json)),
  schema_hash TEXT NOT NULL
    CHECK (length(schema_hash) = 64)
    CHECK (schema_hash NOT GLOB '*[^a-f0-9]*'),
  approved_schema_hash TEXT CHECK (
    approved_schema_hash IS NULL OR (
      length(approved_schema_hash) = 64 AND
      approved_schema_hash NOT GLOB '*[^a-f0-9]*'
    )
  ),
  discovered_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by TEXT,
  PRIMARY KEY (server_id, name),
  FOREIGN KEY (server_id) REFERENCES mcp_server(id) ON DELETE CASCADE
);

CREATE INDEX mcp_tool_approved_idx
  ON mcp_tool (server_id, approved_schema_hash, name);

CREATE TABLE mcp_workspace_policy (
  workspace_id TEXT NOT NULL PRIMARY KEY,
  allow_personal_servers INTEGER NOT NULL DEFAULT 1
    CHECK (allow_personal_servers IN (0, 1)),
  FOREIGN KEY (workspace_id) REFERENCES organization(id) ON DELETE CASCADE
);

ALTER TABLE projects
  ADD COLUMN workspace_id TEXT REFERENCES organization(id) ON DELETE RESTRICT;

ALTER TABLE projects
  ADD COLUMN ship_action TEXT NOT NULL DEFAULT 'ship'
    CHECK (ship_action IN ('ship', 'commit'));

ALTER TABLE projects
  ADD COLUMN commit_author_preference TEXT NOT NULL DEFAULT 'dx'
    CHECK (commit_author_preference IN ('dx', 'user'));

ALTER TABLE projects
  ADD COLUMN commit_author_name TEXT NOT NULL DEFAULT 'dx'
    CHECK (length(commit_author_name) BETWEEN 1 AND 128);

ALTER TABLE projects
  ADD COLUMN commit_author_email TEXT NOT NULL DEFAULT 'noreply@dx.local'
    CHECK (length(commit_author_email) BETWEEN 3 AND 254);

ALTER TABLE projects
  ADD COLUMN signing_preference TEXT NOT NULL DEFAULT 'disabled'
    CHECK (signing_preference IN ('disabled', 'preferred', 'required'));

ALTER TABLE projects
  ADD COLUMN runner_profile_id TEXT NOT NULL DEFAULT 'e2b-default'
    CHECK (length(runner_profile_id) BETWEEN 1 AND 64);

ALTER TABLE projects
  ADD COLUMN public_code_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (public_code_enabled IN (0, 1));

CREATE INDEX projects_workspace_created_idx
  ON projects(workspace_id, created_at DESC, id DESC)
  WHERE workspace_id IS NOT NULL;

CREATE TABLE personal_project_defaults (
  user_id TEXT NOT NULL PRIMARY KEY
    REFERENCES "user"(id) ON DELETE CASCADE,
  ship_action TEXT CHECK (ship_action IS NULL OR ship_action IN ('ship', 'commit')),
  commit_author_preference TEXT
    CHECK (commit_author_preference IS NULL OR commit_author_preference IN ('dx', 'user')),
  signing_preference TEXT
    CHECK (signing_preference IS NULL OR signing_preference IN ('disabled', 'preferred', 'required')),
  runner_profile_id TEXT
    CHECK (runner_profile_id IS NULL OR length(runner_profile_id) BETWEEN 1 AND 64),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE workspace_project_defaults (
  workspace_id TEXT NOT NULL PRIMARY KEY
    REFERENCES organization(id) ON DELETE CASCADE,
  ship_action TEXT CHECK (ship_action IS NULL OR ship_action IN ('ship', 'commit')),
  commit_author_preference TEXT
    CHECK (commit_author_preference IS NULL OR commit_author_preference IN ('dx', 'user')),
  signing_preference TEXT
    CHECK (signing_preference IS NULL OR signing_preference IN ('disabled', 'preferred', 'required')),
  runner_profile_id TEXT
    CHECK (runner_profile_id IS NULL OR length(runner_profile_id) BETWEEN 1 AND 64),
  allow_member_project_creation INTEGER NOT NULL DEFAULT 1
    CHECK (allow_member_project_creation IN (0, 1)),
  allow_public_code_access INTEGER NOT NULL DEFAULT 0
    CHECK (allow_public_code_access IN (0, 1)),
  allowed_runner_profile_ids TEXT
    CHECK (allowed_runner_profile_ids IS NULL OR json_valid(allowed_runner_profile_ids)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE integration_credential (
  id TEXT NOT NULL PRIMARY KEY,
  owner_scope TEXT NOT NULL CHECK (owner_scope IN ('personal', 'workspace')),
  owner_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('access-token', 'refresh-token', 'pkce-verifier')),
  envelope_version INTEGER NOT NULL CHECK (envelope_version = 1),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  value_nonce TEXT NOT NULL CHECK (length(value_nonce) = 16),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 24 AND 65536),
  wrapped_key_nonce TEXT NOT NULL CHECK (length(wrapped_key_nonce) = 16),
  wrapped_key TEXT NOT NULL CHECK (length(wrapped_key) = 64),
  created_at TEXT NOT NULL,
  rotated_at TEXT NOT NULL
);

CREATE INDEX integration_credential_owner_idx
  ON integration_credential (owner_scope, owner_id, id);

CREATE TABLE integration_connection (
  id TEXT NOT NULL PRIMARY KEY,
  owner_scope TEXT NOT NULL CHECK (owner_scope IN ('personal', 'workspace')),
  owner_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'forgejo')),
  status TEXT NOT NULL CHECK (status IN ('connected', 'needs-reauthorization', 'disconnected')),
  health TEXT NOT NULL CHECK (health IN ('healthy', 'expired', 'degraded', 'revoked')),
  provider_account_id TEXT NOT NULL,
  provider_account_login TEXT NOT NULL,
  granted_scopes TEXT NOT NULL,
  access_token_reference_id TEXT REFERENCES integration_credential (id),
  refresh_token_reference_id TEXT REFERENCES integration_credential (id),
  expires_at TEXT,
  refresh_expires_at TEXT,
  last_health_check_at TEXT,
  revoked_at TEXT,
  revocation_status TEXT NOT NULL
    CHECK (revocation_status IN ('not-requested', 'pending', 'completed')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_scope, owner_id, provider)
);

CREATE INDEX integration_connection_owner_idx
  ON integration_connection (owner_scope, owner_id, provider);

CREATE TABLE integration_repository (
  connection_id TEXT NOT NULL
    REFERENCES integration_connection (id) ON DELETE CASCADE,
  provider_repository_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  web_url TEXT NOT NULL,
  clone_url TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private', 'internal')),
  selected INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
  last_authorized_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, provider_repository_id)
);

CREATE INDEX integration_repository_selected_idx
  ON integration_repository (connection_id, selected, full_name);

CREATE TABLE integration_oauth_transaction (
  id TEXT NOT NULL PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE
    CHECK (length(state_hash) = 64 AND state_hash NOT GLOB '*[^a-f0-9]*'),
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  browser_session_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'forgejo')),
  verifier_reference_id TEXT NOT NULL REFERENCES integration_credential (id),
  callback_url TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX integration_oauth_transaction_expiry_idx
  ON integration_oauth_transaction (expires_at, consumed_at);

CREATE TABLE integration_resource_binding (
  connection_id TEXT NOT NULL
    REFERENCES integration_connection (id) ON DELETE CASCADE,
  resource_kind TEXT NOT NULL CHECK (resource_kind IN ('project', 'job', 'preview')),
  resource_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, resource_kind, resource_id)
);

CREATE INDEX integration_resource_binding_impact_idx
  ON integration_resource_binding (connection_id, resource_kind);

CREATE TABLE external_api_application (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL
    REFERENCES organization (id) ON DELETE RESTRICT,
  owner_user_id TEXT NOT NULL
    REFERENCES "user" (id) ON DELETE RESTRICT,
  client_id TEXT NOT NULL UNIQUE
    CHECK (client_id GLOB 'dxa_*' AND length(client_id) BETWEEN 16 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64 AND name = trim(name)),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'revoked')),
  scopes TEXT NOT NULL CHECK (json_valid(scopes)),
  rate_limit_per_minute INTEGER NOT NULL
    CHECK (rate_limit_per_minute BETWEEN 10 AND 1000),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  CHECK (
    (status = 'revoked' AND revoked_at IS NOT NULL)
    OR (status <> 'revoked' AND revoked_at IS NULL)
  )
);

CREATE INDEX external_api_application_workspace_created_idx
  ON external_api_application (workspace_id, created_at DESC, id DESC);

CREATE TABLE external_api_application_credential (
  id TEXT NOT NULL PRIMARY KEY,
  application_id TEXT NOT NULL
    REFERENCES external_api_application (id) ON DELETE RESTRICT,
  secret_hash TEXT NOT NULL UNIQUE
    CHECK (
      length(secret_hash) = 64
      AND secret_hash NOT GLOB '*[^a-f0-9]*'
    ),
  identifier TEXT NOT NULL CHECK (length(identifier) BETWEEN 8 AND 24),
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  revoked_at INTEGER,
  CHECK (expires_at IS NULL OR expires_at >= created_at)
);

CREATE INDEX external_api_application_credential_active_idx
  ON external_api_application_credential (
    application_id, revoked_at, expires_at, created_at DESC, id DESC
  );

CREATE TABLE external_api_application_rate_limit (
  application_id TEXT NOT NULL PRIMARY KEY
    REFERENCES external_api_application (id) ON DELETE RESTRICT,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0)
);

CREATE TABLE external_api_application_audit (
  id TEXT NOT NULL PRIMARY KEY,
  application_id TEXT NOT NULL
    REFERENCES external_api_application (id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL,
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'application')),
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'rejected', 'authorized')),
  request_id TEXT NOT NULL,
  credential_id TEXT,
  scope TEXT CHECK (
    scope IS NULL OR scope IN (
      'projects:read',
      'projects:write',
      'threads:read',
      'threads:write'
    )
  ),
  http_method TEXT,
  http_path TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX external_api_application_audit_application_created_idx
  ON external_api_application_audit (
    application_id, created_at DESC, id DESC
  );

CREATE TRIGGER external_api_application_audit_immutable_update
BEFORE UPDATE ON external_api_application_audit
BEGIN
  SELECT RAISE(ABORT, 'external API application audit is immutable');
END;

CREATE TRIGGER external_api_application_audit_immutable_delete
BEFORE DELETE ON external_api_application_audit
BEGIN
  SELECT RAISE(ABORT, 'external API application audit is immutable');
END;

CREATE TABLE workspace_policy (
  workspace_id TEXT NOT NULL PRIMARY KEY
    REFERENCES organization(id) ON DELETE CASCADE,
  thread_default_visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (thread_default_visibility IN ('private', 'workspace')),
  allow_workspace_thread_visibility INTEGER NOT NULL DEFAULT 1
    CHECK (allow_workspace_thread_visibility IN (0, 1)),
  allow_external_thread_sharing INTEGER NOT NULL DEFAULT 0
    CHECK (allow_external_thread_sharing IN (0, 1)),
  allowed_runner_profile_ids TEXT
    CHECK (
      allowed_runner_profile_ids IS NULL
      OR (
        json_valid(allowed_runner_profile_ids)
        AND json_type(allowed_runner_profile_ids) = 'array'
      )
    ),
  allow_remote_runners INTEGER NOT NULL DEFAULT 1
    CHECK (allow_remote_runners IN (0, 1)),
  allow_remote_control INTEGER NOT NULL DEFAULT 0
    CHECK (allow_remote_control IN (0, 1)),
  allow_personal_provider_overrides INTEGER NOT NULL DEFAULT 1
    CHECK (allow_personal_provider_overrides IN (0, 1)),
  allow_personal_mcp_overrides INTEGER NOT NULL DEFAULT 1
    CHECK (allow_personal_mcp_overrides IN (0, 1)),
  allow_personal_secret_overrides INTEGER NOT NULL DEFAULT 1
    CHECK (allow_personal_secret_overrides IN (0, 1)),
  require_strong_authentication INTEGER NOT NULL DEFAULT 0
    CHECK (require_strong_authentication IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL,
  CHECK (
    allow_workspace_thread_visibility = 1
    OR thread_default_visibility = 'private'
  )
);

INSERT INTO workspace_policy (
  workspace_id,
  allowed_runner_profile_ids,
  updated_at
)
SELECT
  organization.id,
  CASE
    WHEN json_type(workspace_project_defaults.allowed_runner_profile_ids) = 'array'
      THEN workspace_project_defaults.allowed_runner_profile_ids
    ELSE NULL
  END ,
  '1970-01-01T00:00:00.000Z'
FROM organization
LEFT JOIN workspace_project_defaults
  ON workspace_project_defaults.workspace_id = organization.id;

CREATE TRIGGER workspace_policy_after_organization_insert
AFTER INSERT ON organization
BEGIN
  INSERT INTO workspace_policy (workspace_id, updated_at)
  VALUES (NEW.id, '1970-01-01T00:00:00.000Z');
END;

CREATE TABLE workspace_policy_audit_event (
  id TEXT NOT NULL PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'rejected')),
  reason TEXT,
  previous_revision INTEGER NOT NULL CHECK (previous_revision >= 0),
  next_revision INTEGER,
  changed_fields TEXT NOT NULL CHECK (
    json_valid(changed_fields) AND json_type(changed_fields) = 'array'
  ),
  created_at TEXT NOT NULL,
  CHECK (
    (outcome = 'success' AND reason IS NULL AND next_revision = previous_revision + 1)
    OR (outcome = 'rejected' AND reason IS NOT NULL AND next_revision IS NULL)
  )
);

CREATE INDEX workspace_policy_audit_workspace_created_idx
  ON workspace_policy_audit_event(workspace_id, created_at DESC, id DESC);

CREATE TRIGGER workspace_policy_audit_event_immutable_update
BEFORE UPDATE ON workspace_policy_audit_event
BEGIN
  SELECT RAISE(ABORT, 'workspace policy audit events are immutable');
END;

CREATE TRIGGER workspace_policy_audit_event_immutable_delete
BEFORE DELETE ON workspace_policy_audit_event
BEGIN
  SELECT RAISE(ABORT, 'workspace policy audit events are immutable');
END;

CREATE TRIGGER workspace_policy_strong_authentication_irreversible
BEFORE UPDATE OF require_strong_authentication ON workspace_policy
WHEN OLD.require_strong_authentication = 1
  AND NEW.require_strong_authentication = 0
BEGIN
  SELECT RAISE(ABORT, 'strong authentication requirement is irreversible');
END;

ALTER TABLE threads
  ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'workspace'));

ALTER TABLE threads
  ADD COLUMN workspace_policy_revision INTEGER NOT NULL DEFAULT 0
    CHECK (workspace_policy_revision >= 0);

ALTER TABLE threads
  ADD COLUMN workspace_policy_migration_state TEXT NOT NULL DEFAULT 'grandfathered'
    CHECK (workspace_policy_migration_state IN ('grandfathered', 'current'));

CREATE TABLE personal_signing_key (
  id TEXT NOT NULL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  backend TEXT NOT NULL CHECK (backend = 'managed-ssh-ed25519'),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  public_key TEXT NOT NULL CHECK (public_key LIKE 'ssh-ed25519 %'),
  fingerprint TEXT NOT NULL CHECK (fingerprint LIKE 'SHA256:%'),
  envelope_version INTEGER,
  key_version INTEGER,
  value_nonce TEXT,
  ciphertext TEXT,
  wrapped_key_nonce TEXT,
  wrapped_key TEXT,
  created_at TEXT NOT NULL,
  rotated_at TEXT NOT NULL,
  revoked_at TEXT,
  replaced_by_id TEXT REFERENCES personal_signing_key(id) ON DELETE SET NULL,
  UNIQUE (user_id, fingerprint),
  CHECK (
    (
      status = 'active'
      AND envelope_version = 1
      AND key_version IS NOT NULL
      AND value_nonce IS NOT NULL
      AND ciphertext IS NOT NULL
      AND wrapped_key_nonce IS NOT NULL
      AND wrapped_key IS NOT NULL
      AND revoked_at IS NULL
    )
    OR
    (
      status = 'revoked'
      AND envelope_version IS NULL
      AND key_version IS NULL
      AND value_nonce IS NULL
      AND ciphertext IS NULL
      AND wrapped_key_nonce IS NULL
      AND wrapped_key IS NULL
      AND revoked_at IS NOT NULL
    )
  )
);

CREATE UNIQUE INDEX personal_signing_key_active_user_uidx
  ON personal_signing_key(user_id)
  WHERE status = 'active';

CREATE INDEX personal_signing_key_user_created_idx
  ON personal_signing_key(user_id, created_at DESC, id DESC);

CREATE TABLE personal_verification_key (
  id TEXT NOT NULL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  algorithm TEXT NOT NULL CHECK (algorithm = 'ssh-ed25519'),
  public_key TEXT NOT NULL CHECK (public_key LIKE 'ssh-ed25519 %'),
  fingerprint TEXT NOT NULL CHECK (fingerprint LIKE 'SHA256:%'),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (user_id, fingerprint),
  CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);

CREATE INDEX personal_verification_key_user_created_idx
  ON personal_verification_key(user_id, created_at DESC, id DESC);

CREATE TABLE skill (
  id TEXT NOT NULL PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 128),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  target_id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE BINARY
    CHECK (length(name) BETWEEN 1 AND 64),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  active_version INTEGER NOT NULL DEFAULT 1 CHECK (active_version >= 1),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE (scope, target_id, name)
);

CREATE INDEX skill_target_idx
  ON skill (scope, target_id, name, id);

CREATE INDEX skill_resolution_idx
  ON skill (enabled, removed_at, scope, target_id, name, id);

CREATE TABLE skill_version (
  skill_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 1024),
  instructions TEXT NOT NULL CHECK (length(instructions) BETWEEN 1 AND 32768),
  manifest_json TEXT NOT NULL
    CHECK (length(manifest_json) BETWEEN 2 AND 16384)
    CHECK (json_valid(manifest_json) AND json_type(manifest_json) = 'object'),
  mcp_server_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (length(mcp_server_ids_json) BETWEEN 2 AND 4096)
    CHECK (
      json_valid(mcp_server_ids_json)
      AND json_type(mcp_server_ids_json) = 'array'
      AND json_array_length(mcp_server_ids_json) <= 10
    ),
  source_type TEXT NOT NULL CHECK (source_type = 'browser-files'),
  source_label TEXT NOT NULL CHECK (length(source_label) BETWEEN 1 AND 128),
  integrity TEXT NOT NULL
    CHECK (length(integrity) = 64)
    CHECK (integrity NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  PRIMARY KEY (skill_id, version),
  FOREIGN KEY (skill_id) REFERENCES skill(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX skill_version_integrity_uidx
  ON skill_version (skill_id, integrity);

CREATE TABLE skill_resource (
  skill_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 256),
  media_type TEXT NOT NULL CHECK (length(media_type) BETWEEN 1 AND 128),
  content TEXT NOT NULL CHECK (length(content) <= 65536),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 0 AND 65536),
  integrity TEXT NOT NULL
    CHECK (length(integrity) = 64)
    CHECK (integrity NOT GLOB '*[^a-f0-9]*'),
  PRIMARY KEY (skill_id, version, path),
  FOREIGN KEY (skill_id, version)
    REFERENCES skill_version(skill_id, version) ON DELETE CASCADE
);

CREATE TABLE skill_workspace_policy (
  workspace_id TEXT NOT NULL PRIMARY KEY
    REFERENCES organization(id) ON DELETE CASCADE,
  allow_personal_skills INTEGER NOT NULL DEFAULT 1
    CHECK (allow_personal_skills IN (0, 1))
);

ALTER TABLE threads
  ADD COLUMN skill_snapshot_json TEXT NOT NULL DEFAULT '[]'
    CHECK (length(skill_snapshot_json) <= 32768)
    CHECK (
      json_valid(skill_snapshot_json)
      AND json_type(skill_snapshot_json) = 'array'
      AND json_array_length(skill_snapshot_json) <= 40
    );

CREATE TABLE usage_price (
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 256),
  currency TEXT NOT NULL CHECK (currency = 'USD'),
  source TEXT NOT NULL CHECK (source IN ('deployment', 'catalog')),
  source_version TEXT NOT NULL CHECK (length(source_version) BETWEEN 1 AND 128),
  input_micros_per_million INTEGER NOT NULL CHECK (input_micros_per_million >= 0),
  output_micros_per_million INTEGER NOT NULL CHECK (output_micros_per_million >= 0),
  cache_read_micros_per_million INTEGER NOT NULL CHECK (cache_read_micros_per_million >= 0),
  cache_write_micros_per_million INTEGER NOT NULL CHECK (cache_write_micros_per_million >= 0),
  effective_from TEXT NOT NULL,
  effective_to TEXT CHECK (effective_to IS NULL OR effective_to > effective_from),
  fresh_until TEXT NOT NULL CHECK (fresh_until >= effective_from),
  estimated INTEGER NOT NULL DEFAULT 1 CHECK (estimated = 1),
  created_at TEXT NOT NULL,
  PRIMARY KEY (provider_id, model_id, source, source_version, effective_from)
);

CREATE INDEX usage_price_effective_idx
  ON usage_price (
    provider_id,
    model_id,
    effective_from DESC,
    effective_to,
    fresh_until
  );

CREATE TABLE usage_event (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 512),
  kind TEXT NOT NULL CHECK (kind IN ('model', 'submission', 'tool', 'runner')),
  owner_user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > occurred_at),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'error', 'cancelled', 'unknown')),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  submission_id TEXT,
  turn_id TEXT,
  turn_purpose TEXT CHECK (
    turn_purpose IS NULL OR turn_purpose IN ('agent', 'compaction', 'compaction_prefix')
  ),
  connection_id TEXT NOT NULL CHECK (length(connection_id) BETWEEN 1 AND 128),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
  model_id TEXT NOT NULL CHECK (length(model_id) BETWEEN 1 AND 256),
  model_route_version INTEGER NOT NULL CHECK (model_route_version >= 1),
  model_profile_id TEXT NOT NULL CHECK (length(model_profile_id) BETWEEN 1 AND 64),
  model_profile_version INTEGER NOT NULL CHECK (model_profile_version >= 1),
  model_configuration_revision INTEGER NOT NULL CHECK (model_configuration_revision >= 0),
  observed_provider_id TEXT,
  observed_provider_name TEXT,
  observed_model_id TEXT,
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  cache_read_tokens INTEGER CHECK (cache_read_tokens IS NULL OR cache_read_tokens >= 0),
  cache_write_tokens INTEGER CHECK (cache_write_tokens IS NULL OR cache_write_tokens >= 0),
  reasoning_tokens INTEGER CHECK (reasoning_tokens IS NULL OR reasoning_tokens >= 0),
  total_tokens INTEGER CHECK (total_tokens IS NULL OR total_tokens >= 0),
  tool_call_id TEXT,
  tool_name TEXT,
  tool_origin TEXT CHECK (
    tool_origin IS NULL OR tool_origin IN ('model', 'caller', 'framework', 'adapter')
  ),
  tool_runtime TEXT CHECK (tool_runtime IS NULL OR tool_runtime = 'flue'),
  runner_provider TEXT CHECK (runner_provider IS NULL OR runner_provider = 'e2b'),
  runner_decision TEXT CHECK (
    runner_decision IS NULL OR runner_decision IN ('create', 'connect')
  ),
  runner_id TEXT,
  runner_template TEXT,
  runner_active_timeout_ms INTEGER CHECK (
    runner_active_timeout_ms IS NULL OR runner_active_timeout_ms >= 0
  ),
  runner_profile_id TEXT,
  runner_profile_version INTEGER CHECK (
    runner_profile_version IS NULL OR runner_profile_version >= 0
  ),
  runner_cpu_cores REAL CHECK (runner_cpu_cores IS NULL OR runner_cpu_cores > 0),
  runner_memory_mb INTEGER CHECK (runner_memory_mb IS NULL OR runner_memory_mb >= 0),
  runner_disk_gb INTEGER CHECK (runner_disk_gb IS NULL OR runner_disk_gb >= 0),
  CHECK (
    (kind = 'model' AND turn_id IS NOT NULL AND turn_purpose IS NOT NULL
      AND observed_provider_id IS NOT NULL AND observed_provider_name IS NOT NULL
      AND observed_model_id IS NOT NULL)
    OR (kind = 'submission' AND submission_id IS NOT NULL)
    OR (kind = 'tool' AND tool_call_id IS NOT NULL AND tool_name IS NOT NULL
      AND tool_runtime = 'flue')
    OR (kind = 'runner' AND runner_provider = 'e2b'
      AND runner_decision IS NOT NULL AND runner_template IS NOT NULL
      AND runner_active_timeout_ms IS NOT NULL)
  )
);

CREATE INDEX usage_event_owner_time_idx
  ON usage_event (owner_user_id, occurred_at DESC, id DESC);

CREATE INDEX usage_event_expiry_idx
  ON usage_event (expires_at);

CREATE INDEX usage_event_owner_thread_time_idx
  ON usage_event (owner_user_id, thread_id, occurred_at DESC, id DESC);

CREATE INDEX usage_event_owner_project_time_idx
  ON usage_event (owner_user_id, project_id, occurred_at DESC, id DESC);

CREATE INDEX usage_event_owner_model_time_idx
  ON usage_event (owner_user_id, provider_id, model_id, occurred_at DESC, id DESC);

CREATE TRIGGER usage_event_immutable_update
BEFORE UPDATE ON usage_event
BEGIN
  SELECT RAISE(ABORT, 'usage events are immutable');
END;

ALTER TABLE workspace_policy
  ADD COLUMN allow_experimental_features INTEGER NOT NULL DEFAULT 1
    CHECK (allow_experimental_features IN (0, 1));

CREATE TABLE personal_experimental_feature_preferences (
  user_id TEXT NOT NULL PRIMARY KEY
    REFERENCES "user"(id) ON DELETE CASCADE,
  preferences TEXT NOT NULL DEFAULT '[]'
    CHECK (
      json_valid(preferences)
      AND json_type(preferences) = 'array'
    ),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at TEXT NOT NULL
);

CREATE TABLE trusted_plugin (
  id TEXT NOT NULL PRIMARY KEY
    CHECK (length(id) BETWEEN 1 AND 128),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  target_id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE BINARY
    CHECK (length(name) BETWEEN 1 AND 64),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  active_version TEXT NOT NULL CHECK (length(active_version) BETWEEN 5 AND 64),
  health_status TEXT NOT NULL DEFAULT 'unchecked'
    CHECK (health_status IN ('unchecked', 'healthy', 'unhealthy')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE (scope, target_id, name)
);

CREATE INDEX trusted_plugin_target_idx
  ON trusted_plugin (scope, target_id, name, id);

CREATE INDEX trusted_plugin_resolution_idx
  ON trusted_plugin (enabled, removed_at, scope, target_id, name, id);

CREATE TABLE trusted_plugin_version (
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL CHECK (length(version) BETWEEN 5 AND 64),
  manifest_json TEXT NOT NULL
    CHECK (length(manifest_json) BETWEEN 2 AND 32768)
    CHECK (json_valid(manifest_json) AND json_type(manifest_json) = 'object'),
  grants_json TEXT NOT NULL
    CHECK (length(grants_json) BETWEEN 2 AND 16384)
    CHECK (json_valid(grants_json) AND json_type(grants_json) = 'object'),
  source_json TEXT NOT NULL
    CHECK (length(source_json) BETWEEN 2 AND 4096)
    CHECK (json_valid(source_json) AND json_type(source_json) = 'object'),
  integrity TEXT NOT NULL
    CHECK (length(integrity) = 64)
    CHECK (integrity NOT GLOB '*[^a-f0-9]*'),
  trusted INTEGER NOT NULL CHECK (trusted = 1),
  trusted_at TEXT NOT NULL,
  trusted_by_user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  PRIMARY KEY (plugin_id, version),
  FOREIGN KEY (plugin_id) REFERENCES trusted_plugin(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX trusted_plugin_version_integrity_uidx
  ON trusted_plugin_version (plugin_id, integrity);

CREATE TABLE trusted_plugin_file (
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 256),
  media_type TEXT NOT NULL CHECK (length(media_type) BETWEEN 1 AND 128),
  content TEXT NOT NULL CHECK (length(content) <= 65536),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 0 AND 65536),
  integrity TEXT NOT NULL
    CHECK (length(integrity) = 64)
    CHECK (integrity NOT GLOB '*[^a-f0-9]*'),
  PRIMARY KEY (plugin_id, version, path),
  FOREIGN KEY (plugin_id, version)
    REFERENCES trusted_plugin_version(plugin_id, version) ON DELETE CASCADE
);

CREATE TRIGGER trusted_plugin_version_no_update
BEFORE UPDATE ON trusted_plugin_version
BEGIN
  SELECT RAISE(ABORT, 'trusted plugin versions are immutable');
END;

CREATE TRIGGER trusted_plugin_version_no_delete
BEFORE DELETE ON trusted_plugin_version
BEGIN
  SELECT RAISE(ABORT, 'trusted plugin versions are immutable');
END;

CREATE TRIGGER trusted_plugin_file_no_update
BEFORE UPDATE ON trusted_plugin_file
BEGIN
  SELECT RAISE(ABORT, 'trusted plugin files are immutable');
END;

CREATE TRIGGER trusted_plugin_file_no_delete
BEFORE DELETE ON trusted_plugin_file
BEGIN
  SELECT RAISE(ABORT, 'trusted plugin files are immutable');
END;

CREATE TABLE trusted_plugin_workspace_policy (
  workspace_id TEXT NOT NULL PRIMARY KEY
    REFERENCES organization(id) ON DELETE CASCADE,
  allow_personal_plugins INTEGER NOT NULL DEFAULT 1
    CHECK (allow_personal_plugins IN (0, 1))
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

ALTER TABLE threads
  ADD COLUMN plugin_snapshot_json TEXT NOT NULL DEFAULT '[]'
    CHECK (length(plugin_snapshot_json) <= 32768)
    CHECK (
      json_valid(plugin_snapshot_json)
      AND json_type(plugin_snapshot_json) = 'array'
      AND json_array_length(plugin_snapshot_json) <= 40
    );

DROP TRIGGER usage_event_immutable_update;

ALTER TABLE usage_event ADD COLUMN workspace_id TEXT;

UPDATE usage_event
SET workspace_id = (
  SELECT member.organizationId
  FROM member
  WHERE member.userId = usage_event.owner_user_id
  LIMIT 1
);

CREATE INDEX usage_event_workspace_time_idx
  ON usage_event (workspace_id, occurred_at DESC, id DESC);

CREATE INDEX usage_event_workspace_user_time_idx
  ON usage_event (workspace_id, owner_user_id, occurred_at DESC, id DESC);

CREATE INDEX usage_event_workspace_project_time_idx
  ON usage_event (workspace_id, project_id, occurred_at DESC, id DESC);

CREATE INDEX usage_event_workspace_thread_time_idx
  ON usage_event (workspace_id, thread_id, occurred_at DESC, id DESC);

CREATE TRIGGER usage_event_immutable_update
BEFORE UPDATE ON usage_event
BEGIN
  SELECT RAISE(ABORT, 'usage events are immutable');
END;

ALTER TABLE threads ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'active'
  CHECK (lifecycle_state IN ('active', 'archived', 'deleted'));

CREATE INDEX threads_workspace_inspection_state_idx
  ON threads (owner_user_id, visibility, lifecycle_state, id);

DROP TRIGGER workspace_member_role_before_insert;
DROP TRIGGER workspace_member_role_before_update;
DROP TRIGGER workspace_admin_coverage_before_update;

CREATE TRIGGER workspace_member_role_before_insert
BEFORE INSERT ON member
WHEN NEW.role NOT IN ('owner', 'admin', 'auditor', 'member')
BEGIN
  SELECT RAISE(ABORT, 'invalid workspace role');
END;

CREATE TRIGGER workspace_member_role_before_update
BEFORE UPDATE OF role ON member
WHEN NEW.role NOT IN ('owner', 'admin', 'auditor', 'member')
BEGIN
  SELECT RAISE(ABORT, 'invalid workspace role');
END;

CREATE TRIGGER workspace_admin_coverage_before_update
BEFORE UPDATE OF role ON member
WHEN
  OLD.role IN ('owner', 'admin')
  AND NEW.role NOT IN ('owner', 'admin')
  AND (
    SELECT count(*)
    FROM member
    WHERE organizationId = OLD.organizationId
      AND role IN ('owner', 'admin')
  ) <= 1
BEGIN
  SELECT RAISE(ABORT, 'workspace admin coverage required');
END;

CREATE TABLE workspace_usage_audit (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  workspace_id TEXT NOT NULL CHECK (length(workspace_id) BETWEEN 1 AND 128),
  actor_user_id TEXT NOT NULL CHECK (length(actor_user_id) BETWEEN 1 AND 128),
  reason TEXT NOT NULL CHECK (
    length(reason) BETWEEN 1 AND 500
    AND reason = trim(reason)
  ),
  target_thread_id TEXT NOT NULL CHECK (length(target_thread_id) = 40),
  occurred_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > occurred_at),
  result TEXT NOT NULL CHECK (
    result IN (
      'success',
      'permission_denied',
      'browser_session_required',
      'recent_authentication_required',
      'thread_unavailable',
      'thread_not_private'
    )
  )
);

CREATE INDEX workspace_usage_audit_workspace_time_idx
  ON workspace_usage_audit (workspace_id, occurred_at DESC, id DESC);

CREATE INDEX workspace_usage_audit_workspace_actor_time_idx
  ON workspace_usage_audit (workspace_id, actor_user_id, occurred_at DESC, id DESC);

CREATE INDEX workspace_usage_audit_workspace_thread_time_idx
  ON workspace_usage_audit (workspace_id, target_thread_id, occurred_at DESC, id DESC);

CREATE INDEX workspace_usage_audit_expiry_idx
  ON workspace_usage_audit (expires_at);

CREATE TABLE workspace_usage_audit_retention_gate (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  delete_before TEXT NOT NULL
);

CREATE TRIGGER workspace_usage_audit_immutable_update
BEFORE UPDATE ON workspace_usage_audit
BEGIN
  SELECT RAISE(ABORT, 'workspace usage audit events are immutable');
END;

CREATE TRIGGER workspace_usage_audit_retained_delete
BEFORE DELETE ON workspace_usage_audit
WHEN
  NOT EXISTS (
    SELECT 1
    FROM workspace_usage_audit_retention_gate
    WHERE singleton = 1
      AND OLD.expires_at <= delete_before
  )
BEGIN
  SELECT RAISE(ABORT, 'workspace usage audit event is retained');
END;

CREATE TABLE plugin_trigger (
  id TEXT NOT NULL PRIMARY KEY
    CHECK (id GLOB 'trg_*' AND length(id) = 40),
  owner_user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL REFERENCES trusted_plugin (id) ON DELETE RESTRICT,
  plugin_version TEXT NOT NULL,
  capability_name TEXT NOT NULL
    CHECK (length(capability_name) BETWEEN 1 AND 48),
  source TEXT NOT NULL CHECK (source = 'webhook'),
  event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 96),
  action_name TEXT NOT NULL CHECK (length(action_name) BETWEEN 1 AND 48),
  idempotent INTEGER NOT NULL CHECK (idempotent IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'revoked')),
  capability_hash TEXT NOT NULL
    CHECK (length(capability_hash) = 64)
    CHECK (capability_hash NOT GLOB '*[^a-f0-9]*'),
  hmac_reference_json TEXT
    CHECK (
      hmac_reference_json IS NULL OR (
        json_valid(hmac_reference_json)
        AND json_type(hmac_reference_json) = 'object'
        AND length(hmac_reference_json) BETWEEN 2 AND 512
      )
    ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  rotated_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (capability_hash),
  FOREIGN KEY (plugin_id, plugin_version)
    REFERENCES trusted_plugin_version (plugin_id, version) ON DELETE RESTRICT
);

CREATE INDEX plugin_trigger_owner_idx
  ON plugin_trigger (owner_user_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX plugin_trigger_active_capability_uidx
  ON plugin_trigger (
    owner_user_id, plugin_id, plugin_version, capability_name
  )
  WHERE status != 'revoked';

CREATE INDEX plugin_trigger_ingress_idx
  ON plugin_trigger (id, status, capability_hash);

CREATE TABLE plugin_trigger_audit (
  audit_id TEXT NOT NULL PRIMARY KEY
    CHECK (length(audit_id) BETWEEN 1 AND 128),
  trigger_id TEXT NOT NULL REFERENCES plugin_trigger (id) ON DELETE RESTRICT,
  owner_user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 96),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'rejected')),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL
);

CREATE INDEX plugin_trigger_audit_owner_idx
  ON plugin_trigger_audit (owner_user_id, created_at DESC, audit_id DESC);

CREATE TRIGGER plugin_trigger_audit_no_update
BEFORE UPDATE ON plugin_trigger_audit
BEGIN
  SELECT RAISE(ABORT, 'plugin trigger audit is immutable');
END;

CREATE TRIGGER plugin_trigger_audit_no_delete
BEFORE DELETE ON plugin_trigger_audit
BEGIN
  SELECT RAISE(ABORT, 'plugin trigger audit is immutable');
END;

DROP TRIGGER usage_event_immutable_update;

ALTER TABLE usage_event ADD COLUMN estimated_cost_micros_snapshot INTEGER
  CHECK (estimated_cost_micros_snapshot IS NULL OR estimated_cost_micros_snapshot >= 0);
ALTER TABLE usage_event ADD COLUMN price_status TEXT
  CHECK (price_status IS NULL OR price_status IN ('fresh', 'stale', 'unknown'));
ALTER TABLE usage_event ADD COLUMN price_source TEXT
  CHECK (price_source IS NULL OR price_source IN ('deployment', 'catalog'));
ALTER TABLE usage_event ADD COLUMN price_source_version TEXT;
ALTER TABLE usage_event ADD COLUMN price_fresh_until TEXT;

CREATE TRIGGER usage_event_immutable_update
BEFORE UPDATE ON usage_event
BEGIN
  SELECT RAISE(ABORT, 'usage events are immutable');
END;

CREATE TABLE budget_policy (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_scope TEXT NOT NULL CHECK (owner_scope IN ('personal', 'workspace')),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  target_scope TEXT NOT NULL CHECK (
    target_scope IN ('personal', 'workspace', 'project', 'user')
  ),
  target_id TEXT NOT NULL DEFAULT '',
  dimension TEXT NOT NULL CHECK (
    dimension IN (
      'provider_tokens',
      'estimated_provider_cost',
      'runner_duration',
      'runner_cpu',
      'runner_memory',
      'runner_disk',
      'concurrency'
    )
  ),
  provider_id TEXT NOT NULL DEFAULT '',
  period TEXT NOT NULL CHECK (period IN ('day', 'month')),
  timezone_offset_minutes INTEGER NOT NULL
    CHECK (timezone_offset_minutes BETWEEN -840 AND 840),
  limit_value INTEGER NOT NULL CHECK (limit_value > 0),
  warning_threshold_percent INTEGER NOT NULL
    CHECK (warning_threshold_percent BETWEEN 1 AND 100),
  enforcement TEXT NOT NULL CHECK (enforcement IN ('soft', 'hard')),
  cost_unknown_behavior TEXT NOT NULL CHECK (
    cost_unknown_behavior IN ('require_complete_fresh', 'deny_on_unknown')
  ),
  allow_override INTEGER NOT NULL CHECK (allow_override IN (0, 1)),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (owner_scope = 'personal' AND target_scope IN ('personal', 'project'))
    OR (owner_scope = 'workspace' AND target_scope IN ('workspace', 'project', 'user'))
  ),
  CHECK (
    (target_scope IN ('personal', 'workspace') AND target_id = '')
    OR (target_scope IN ('project', 'user') AND length(target_id) BETWEEN 1 AND 128)
  ),
  CHECK (
    provider_id = ''
    OR dimension IN ('provider_tokens', 'estimated_provider_cost')
  )
);

CREATE INDEX budget_policy_owner_idx
  ON budget_policy (
    owner_scope,
    owner_id,
    archived,
    enabled,
    target_scope,
    target_id
  );

CREATE UNIQUE INDEX budget_policy_active_identity_idx
  ON budget_policy (
    owner_scope,
    owner_id,
    target_scope,
    target_id,
    dimension,
    provider_id
  )
  WHERE archived = 0;

CREATE TABLE budget_policy_audit (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_scope TEXT NOT NULL CHECK (owner_scope IN ('personal', 'workspace')),
  owner_id TEXT NOT NULL CHECK (length(owner_id) BETWEEN 1 AND 128),
  actor_user_id TEXT NOT NULL CHECK (length(actor_user_id) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK (action = 'replace'),
  before_json TEXT NOT NULL CHECK (json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  occurred_at TEXT NOT NULL
);

CREATE INDEX budget_policy_audit_owner_time_idx
  ON budget_policy_audit (owner_scope, owner_id, occurred_at DESC, id DESC);

CREATE TRIGGER budget_policy_audit_immutable_update
BEFORE UPDATE ON budget_policy_audit
BEGIN
  SELECT RAISE(ABORT, 'budget policy audit events are immutable');
END;

CREATE TRIGGER budget_policy_audit_immutable_delete
BEFORE DELETE ON budget_policy_audit
BEGIN
  SELECT RAISE(ABORT, 'budget policy audit events are immutable');
END;

CREATE TABLE budget_admission (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  admission_key TEXT NOT NULL UNIQUE CHECK (length(admission_key) BETWEEN 1 AND 512),
  operation TEXT NOT NULL CHECK (operation IN ('thread', 'submission', 'runner')),
  actor_user_id TEXT NOT NULL CHECK (length(actor_user_id) BETWEEN 1 AND 128),
  workspace_id TEXT,
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
  thread_id TEXT,
  submission_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('active', 'released', 'denied')),
  override_requested INTEGER NOT NULL CHECK (override_requested IN (0, 1)),
  override_permitted INTEGER NOT NULL DEFAULT 0 CHECK (override_permitted IN (0, 1)),
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL CHECK (expires_at > started_at),
  finished_at TEXT,
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE INDEX budget_admission_active_scope_idx
  ON budget_admission (state, expires_at, workspace_id, actor_user_id, project_id);
CREATE INDEX budget_admission_thread_idx
  ON budget_admission (thread_id, state, expires_at);
CREATE INDEX budget_admission_submission_idx
  ON budget_admission (thread_id, submission_id, state);

CREATE TABLE budget_alert (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  policy_id TEXT NOT NULL REFERENCES budget_policy(id),
  kind TEXT NOT NULL CHECK (
    kind IN ('warning_threshold', 'hard_limit', 'cost_unknown')
  ),
  dimension TEXT NOT NULL CHECK (
    dimension IN (
      'provider_tokens',
      'estimated_provider_cost',
      'runner_duration',
      'runner_cpu',
      'runner_memory',
      'runner_disk',
      'concurrency'
    )
  ),
  period_starts_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 1 CHECK (occurrences > 0),
  next_delivery_at TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by_user_id TEXT,
  UNIQUE (policy_id, kind, period_starts_at)
);

CREATE INDEX budget_alert_policy_time_idx
  ON budget_alert (policy_id, last_seen_at DESC, id DESC);
CREATE INDEX budget_alert_delivery_idx
  ON budget_alert (next_delivery_at, acknowledged_at);

ALTER TABLE projects ADD COLUMN description TEXT CHECK (description IS NULL OR length(description) <= 500);
ALTER TABLE projects ADD COLUMN icon_key TEXT CHECK (icon_key IS NULL OR length(icon_key) BETWEEN 1 AND 512);
ALTER TABLE projects ADD COLUMN revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0);

CREATE TABLE project_repository (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  connection_id TEXT NOT NULL REFERENCES integration_connection(id) ON DELETE RESTRICT,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'forgejo')),
  provider_repository_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  web_url TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private', 'internal')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX project_repository_connection_idx ON project_repository(connection_id, provider_repository_id);

CREATE VIEW project_read_model AS
SELECT projects.id, projects.owner_user_id, projects.workspace_id, projects.name,
  projects.description, projects.icon_key, projects.revision,
  project_repository.connection_id AS repository_connection_id,
  project_repository.provider AS repository_provider,
  project_repository.provider_repository_id,
  project_repository.full_name AS repository_full_name,
  project_repository.web_url AS repository_web_url,
  project_repository.visibility AS repository_visibility,
  projects.ship_action, projects.commit_author_preference,
  projects.commit_author_name, projects.commit_author_email,
  projects.signing_preference, projects.runner_profile_id,
  projects.public_code_enabled, projects.created_at, projects.updated_at
FROM projects
LEFT JOIN project_repository ON project_repository.project_id = projects.id;

UPDATE environment_variable SET policy_locked = 0 WHERE policy_locked <> 0;

CREATE TABLE environment_variable_audit (
  id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'project', 'workspace')),
  target_id TEXT NOT NULL,
  variable_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('secret', 'variable')),
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'rotate', 'delete')),
  actor_user_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);

CREATE INDEX environment_variable_audit_target_time_idx
ON environment_variable_audit(scope, target_id, occurred_at DESC, id DESC);

CREATE TRIGGER environment_variable_audit_immutable_update
BEFORE UPDATE ON environment_variable_audit
BEGIN
  SELECT RAISE(ABORT, 'environment variable audit is immutable');
END;

CREATE TRIGGER environment_variable_audit_immutable_delete
BEFORE DELETE ON environment_variable_audit
BEGIN
  SELECT RAISE(ABORT, 'environment variable audit is immutable');
END;

ALTER TABLE threads ADD COLUMN last_activity_at TEXT;

ALTER TABLE threads ADD COLUMN activity_status TEXT NOT NULL DEFAULT 'idle'
  CHECK (activity_status IN ('idle', 'working'));

UPDATE threads SET last_activity_at = updated_at;

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

INSERT INTO thread_activity (thread_id, event_key, kind, occurred_at, recorded_at)
SELECT id, 'created', 'created', created_at, created_at
FROM threads;

CREATE TABLE thread_activity_submission (
  thread_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('working', 'settled')),
  observed_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, submission_id),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE INDEX thread_activity_snapshot_idx
  ON thread_activity(thread_id, sequence, occurred_at DESC);

CREATE INDEX threads_owner_activity_idx
  ON threads(owner_user_id, last_activity_at DESC, id DESC);

CREATE INDEX threads_owner_project_activity_idx
  ON threads(owner_user_id, project_id, last_activity_at DESC, id DESC);

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

UPDATE threads
SET last_activity_at = COALESCE(
  (
    SELECT MAX(activity.occurred_at)
    FROM thread_activity AS activity
    WHERE activity.thread_id = threads.id
  ),
  created_at
);

CREATE TABLE github_user_authorization (
  id TEXT NOT NULL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  provider_account_id TEXT NOT NULL,
  provider_account_login TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'reauthorization-required', 'revoked')),
  access_token_reference_id TEXT REFERENCES integration_credential (id),
  refresh_token_reference_id TEXT REFERENCES integration_credential (id),
  expires_at TEXT,
  refresh_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, provider_account_id)
);

CREATE INDEX github_user_authorization_user_idx
  ON github_user_authorization (user_id, status, id);

CREATE TABLE github_installation (
  installation_id TEXT NOT NULL PRIMARY KEY,
  app_id TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  provider_account_type TEXT NOT NULL CHECK (provider_account_type IN ('user', 'organization')),
  provider_account_login TEXT NOT NULL,
  repository_selection TEXT NOT NULL CHECK (repository_selection IN ('all', 'selected')),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'removed', 'permissions-pending')),
  permissions_version INTEGER NOT NULL CHECK (permissions_version >= 1),
  suspended_at TEXT,
  removed_at TEXT,
  last_reconciled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX github_installation_account_idx
  ON github_installation (provider_account_id, installation_id);

CREATE TABLE github_owner_grant (
  id TEXT NOT NULL PRIMARY KEY,
  owner_scope TEXT NOT NULL CHECK (owner_scope IN ('personal', 'workspace')),
  owner_id TEXT NOT NULL,
  installation_id TEXT NOT NULL REFERENCES github_installation (installation_id),
  status TEXT NOT NULL CHECK (status IN ('active', 'reauthorization-required', 'disconnected')),
  created_by_user_id TEXT NOT NULL REFERENCES "user" (id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_scope, owner_id, installation_id),
  UNIQUE (id, installation_id)
);

CREATE INDEX github_owner_grant_owner_idx
  ON github_owner_grant (owner_scope, owner_id, status, id);

CREATE TABLE github_installation_repository (
  installation_id TEXT NOT NULL REFERENCES github_installation (installation_id) ON DELETE CASCADE,
  provider_repository_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  web_url TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private', 'internal')),
  entitled INTEGER NOT NULL CHECK (entitled IN (0, 1)),
  last_reconciled_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, provider_repository_id)
);

CREATE INDEX github_installation_repository_entitled_idx
  ON github_installation_repository (installation_id, entitled, provider_repository_id);

CREATE TABLE github_owner_repository_selection (
  owner_grant_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  provider_repository_id TEXT NOT NULL,
  selected_at TEXT NOT NULL,
  selected_by_user_id TEXT NOT NULL REFERENCES "user" (id),
  PRIMARY KEY (owner_grant_id, provider_repository_id),
  FOREIGN KEY (owner_grant_id, installation_id)
    REFERENCES github_owner_grant (id, installation_id) ON DELETE CASCADE,
  FOREIGN KEY (installation_id, provider_repository_id)
    REFERENCES github_installation_repository (installation_id, provider_repository_id)
);

CREATE TABLE github_setup_transaction (
  id TEXT NOT NULL PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE CHECK (length(state_hash) = 64 AND state_hash NOT GLOB '*[^a-f0-9]*'),
  actor_user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  browser_session_id TEXT NOT NULL CHECK (length(browser_session_id) BETWEEN 1 AND 256),
  owner_scope TEXT NOT NULL CHECK (owner_scope IN ('personal', 'workspace')),
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'oauth-proved', 'completed', 'expired', 'failed')),
  verifier_reference_id TEXT NOT NULL REFERENCES integration_credential (id),
  installation_id TEXT,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  CHECK ((status IN ('pending', 'oauth-proved') AND consumed_at IS NULL) OR status IN ('completed', 'expired', 'failed')),
  CHECK (installation_id IS NULL OR length(installation_id) BETWEEN 1 AND 32)
);

CREATE INDEX github_setup_transaction_expiry_idx
  ON github_setup_transaction (expires_at, status);

CREATE TABLE github_webhook_delivery (
  delivery_id TEXT NOT NULL PRIMARY KEY CHECK (length(delivery_id) BETWEEN 1 AND 128),
  event TEXT NOT NULL CHECK (event IN ('installation', 'installation_repositories', 'installation_target', 'github_app_authorization', 'repository')),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK (state IN ('received', 'processing', 'processed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 16),
  installation_id TEXT,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  processed_at TEXT,
  expires_at TEXT NOT NULL,
  CHECK ((state = 'processed' AND processed_at IS NOT NULL) OR (state != 'processed' AND processed_at IS NULL))
);

CREATE INDEX github_webhook_delivery_state_idx
  ON github_webhook_delivery (state, expires_at, delivery_id);

CREATE TABLE github_authorization_epoch (
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('user-authorization', 'installation', 'owner-grant')),
  subject_id TEXT NOT NULL,
  epoch INTEGER NOT NULL DEFAULT 1 CHECK (epoch BETWEEN 1 AND 9007199254740991),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (subject_kind, subject_id)
);

INSERT INTO github_user_authorization (
  id, user_id, provider_account_id, provider_account_login, status,
  access_token_reference_id, refresh_token_reference_id, expires_at,
  refresh_expires_at, created_at, updated_at
)
SELECT 'legacy:' || id, owner_id, provider_account_id, provider_account_login,
       'reauthorization-required', access_token_reference_id,
       refresh_token_reference_id, expires_at, refresh_expires_at,
       created_at, updated_at
  FROM integration_connection
 WHERE provider = 'github' AND owner_scope = 'personal';

UPDATE integration_connection
   SET status = 'needs-reauthorization', health = 'expired'
 WHERE provider = 'github' AND status = 'connected';

ALTER TABLE threads ADD COLUMN pinned_at TEXT;

CREATE INDEX threads_owner_pinned_activity_id_idx
  ON threads(owner_user_id, pinned_at DESC, last_activity_at DESC, id DESC);

ALTER TABLE threads
ADD COLUMN title TEXT NOT NULL DEFAULT 'Untitled thread'
CHECK (length(title) BETWEEN 1 AND 80);

CREATE TABLE github_oauth_transaction (
  id TEXT NOT NULL PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE CHECK (length(state_hash) = 64 AND state_hash NOT GLOB '*[^a-f0-9]*'),
  actor_user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  browser_session_id TEXT NOT NULL CHECK (length(browser_session_id) BETWEEN 1 AND 256),
  verifier_reference_id TEXT NOT NULL REFERENCES integration_credential (id),
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX github_oauth_transaction_expiry_idx
  ON github_oauth_transaction (expires_at, consumed_at);

ALTER TABLE github_webhook_delivery RENAME TO github_webhook_delivery_0028;

CREATE TABLE github_webhook_delivery (
  delivery_id TEXT NOT NULL PRIMARY KEY CHECK (length(delivery_id) BETWEEN 1 AND 128),
  event TEXT NOT NULL CHECK (event IN ('ping', 'installation', 'installation_repositories', 'installation_target', 'github_app_authorization', 'repository')),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK (state IN ('received', 'processing', 'processed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 16),
  installation_id TEXT,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  processed_at TEXT,
  expires_at TEXT NOT NULL,
  CHECK ((state = 'processed' AND processed_at IS NOT NULL) OR (state != 'processed' AND processed_at IS NULL))
);

INSERT INTO github_webhook_delivery SELECT * FROM github_webhook_delivery_0028;
DROP TABLE github_webhook_delivery_0028;

CREATE INDEX github_webhook_delivery_state_idx
  ON github_webhook_delivery (state, expires_at, delivery_id);

CREATE TABLE thread_pin_history (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  pinned_at TEXT,
  changed_at TEXT NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

INSERT INTO thread_pin_history (thread_id, pinned_at, changed_at)
SELECT id, pinned_at, updated_at
FROM threads
WHERE pinned_at IS NOT NULL;

CREATE INDEX thread_pin_history_snapshot_idx
  ON thread_pin_history(thread_id, sequence DESC);

CREATE TRIGGER threads_pin_history_after_update
AFTER UPDATE OF pinned_at ON threads
WHEN OLD.pinned_at IS NOT NEW.pinned_at
BEGIN
  INSERT INTO thread_pin_history (thread_id, pinned_at, changed_at)
  VALUES (NEW.id, NEW.pinned_at, NEW.updated_at);
END;

DROP VIEW project_read_model;

ALTER TABLE project_repository RENAME TO project_repository_legacy;

CREATE TABLE project_repository (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'forgejo')),
  owner_scope TEXT NOT NULL CHECK (owner_scope IN ('personal', 'workspace')),
  owner_id TEXT NOT NULL,
  owner_grant_id TEXT REFERENCES github_owner_grant(id) ON DELETE RESTRICT,
  installation_id TEXT,
  provider_repository_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
  provenance TEXT NOT NULL CHECK (provenance IN ('live-grant', 'legacy')),
  full_name TEXT NOT NULL,
  web_url TEXT NOT NULL,
  clone_url TEXT,
  default_branch TEXT,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private', 'internal')),
  source_health TEXT NOT NULL CHECK (source_health IN ('available', 'action-required', 'unavailable', 'unknown')),
  source_health_reason TEXT CHECK (source_health_reason IS NULL OR source_health_reason IN (
    'connection-reauthorization-required', 'grant-missing', 'installation-suspended',
    'installation-permissions-changed', 'grant-disconnected', 'installation-removed',
    'repository-access-removed', 'repository-not-selected', 'stale-authorization-epoch',
    'stale-binding', 'stale-snapshot', 'provider-disabled',
    'personal-grant-not-allowed-for-workspace', 'provider-unreachable'
  )),
  authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 0),
  installation_epoch INTEGER NOT NULL CHECK (installation_epoch >= 0),
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (provenance = 'live-grant' AND provider = 'github' AND owner_grant_id IS NOT NULL
      AND installation_id IS NOT NULL AND clone_url IS NOT NULL
      AND default_branch IS NOT NULL AND source_health = 'available')
    OR (provenance = 'legacy' AND source_health = 'action-required')
  )
);

INSERT INTO project_repository (
  project_id, provider, owner_scope, owner_id, provider_repository_id,
  binding_revision, provenance, full_name, web_url, visibility,
  source_health, source_health_reason, authorization_epoch, installation_epoch, policy_revision,
  created_at, updated_at
)
SELECT legacy.project_id, legacy.provider,
       CASE WHEN projects.workspace_id IS NULL THEN 'personal' ELSE 'workspace' END ,
       CASE WHEN projects.workspace_id IS NULL THEN projects.owner_user_id ELSE projects.workspace_id END ,
       legacy.provider_repository_id, 1, 'legacy', legacy.full_name, legacy.web_url,
       legacy.visibility, 'action-required',
       CASE WHEN projects.workspace_id IS NULL
         THEN 'connection-reauthorization-required'
         ELSE 'personal-grant-not-allowed-for-workspace' END ,
       0, 0, 0, legacy.created_at, legacy.updated_at
  FROM project_repository_legacy AS legacy
  JOIN projects ON projects.id = legacy.project_id;

DROP TABLE project_repository_legacy;

CREATE INDEX project_repository_grant_idx
  ON project_repository(owner_grant_id, installation_id, provider_repository_id);
CREATE INDEX project_repository_owner_idx
  ON project_repository(owner_scope, owner_id, source_health, project_id);

CREATE TABLE source_admission_assertion (
  project_id TEXT NOT NULL UNIQUE REFERENCES project_repository(project_id) ON DELETE CASCADE
);

CREATE VIEW project_read_model AS
SELECT projects.id, projects.owner_user_id, projects.workspace_id, projects.name,
  projects.description, projects.icon_key, projects.revision,
  project_repository.provider AS repository_provider,
  project_repository.owner_scope AS repository_owner_scope,
  project_repository.owner_id AS repository_owner_id,
  project_repository.owner_grant_id AS repository_grant_id,
  project_repository.installation_id AS repository_installation_id,
  project_repository.provider_repository_id,
  project_repository.binding_revision AS repository_binding_revision,
  project_repository.provenance AS repository_provenance,
  project_repository.full_name AS repository_full_name,
  project_repository.web_url AS repository_web_url,
  project_repository.clone_url AS repository_clone_url,
  project_repository.default_branch AS repository_default_branch,
  project_repository.visibility AS repository_visibility,
  project_repository.source_health AS repository_source_health,
  project_repository.source_health_reason AS repository_source_health_reason,
  project_repository.authorization_epoch AS repository_authorization_epoch,
  project_repository.installation_epoch AS repository_installation_epoch,
  project_repository.policy_revision AS repository_policy_revision,
  projects.ship_action, projects.commit_author_preference,
  projects.commit_author_name, projects.commit_author_email,
  projects.signing_preference, projects.runner_profile_id,
  projects.public_code_enabled, projects.created_at, projects.updated_at
FROM projects
LEFT JOIN project_repository ON project_repository.project_id = projects.id;

CREATE TABLE thread_source_snapshot (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
  provider TEXT NOT NULL CHECK (provider = 'github'),
  owner_grant_id TEXT NOT NULL REFERENCES github_owner_grant(id) ON DELETE RESTRICT,
  installation_id TEXT NOT NULL,
  provider_repository_id TEXT NOT NULL,
  repository_full_name TEXT NOT NULL,
  clone_url TEXT NOT NULL CHECK (clone_url LIKE 'https://github.com/%' AND instr(clone_url, '@') = 0),
  default_branch TEXT NOT NULL,
  initial_ref TEXT NOT NULL,
  initial_commit_sha TEXT NOT NULL CHECK (length(initial_commit_sha) = 40 AND initial_commit_sha NOT GLOB '*[^a-f0-9]*'),
  authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 1),
  installation_epoch INTEGER NOT NULL CHECK (installation_epoch >= 1),
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 0),
  provenance TEXT NOT NULL CHECK (provenance = 'project-binding'),
  private_submodule_repository_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(private_submodule_repository_ids_json)
      AND json_type(private_submodule_repository_ids_json) = 'array'
      AND json_array_length(private_submodule_repository_ids_json) <= 16),
  created_at TEXT NOT NULL
);

CREATE INDEX thread_source_snapshot_project_idx
  ON thread_source_snapshot(project_id, binding_revision, thread_id);
CREATE INDEX thread_source_snapshot_grant_idx
  ON thread_source_snapshot(owner_grant_id, installation_id, provider_repository_id);

CREATE TRIGGER thread_source_snapshot_immutable_update
BEFORE UPDATE ON thread_source_snapshot
BEGIN
  SELECT RAISE(ABORT, 'thread source snapshots are immutable');
END;

CREATE TRIGGER thread_source_snapshot_immutable_delete
BEFORE DELETE ON thread_source_snapshot
WHEN EXISTS (SELECT 1 FROM threads WHERE id = OLD.thread_id)
BEGIN
  SELECT RAISE(ABORT, 'thread source snapshots are immutable');
END;

CREATE TABLE source_control_operation_audit (
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
    invocation_source IN ('checkout', 'agent-command', 'setup-hook', 'resume-hook', 'system')
  ),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('success', 'denied', 'provider-failed', 'callback-failed', 'interrupted')
  ),
  reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 128),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  CHECK (provider_repository_id IS NULL OR provider IS NOT NULL),
  CHECK (credential_class = 'none' OR provider_repository_id IS NOT NULL)
);

CREATE INDEX source_control_audit_thread_time_idx
  ON source_control_operation_audit(thread_id, occurred_at DESC, operation_id DESC);
CREATE INDEX source_control_audit_actor_time_idx
  ON source_control_operation_audit(actor_user_id, occurred_at DESC, operation_id DESC);
CREATE INDEX source_control_audit_outcome_time_idx
  ON source_control_operation_audit(outcome, occurred_at DESC, operation_id DESC);

CREATE TABLE source_control_audit_retention_gate (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  delete_before TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TRIGGER source_control_operation_audit_validate_capabilities
BEFORE INSERT ON source_control_operation_audit
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.requested_capabilities_json)
   WHERE type != 'text' OR value NOT IN (
     'checkout', 'fetch', 'repository-read', 'contents-push',
     'pull-request-read', 'pull-request-write', 'issue-read', 'issue-write',
     'actions-read', 'actions-write', 'workflow-write', 'checks-status-read'
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

CREATE UNIQUE INDEX threads_source_operation_tenant_idx
  ON threads(id, project_id, owner_user_id);

CREATE TABLE source_control_operation (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64
    AND idempotency_key_hash NOT GLOB '*[^a-f0-9]*'
  ),
  actor_user_id TEXT NOT NULL CHECK (length(actor_user_id) BETWEEN 1 AND 128),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
  thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 128),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
  provider_repository_id TEXT NOT NULL CHECK (
    length(provider_repository_id) BETWEEN 1 AND 256
  ),
  semantic_kind TEXT NOT NULL CHECK (semantic_kind IN (
    'contents-push', 'workflow-write', 'pull-request-write',
    'issue-write', 'actions-write'
  )),
  expected_remote_sha TEXT CHECK (
    expected_remote_sha IS NULL OR (
      length(expected_remote_sha) = 40
      AND expected_remote_sha NOT GLOB '*[^a-f0-9]*'
    )
  ),
  intended_sha TEXT CHECK (
    intended_sha IS NULL OR (
      length(intended_sha) = 40
      AND intended_sha NOT GLOB '*[^a-f0-9]*'
    )
  ),
  input_identity_hash TEXT CHECK (
    input_identity_hash IS NULL OR (
      length(input_identity_hash) = 64
      AND input_identity_hash NOT GLOB '*[^a-f0-9]*'
    )
  ),
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'executing', 'succeeded', 'failed', 'reconcile-required'
  )),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 100),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  provider_result_opaque_id TEXT CHECK (
    provider_result_opaque_id IS NULL
    OR length(provider_result_opaque_id) BETWEEN 1 AND 256
  ),
  provider_result_category TEXT CHECK (
    provider_result_category IS NULL OR provider_result_category IN (
      'applied', 'rejected', 'conflict', 'not-observed', 'unavailable'
    )
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  completed_at TEXT CHECK (
    completed_at IS NULL OR length(completed_at) BETWEEN 20 AND 40
  ),
  FOREIGN KEY (thread_id, project_id, actor_user_id)
    REFERENCES threads(id, project_id, owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (thread_id) REFERENCES thread_source_snapshot(thread_id) ON DELETE RESTRICT,
  UNIQUE(thread_id, provider, provider_repository_id, idempotency_key_hash),
  CHECK (expected_remote_sha IS NULL OR semantic_kind IN ('contents-push', 'workflow-write')),
  CHECK (intended_sha IS NULL OR semantic_kind IN ('contents-push', 'workflow-write')),
  CHECK (expected_remote_sha IS NULL OR intended_sha IS NOT NULL),
  CHECK (input_identity_hash IS NOT NULL OR intended_sha IS NOT NULL),
  CHECK (
    (state IN ('pending', 'executing', 'reconcile-required') AND completed_at IS NULL)
    OR (state IN ('succeeded', 'failed') AND completed_at IS NOT NULL)
  )
);

CREATE INDEX source_control_operation_thread_time_idx
  ON source_control_operation(thread_id, updated_at DESC, id DESC);
CREATE INDEX source_control_operation_reconcile_idx
  ON source_control_operation(state, updated_at, id)
  WHERE state IN ('executing', 'reconcile-required');

CREATE TRIGGER source_control_operation_intent_immutable
BEFORE UPDATE ON source_control_operation
WHEN NEW.id != OLD.id
  OR NEW.idempotency_key_hash != OLD.idempotency_key_hash
  OR NEW.actor_user_id != OLD.actor_user_id
  OR NEW.project_id != OLD.project_id
  OR NEW.thread_id != OLD.thread_id
  OR NEW.provider != OLD.provider
  OR NEW.provider_repository_id != OLD.provider_repository_id
  OR NEW.semantic_kind != OLD.semantic_kind
  OR NEW.expected_remote_sha IS NOT OLD.expected_remote_sha
  OR NEW.intended_sha IS NOT OLD.intended_sha
  OR NEW.input_identity_hash IS NOT OLD.input_identity_hash
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'source-control operation intent is immutable');
END;

CREATE TRIGGER source_control_operation_transition
BEFORE UPDATE ON source_control_operation
WHEN NOT (
  (OLD.state = 'pending' AND NEW.state IN ('executing', 'failed'))
  OR (OLD.state = 'executing' AND NEW.state IN ('succeeded', 'failed', 'reconcile-required'))
  OR (OLD.state = 'reconcile-required' AND NEW.state IN ('executing', 'succeeded', 'failed'))
)
OR NEW.version != OLD.version + 1
OR NEW.attempt != OLD.attempt + CASE WHEN NEW.state = 'executing' THEN 1 ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'invalid source-control operation transition');
END;

CREATE TRIGGER source_control_operation_terminal_immutable
BEFORE UPDATE ON source_control_operation
WHEN OLD.state IN ('succeeded', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'source-control operation is terminal');
END;

CREATE TRIGGER source_control_operation_no_delete
BEFORE DELETE ON source_control_operation
BEGIN
  SELECT RAISE(ABORT, 'source-control operation cannot be deleted');
END;

CREATE TABLE startup_phase_event (
  journey TEXT NOT NULL CHECK (journey IN ('thread_create', 'submission', 'terminal')),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  thread_id TEXT NOT NULL,
  submission_id TEXT NOT NULL DEFAULT '' CHECK (length(submission_id) <= 128),
  phase TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 9),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40),
  expires_at TEXT NOT NULL CHECK (expires_at > occurred_at),
  outcome TEXT NOT NULL CHECK (outcome IN ('reached', 'failed', 'cancelled')),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  operation_count INTEGER CHECK (operation_count IS NULL OR operation_count >= 0),
  PRIMARY KEY (journey, request_id, thread_id, submission_id, phase),
  UNIQUE (journey, request_id, thread_id, submission_id, ordinal),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
  CHECK ((journey = 'submission') = (submission_id <> '')),
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
      (phase = 'context_discovered' AND ordinal = 6) OR
      (phase = 'model_requested' AND ordinal = 7) OR
      (phase = 'model_first_token' AND ordinal = 8) OR
      (phase = 'settled' AND ordinal = 9)
    )) OR
    (journey = 'terminal' AND (
      (phase = 'websocket_admitted' AND ordinal = 0) OR
      (phase = 'durable_object_reached' AND ordinal = 1) OR
      (phase IN ('workspace_starting', 'workspace_waking') AND ordinal = 2) OR
      (phase = 'workspace_resolved' AND ordinal = 3) OR
      (phase = 'source_activated' AND ordinal = 4) OR
      (phase = 'tmux_ready' AND ordinal = 5) OR
      (phase = 'terminal_ready' AND ordinal = 6)
    ))
  )
);

CREATE INDEX startup_phase_expiry_idx ON startup_phase_event(expires_at);
CREATE INDEX startup_phase_submission_idx
  ON startup_phase_event(thread_id, submission_id, ordinal);
CREATE INDEX startup_phase_slo_idx
  ON startup_phase_event(journey, phase, occurred_at, outcome, duration_ms);

CREATE TABLE startup_phase_retention_gate (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  delete_before TEXT NOT NULL
);

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

CREATE TABLE execution_workspace_resolution_lock (
  lock_key TEXT NOT NULL PRIMARY KEY CHECK (length(lock_key) BETWEEN 1 AND 512),
  lease_token TEXT NOT NULL CHECK (length(lease_token) BETWEEN 1 AND 128),
  lease_expires_at INTEGER NOT NULL CHECK (lease_expires_at > 0)
);

CREATE TABLE model_connection_v2 (
  id TEXT NOT NULL PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  target_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK (kind IN ('workers-ai-binding', 'built-in-deployment', 'openai-platform', 'openai-compatible', 'personal-subscription')),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
  endpoint TEXT CHECK (endpoint IS NULL OR length(endpoint) BETWEEN 1 AND 2048),
  credential_reference_id TEXT REFERENCES environment_variable(id) ON DELETE RESTRICT,
  retention TEXT NOT NULL CHECK (retention IN ('provider-policy', 'zero-data-retention', 'may-retain')),
  configured_models TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(configured_models) AND json_array_length(configured_models) <= 100),
  health_state TEXT NOT NULL DEFAULT 'untested' CHECK (health_state IN ('untested', 'healthy', 'unhealthy', 'unavailable')),
  health_code TEXT NOT NULL DEFAULT 'NOT_TESTED' CHECK (length(health_code) BETWEEN 1 AND 64),
  health_checked_at TEXT,
  health_latency_ms INTEGER CHECK (health_latency_ms BETWEEN 0 AND 30000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope, target_id, name),
  CHECK (kind <> 'personal-subscription' OR (scope = 'personal' AND provider_id = 'dx-subscription'))
);

INSERT INTO model_connection_v2 SELECT * FROM model_connection;
DROP TABLE model_connection;
ALTER TABLE model_connection_v2 RENAME TO model_connection;
CREATE INDEX model_connection_target_idx ON model_connection (scope, target_id, name, id);

CREATE TABLE personal_model_subscription_connection (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE CHECK (length(owner_user_id) BETWEEN 1 AND 128),
  provider TEXT NOT NULL CHECK (provider = 'github-copilot'),
  provider_account_id TEXT NOT NULL CHECK (length(provider_account_id) BETWEEN 1 AND 256),
  provider_account_login TEXT NOT NULL CHECK (length(provider_account_login) BETWEEN 1 AND 256),
  status TEXT NOT NULL CHECK (status IN ('connected', 'needs-reauthorization')),
  credential_envelope_json TEXT CHECK (credential_envelope_json IS NULL OR (json_valid(credential_envelope_json) AND length(credential_envelope_json) <= 16384)),
  credential_revision INTEGER NOT NULL DEFAULT 1 CHECK (credential_revision >= 1),
  entitlement_model_ids_json TEXT NOT NULL CHECK (json_valid(entitlement_model_ids_json) AND json_type(entitlement_model_ids_json) = 'array' AND json_array_length(entitlement_model_ids_json) <= 100),
  entitlement_catalog_revision TEXT NOT NULL CHECK (length(entitlement_catalog_revision) BETWEEN 1 AND 128),
  entitlement_observed_at TEXT NOT NULL CHECK (length(entitlement_observed_at) BETWEEN 20 AND 40),
  entitlement_refresh_after TEXT NOT NULL CHECK (length(entitlement_refresh_after) BETWEEN 20 AND 40),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  connected_at TEXT NOT NULL CHECK (length(connected_at) BETWEEN 20 AND 40),
  FOREIGN KEY (id) REFERENCES model_connection(id) ON DELETE CASCADE,
  UNIQUE (owner_user_id, provider),
  CHECK ((status = 'connected' AND credential_envelope_json IS NOT NULL) OR (status = 'needs-reauthorization' AND credential_envelope_json IS NULL))
);
CREATE INDEX personal_model_subscription_refresh_idx ON personal_model_subscription_connection(status, entitlement_refresh_after, owner_user_id);

CREATE TABLE personal_model_subscription_authorization (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE CHECK (length(owner_user_id) BETWEEN 1 AND 128),
  browser_session_id TEXT NOT NULL CHECK (length(browser_session_id) BETWEEN 1 AND 128),
  provider TEXT NOT NULL CHECK (provider = 'github-copilot'),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state = 'pending'),
  verification_url TEXT NOT NULL CHECK (length(verification_url) BETWEEN 1 AND 2048),
  user_code TEXT NOT NULL CHECK (length(user_code) BETWEEN 1 AND 128),
  authorization_envelope_json TEXT NOT NULL CHECK (json_valid(authorization_envelope_json) AND length(authorization_envelope_json) <= 16384),
  credential_revision INTEGER NOT NULL DEFAULT 1 CHECK (credential_revision >= 1),
  interval_seconds INTEGER NOT NULL CHECK (interval_seconds BETWEEN 1 AND 3600),
  next_poll_at TEXT NOT NULL CHECK (length(next_poll_at) BETWEEN 20 AND 40),
  expires_at TEXT NOT NULL CHECK (length(expires_at) BETWEEN 20 AND 40),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  UNIQUE (owner_user_id, provider)
);
CREATE INDEX personal_model_subscription_authorization_expiry_idx ON personal_model_subscription_authorization(expires_at, owner_user_id);

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
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
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

CREATE TABLE thread_changes_mutation_lease (
  thread_id TEXT NOT NULL,
  lease_token TEXT NOT NULL CHECK (length(lease_token) BETWEEN 8 AND 128),
  generation INTEGER NOT NULL CHECK (generation >= 1),
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  PRIMARY KEY (thread_id, lease_token),
  FOREIGN KEY (thread_id) REFERENCES thread_changes_state(thread_id) ON DELETE CASCADE
);

CREATE INDEX thread_changes_mutation_lease_expiry_idx
  ON thread_changes_mutation_lease(expires_at);

CREATE TABLE thread_changes_capture_lease (
  thread_id TEXT PRIMARY KEY,
  lease_token TEXT NOT NULL CHECK (length(lease_token) BETWEEN 8 AND 128),
  expires_at INTEGER NOT NULL CHECK (expires_at > 0),
  FOREIGN KEY (thread_id) REFERENCES thread_changes_state(thread_id) ON DELETE CASCADE
);

CREATE TABLE execution_workspace (
  thread_id TEXT NOT NULL PRIMARY KEY,
  provider TEXT NOT NULL DEFAULT 'e2b' CHECK (provider = 'e2b'),
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

INSERT INTO execution_workspace (
  thread_id,
  provider,
  state,
  provider_sandbox_id,
  initialization_attempt_id,
  conflict_count,
  created_at,
  updated_at
)
SELECT
  id,
  'e2b',
  'legacy',
  NULL,
  NULL,
  NULL,
  created_at,
  updated_at
FROM threads;

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
WHEN NOT (
  (OLD.state = 'uninitialized' AND NEW.state = 'provisioning')
  OR (OLD.state = 'provisioning' AND NEW.state IN ('initialized', 'conflict'))
  OR (OLD.state = 'legacy' AND NEW.state IN ('initialized', 'legacy_unavailable', 'conflict'))
  OR (OLD.state = 'initialized' AND NEW.state = 'lost')
)
BEGIN
  SELECT RAISE(ABORT, 'invalid execution workspace transition');
END;

DROP TRIGGER IF EXISTS source_control_operation_audit_validate_capabilities;
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

ALTER TABLE thread_changes_state
ADD COLUMN shadow_refresh_token TEXT CHECK (
  shadow_refresh_token IS NULL OR (
    length(shadow_refresh_token) BETWEEN 16 AND 64
    AND shadow_refresh_token NOT GLOB '*[^A-Za-z0-9_-]*'
  )
);

DROP TRIGGER startup_phase_event_monotonic_insert;
DROP TRIGGER startup_phase_event_immutable_update;
DROP TRIGGER startup_phase_event_retained_delete;
DROP INDEX startup_phase_expiry_idx;
DROP INDEX startup_phase_submission_idx;
DROP INDEX startup_phase_slo_idx;

ALTER TABLE startup_phase_event RENAME TO startup_phase_event_legacy;

CREATE TABLE startup_phase_event (
  journey TEXT NOT NULL CHECK (journey IN ('thread_create', 'submission', 'terminal')),
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
  thread_id TEXT NOT NULL,
  submission_id TEXT NOT NULL DEFAULT '' CHECK (length(submission_id) <= 128),
  phase TEXT NOT NULL,
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 23),
  occurred_at TEXT NOT NULL CHECK (length(occurred_at) BETWEEN 20 AND 40),
  expires_at TEXT NOT NULL CHECK (expires_at > occurred_at),
  outcome TEXT NOT NULL CHECK (outcome IN ('reached', 'failed', 'cancelled')),
  duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
  operation_count INTEGER CHECK (operation_count IS NULL OR operation_count >= 0),
  PRIMARY KEY (journey, request_id, thread_id, submission_id, phase),
  UNIQUE (journey, request_id, thread_id, submission_id, ordinal),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE,
  CHECK ((journey = 'submission') = (submission_id <> '')),
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
      (phase = 'context_discovered' AND ordinal = 6) OR
      (phase = 'model_requested' AND ordinal = 7) OR
      (phase = 'model_first_token' AND ordinal = 8) OR
      (phase = 'settled' AND ordinal = 9)
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
      (phase = 'terminal_ready' AND ordinal = 23)
    ))
  )
);

INSERT INTO startup_phase_event (
  journey, request_id, thread_id, submission_id, phase, ordinal,
  occurred_at, expires_at, outcome, duration_ms, operation_count
)
SELECT
  journey, request_id, thread_id, submission_id, phase,
  CASE WHEN journey = 'terminal' THEN CASE phase
    WHEN 'websocket_admitted' THEN 3
    WHEN 'durable_object_reached' THEN 4
    WHEN 'workspace_starting' THEN 9
    WHEN 'workspace_waking' THEN 9
    WHEN 'workspace_resolved' THEN 11
    WHEN 'source_activated' THEN 12
    WHEN 'tmux_ready' THEN 21
    WHEN 'terminal_ready' THEN 23
    ELSE ordinal
  END ELSE ordinal END ,
  occurred_at, expires_at, outcome, duration_ms, operation_count
FROM startup_phase_event_legacy;

DROP TABLE startup_phase_event_legacy;

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

CREATE TABLE environment_variable_scope_revision (
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'project', 'workspace')),
  target_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  PRIMARY KEY (scope, target_id)
);

INSERT INTO environment_variable_scope_revision (scope, target_id, revision)
SELECT scope, target_id, 1
FROM environment_variable
GROUP BY scope, target_id;

CREATE TRIGGER environment_variable_revision_insert
AFTER INSERT ON environment_variable
BEGIN
  INSERT INTO environment_variable_scope_revision (scope, target_id, revision)
  VALUES (NEW.scope, NEW.target_id, 1)
  ON CONFLICT (scope, target_id)
  DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER environment_variable_revision_update
AFTER UPDATE ON environment_variable
BEGIN
  INSERT INTO environment_variable_scope_revision (scope, target_id, revision)
  VALUES (NEW.scope, NEW.target_id, 1)
  ON CONFLICT (scope, target_id)
  DO UPDATE SET revision = revision + 1;
END;

CREATE TRIGGER environment_variable_revision_delete
AFTER DELETE ON environment_variable
BEGIN
  INSERT INTO environment_variable_scope_revision (scope, target_id, revision)
  VALUES (OLD.scope, OLD.target_id, 1)
  ON CONFLICT (scope, target_id)
  DO UPDATE SET revision = revision + 1;
END;

DROP TRIGGER startup_phase_event_monotonic_insert;
DROP TRIGGER startup_phase_event_immutable_update;
DROP TRIGGER startup_phase_event_retained_delete;
DROP INDEX startup_phase_expiry_idx;
DROP INDEX startup_phase_submission_idx;
DROP INDEX startup_phase_slo_idx;

ALTER TABLE startup_phase_event RENAME TO startup_phase_event_legacy;

CREATE TABLE startup_phase_event (
  journey TEXT NOT NULL CHECK (journey IN ('thread_create', 'submission', 'terminal')),
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
  CHECK ((journey = 'submission') = (submission_id <> '')),
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
      (phase = 'context_discovered' AND ordinal = 6) OR
      (phase = 'model_requested' AND ordinal = 7) OR
      (phase = 'model_first_token' AND ordinal = 8) OR
      (phase = 'settled' AND ordinal = 9)
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

INSERT INTO startup_phase_event (
  journey, request_id, thread_id, submission_id, phase, ordinal,
  occurred_at, expires_at, outcome, duration_ms, operation_count
)
SELECT
  journey, request_id, thread_id, submission_id, phase,
  CASE
    WHEN journey = 'terminal' AND phase = 'terminal_ready' THEN 30
    ELSE ordinal
  END ,
  occurred_at, expires_at, outcome, duration_ms, operation_count
FROM startup_phase_event_legacy;

DROP TABLE startup_phase_event_legacy;

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

DROP VIEW project_read_model;
DROP TABLE source_admission_assertion;
DROP INDEX project_repository_grant_idx;
DROP INDEX project_repository_owner_idx;

ALTER TABLE project_repository RENAME TO project_repository_legacy;

CREATE TABLE project_repository (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'forgejo')),
  binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
  full_name TEXT NOT NULL CHECK (length(full_name) BETWEEN 3 AND 512),
  web_url TEXT NOT NULL CHECK (length(web_url) BETWEEN 1 AND 512),
  clone_url TEXT CHECK (clone_url IS NULL OR length(clone_url) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, binding_revision),
  CHECK (provider != 'github' OR clone_url IS NULL OR (
    clone_url LIKE 'https://github.com/%/%.git'
    AND instr(clone_url, '@') = 0
    AND instr(clone_url, '?') = 0
    AND instr(clone_url, '#') = 0
  ))
);

INSERT INTO project_repository (
  project_id, provider, binding_revision, full_name, web_url, clone_url,
  created_at, updated_at
)
SELECT project_id, provider, binding_revision, full_name, web_url, clone_url,
       created_at, updated_at
  FROM project_repository_legacy;

CREATE TABLE project_source_authority (
  project_id TEXT PRIMARY KEY REFERENCES project_repository(project_id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'forgejo')),
  owner_scope TEXT NOT NULL CHECK (owner_scope IN ('personal', 'workspace')),
  owner_id TEXT NOT NULL,
  owner_grant_id TEXT REFERENCES github_owner_grant(id) ON DELETE RESTRICT,
  installation_id TEXT,
  provider_repository_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
  provenance TEXT NOT NULL CHECK (provenance IN ('live-grant', 'legacy')),
  default_branch TEXT,
  source_health TEXT NOT NULL CHECK (source_health IN ('available', 'action-required', 'unavailable', 'unknown')),
  source_health_reason TEXT CHECK (source_health_reason IS NULL OR source_health_reason IN (
    'connection-reauthorization-required', 'grant-missing', 'installation-suspended',
    'installation-permissions-changed', 'grant-disconnected', 'installation-removed',
    'repository-access-removed', 'repository-not-selected', 'stale-authorization-epoch',
    'stale-binding', 'stale-snapshot', 'provider-disabled',
    'personal-grant-not-allowed-for-workspace', 'provider-unreachable'
  )),
  authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 0),
  installation_epoch INTEGER NOT NULL CHECK (installation_epoch >= 0),
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id, binding_revision)
    REFERENCES project_repository(project_id, binding_revision) ON DELETE CASCADE,
  CHECK (
    (provenance = 'live-grant' AND provider = 'github' AND owner_grant_id IS NOT NULL
      AND installation_id IS NOT NULL AND default_branch IS NOT NULL
      AND source_health = 'available')
    OR (provenance = 'legacy' AND source_health = 'action-required')
  )
);

INSERT INTO project_source_authority (
  project_id, provider, owner_scope, owner_id, owner_grant_id, installation_id,
  provider_repository_id, binding_revision, provenance, default_branch,
  source_health, source_health_reason, authorization_epoch, installation_epoch,
  policy_revision, created_at, updated_at
)
SELECT project_id, provider, owner_scope, owner_id, owner_grant_id, installation_id,
       provider_repository_id, binding_revision, provenance, default_branch,
       source_health, source_health_reason, authorization_epoch, installation_epoch,
       policy_revision, created_at, updated_at
  FROM project_repository_legacy;

DROP TABLE project_repository_legacy;

CREATE INDEX project_source_authority_grant_idx
  ON project_source_authority(owner_grant_id, installation_id, provider_repository_id);
CREATE INDEX project_source_authority_owner_idx
  ON project_source_authority(owner_scope, owner_id, source_health, project_id);

CREATE TABLE source_admission_assertion (
  project_id TEXT NOT NULL UNIQUE
    REFERENCES project_source_authority(project_id) ON DELETE CASCADE
);

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
  projects.public_code_enabled, projects.created_at, projects.updated_at
FROM projects
LEFT JOIN project_repository ON project_repository.project_id = projects.id;

DROP TRIGGER source_control_operation_intent_immutable;
DROP TRIGGER source_control_operation_transition;
DROP TRIGGER source_control_operation_terminal_immutable;
DROP TRIGGER source_control_operation_no_delete;
DROP INDEX source_control_operation_thread_time_idx;
DROP INDEX source_control_operation_reconcile_idx;
ALTER TABLE source_control_operation RENAME TO source_control_operation_legacy;

DROP TRIGGER thread_source_snapshot_immutable_update;
DROP TRIGGER thread_source_snapshot_immutable_delete;
DROP INDEX thread_source_snapshot_project_idx;
DROP INDEX thread_source_snapshot_grant_idx;
ALTER TABLE thread_source_snapshot RENAME TO thread_source_snapshot_legacy;

CREATE TABLE thread_source_snapshot (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
  provider TEXT NOT NULL CHECK (provider = 'github'),
  repository_full_name TEXT NOT NULL CHECK (length(repository_full_name) BETWEEN 3 AND 512),
  clone_url TEXT NOT NULL CHECK (
    clone_url LIKE 'https://github.com/%/%.git'
    AND instr(clone_url, '@') = 0
    AND instr(clone_url, '?') = 0
    AND instr(clone_url, '#') = 0
  ),
  default_branch TEXT NOT NULL,
  initial_ref TEXT NOT NULL,
  initial_commit_sha TEXT NOT NULL CHECK (
    length(initial_commit_sha) = 40
    AND initial_commit_sha NOT GLOB '*[^a-f0-9]*'
  ),
  created_at TEXT NOT NULL
);

INSERT INTO thread_source_snapshot (
  thread_id, project_id, binding_revision, provider, repository_full_name,
  clone_url, default_branch, initial_ref, initial_commit_sha, created_at
)
SELECT thread_id, project_id, binding_revision, provider, repository_full_name,
       clone_url, default_branch, initial_ref, initial_commit_sha, created_at
  FROM thread_source_snapshot_legacy;

CREATE TABLE thread_source_authority (
  thread_id TEXT PRIMARY KEY REFERENCES thread_source_snapshot(thread_id) ON DELETE CASCADE,
  owner_grant_id TEXT NOT NULL REFERENCES github_owner_grant(id) ON DELETE RESTRICT,
  installation_id TEXT NOT NULL,
  provider_repository_id TEXT NOT NULL,
  authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 1),
  installation_epoch INTEGER NOT NULL CHECK (installation_epoch >= 1),
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 0),
  private_submodule_repository_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(private_submodule_repository_ids_json)
      AND json_type(private_submodule_repository_ids_json) = 'array'
      AND json_array_length(private_submodule_repository_ids_json) <= 16)
);

INSERT INTO thread_source_authority (
  thread_id, owner_grant_id, installation_id, provider_repository_id,
  authorization_epoch, installation_epoch, policy_revision,
  private_submodule_repository_ids_json
)
SELECT thread_id, owner_grant_id, installation_id, provider_repository_id,
       authorization_epoch, installation_epoch, policy_revision,
       private_submodule_repository_ids_json
  FROM thread_source_snapshot_legacy;

CREATE TABLE thread_source_intent (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
  provider TEXT NOT NULL CHECK (provider = 'github'),
  repository_full_name TEXT NOT NULL CHECK (length(repository_full_name) BETWEEN 3 AND 512),
  clone_url TEXT NOT NULL CHECK (
    clone_url LIKE 'https://github.com/%/%.git'
    AND instr(clone_url, '@') = 0
    AND instr(clone_url, '?') = 0
    AND instr(clone_url, '#') = 0
  ),
  created_at TEXT NOT NULL
);

CREATE TABLE thread_source_finalization_assertion (
  thread_id TEXT NOT NULL UNIQUE
    REFERENCES thread_source_snapshot(thread_id) ON DELETE CASCADE
);

CREATE TABLE thread_source_intent_assertion (
  thread_id TEXT NOT NULL UNIQUE
    REFERENCES thread_source_intent(thread_id) ON DELETE CASCADE
);

CREATE INDEX thread_source_snapshot_project_idx
  ON thread_source_snapshot(project_id, binding_revision, thread_id);
CREATE INDEX thread_source_authority_grant_idx
  ON thread_source_authority(owner_grant_id, installation_id, provider_repository_id);
CREATE INDEX thread_source_intent_project_idx
  ON thread_source_intent(project_id, binding_revision, thread_id);

CREATE TRIGGER thread_source_snapshot_immutable_update
BEFORE UPDATE ON thread_source_snapshot
BEGIN
  SELECT RAISE(ABORT, 'thread source snapshots are immutable');
END;

CREATE TRIGGER thread_source_snapshot_immutable_delete
BEFORE DELETE ON thread_source_snapshot
WHEN EXISTS (SELECT 1 FROM threads WHERE id = OLD.thread_id)
BEGIN
  SELECT RAISE(ABORT, 'thread source snapshots are immutable');
END;

CREATE TRIGGER thread_source_authority_immutable_update
BEFORE UPDATE ON thread_source_authority
BEGIN
  SELECT RAISE(ABORT, 'thread source authority is immutable');
END;

CREATE TRIGGER thread_source_authority_immutable_delete
BEFORE DELETE ON thread_source_authority
WHEN EXISTS (SELECT 1 FROM threads WHERE id = OLD.thread_id)
BEGIN
  SELECT RAISE(ABORT, 'thread source authority is immutable');
END;

CREATE TRIGGER thread_source_intent_immutable_update
BEFORE UPDATE ON thread_source_intent
BEGIN
  SELECT RAISE(ABORT, 'thread source intents are immutable');
END;

CREATE TRIGGER thread_source_intent_finalized_delete
BEFORE DELETE ON thread_source_intent
WHEN EXISTS (SELECT 1 FROM threads WHERE id = OLD.thread_id)
  AND NOT EXISTS (
    SELECT 1 FROM thread_source_snapshot AS snapshot
     WHERE snapshot.thread_id = OLD.thread_id
       AND snapshot.project_id = OLD.project_id
       AND snapshot.binding_revision = OLD.binding_revision
       AND snapshot.provider = OLD.provider
       AND snapshot.repository_full_name = OLD.repository_full_name
       AND snapshot.clone_url = OLD.clone_url
  )
BEGIN
  SELECT RAISE(ABORT, 'thread source intents may only be deleted after finalization');
END;

CREATE TABLE source_control_operation (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  idempotency_key_hash TEXT NOT NULL CHECK (
    length(idempotency_key_hash) = 64
    AND idempotency_key_hash NOT GLOB '*[^a-f0-9]*'
  ),
  actor_user_id TEXT NOT NULL CHECK (length(actor_user_id) BETWEEN 1 AND 128),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
  thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 128),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 32),
  provider_repository_id TEXT NOT NULL CHECK (
    length(provider_repository_id) BETWEEN 1 AND 256
  ),
  semantic_kind TEXT NOT NULL CHECK (semantic_kind IN (
    'contents-push', 'workflow-write', 'pull-request-write',
    'issue-write', 'actions-write'
  )),
  expected_remote_sha TEXT CHECK (
    expected_remote_sha IS NULL OR (
      length(expected_remote_sha) = 40
      AND expected_remote_sha NOT GLOB '*[^a-f0-9]*'
    )
  ),
  intended_sha TEXT CHECK (
    intended_sha IS NULL OR (
      length(intended_sha) = 40
      AND intended_sha NOT GLOB '*[^a-f0-9]*'
    )
  ),
  input_identity_hash TEXT CHECK (
    input_identity_hash IS NULL OR (
      length(input_identity_hash) = 64
      AND input_identity_hash NOT GLOB '*[^a-f0-9]*'
    )
  ),
  state TEXT NOT NULL CHECK (state IN (
    'pending', 'executing', 'succeeded', 'failed', 'reconcile-required'
  )),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt BETWEEN 0 AND 100),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  provider_result_opaque_id TEXT CHECK (
    provider_result_opaque_id IS NULL
    OR length(provider_result_opaque_id) BETWEEN 1 AND 256
  ),
  provider_result_category TEXT CHECK (
    provider_result_category IS NULL OR provider_result_category IN (
      'applied', 'rejected', 'conflict', 'not-observed', 'unavailable'
    )
  ),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  completed_at TEXT CHECK (
    completed_at IS NULL OR length(completed_at) BETWEEN 20 AND 40
  ),
  FOREIGN KEY (thread_id, project_id, actor_user_id)
    REFERENCES threads(id, project_id, owner_user_id) ON DELETE RESTRICT,
  FOREIGN KEY (thread_id) REFERENCES thread_source_authority(thread_id) ON DELETE RESTRICT,
  UNIQUE(thread_id, provider, provider_repository_id, idempotency_key_hash),
  CHECK (expected_remote_sha IS NULL OR semantic_kind IN ('contents-push', 'workflow-write')),
  CHECK (intended_sha IS NULL OR semantic_kind IN ('contents-push', 'workflow-write')),
  CHECK (expected_remote_sha IS NULL OR intended_sha IS NOT NULL),
  CHECK (input_identity_hash IS NOT NULL OR intended_sha IS NOT NULL),
  CHECK (
    (state IN ('pending', 'executing', 'reconcile-required') AND completed_at IS NULL)
    OR (state IN ('succeeded', 'failed') AND completed_at IS NOT NULL)
  )
);

INSERT INTO source_control_operation
SELECT * FROM source_control_operation_legacy;

DROP TABLE source_control_operation_legacy;
DROP TABLE thread_source_snapshot_legacy;

CREATE INDEX source_control_operation_thread_time_idx
  ON source_control_operation(thread_id, updated_at DESC, id DESC);
CREATE INDEX source_control_operation_reconcile_idx
  ON source_control_operation(state, updated_at, id)
  WHERE state IN ('executing', 'reconcile-required');

CREATE TRIGGER source_control_operation_intent_immutable
BEFORE UPDATE ON source_control_operation
WHEN NEW.id != OLD.id
  OR NEW.idempotency_key_hash != OLD.idempotency_key_hash
  OR NEW.actor_user_id != OLD.actor_user_id
  OR NEW.project_id != OLD.project_id
  OR NEW.thread_id != OLD.thread_id
  OR NEW.provider != OLD.provider
  OR NEW.provider_repository_id != OLD.provider_repository_id
  OR NEW.semantic_kind != OLD.semantic_kind
  OR NEW.expected_remote_sha IS NOT OLD.expected_remote_sha
  OR NEW.intended_sha IS NOT OLD.intended_sha
  OR NEW.input_identity_hash IS NOT OLD.input_identity_hash
  OR NEW.created_at != OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'source-control operation intent is immutable');
END;

CREATE TRIGGER source_control_operation_transition
BEFORE UPDATE ON source_control_operation
WHEN NOT (
  (OLD.state = 'pending' AND NEW.state IN ('executing', 'failed'))
  OR (OLD.state = 'executing' AND NEW.state IN ('succeeded', 'failed', 'reconcile-required'))
  OR (OLD.state = 'reconcile-required' AND NEW.state IN ('executing', 'succeeded', 'failed'))
)
OR NEW.version != OLD.version + 1
OR NEW.attempt != OLD.attempt + CASE WHEN NEW.state = 'executing' THEN 1 ELSE 0 END
BEGIN
  SELECT RAISE(ABORT, 'invalid source-control operation transition');
END;

CREATE TRIGGER source_control_operation_terminal_immutable
BEFORE UPDATE ON source_control_operation
WHEN OLD.state IN ('succeeded', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'source-control operation is terminal');
END;

CREATE TRIGGER source_control_operation_no_delete
BEFORE DELETE ON source_control_operation
BEGIN
  SELECT RAISE(ABORT, 'source-control operation cannot be deleted');
END;

ALTER TABLE organization
ADD COLUMN profileRevision INTEGER NOT NULL DEFAULT 0 CHECK (profileRevision >= 0);

ALTER TABLE execution_workspace
ADD COLUMN ready_at TEXT;

ALTER TABLE execution_workspace
ADD COLUMN preparation_status TEXT CHECK (
  preparation_status IS NULL
    OR length(preparation_status) BETWEEN 1 AND 160
);

DROP TRIGGER execution_workspace_transition_before_update;

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

UPDATE execution_workspace
SET ready_at = updated_at
WHERE state IN ('initialized', 'lost');

CREATE TRIGGER execution_workspace_readiness_immutable_before_update
BEFORE UPDATE OF ready_at ON execution_workspace
WHEN OLD.ready_at IS NOT NULL
  AND NEW.ready_at IS NOT OLD.ready_at
BEGIN
  SELECT RAISE(ABORT, 'execution workspace readiness is immutable');
END;

CREATE TABLE workload_identity_issuance_audit (
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
  runtime_provider TEXT NOT NULL CHECK (runtime_provider IN ('local', 'e2b')),
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

CREATE INDEX workload_identity_audit_thread_time_idx
  ON workload_identity_issuance_audit(thread_id, occurred_at DESC, issuance_id DESC);

CREATE INDEX workload_identity_audit_actor_time_idx
  ON workload_identity_issuance_audit(actor_user_id, occurred_at DESC, issuance_id DESC);

CREATE INDEX workload_identity_audit_outcome_time_idx
  ON workload_identity_issuance_audit(outcome, occurred_at DESC, issuance_id DESC);

CREATE TABLE workload_identity_audit_retention_gate (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  delete_before TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

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

CREATE TABLE bitbucket_connection (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id),
  provider_account_id TEXT NOT NULL,
  account_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'reauthorization-required', 'disconnected')),
  authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 1),
  access_credential_id TEXT,
  refresh_credential_id TEXT,
  expires_at TEXT,
  refresh_lock_id TEXT,
  refresh_lock_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX bitbucket_connection_user_live_idx
  ON bitbucket_connection(user_id) WHERE status != 'disconnected';

CREATE TABLE bitbucket_oauth_state (
  state_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id),
  session_id TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE bitbucket_repository (
  connection_id TEXT NOT NULL REFERENCES bitbucket_connection(id),
  repository_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  web_url TEXT NOT NULL,
  clone_url TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
  PRIMARY KEY(connection_id, repository_id)
);

CREATE TABLE bitbucket_git_lease (
  id_hash TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  authorization_epoch INTEGER NOT NULL,
  binding_revision INTEGER NOT NULL,
  operation TEXT NOT NULL,
  target_branch TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(connection_id) REFERENCES bitbucket_connection(id)
);

CREATE INDEX bitbucket_git_lease_expiry_idx
  ON bitbucket_git_lease(expires_at);

CREATE TABLE bitbucket_lfs_action (
  id TEXT PRIMARY KEY,
  lease_id_hash TEXT NOT NULL REFERENCES bitbucket_git_lease(id_hash) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK (method IN ('GET', 'PUT', 'POST')),
  oid TEXT NOT NULL,
  size INTEGER NOT NULL,
  envelope_json TEXT NOT NULL CHECK (json_valid(envelope_json))
);

DROP VIEW project_read_model;
ALTER TABLE source_admission_assertion RENAME TO source_admission_assertion_0044;
DROP INDEX project_source_authority_grant_idx;
DROP INDEX project_source_authority_owner_idx;
ALTER TABLE project_source_authority RENAME TO project_source_authority_0044;
ALTER TABLE project_repository RENAME TO project_repository_0044;

CREATE TABLE project_repository (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'bitbucket', 'gitlab', 'forgejo')),
  binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
  full_name TEXT NOT NULL CHECK (length(full_name) BETWEEN 3 AND 512),
  web_url TEXT NOT NULL CHECK (length(web_url) BETWEEN 1 AND 512),
  clone_url TEXT CHECK (clone_url IS NULL OR length(clone_url) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, binding_revision),
  CHECK (provider != 'github' OR clone_url IS NULL OR (
    clone_url LIKE 'https://github.com/%/%.git'
    AND instr(substr(clone_url, 9), '@') = 0
    AND instr(clone_url, '?') = 0 AND instr(clone_url, '#') = 0
  )),
  CHECK (provider != 'bitbucket' OR (
    web_url LIKE 'https://bitbucket.org/%/%'
    AND web_url NOT LIKE 'https://bitbucket.org/%/%/%'
    AND instr(substr(web_url, 9), '@') = 0
    AND instr(web_url, '?') = 0 AND instr(web_url, '#') = 0
    AND (clone_url IS NULL OR (
      clone_url LIKE 'https://bitbucket.org/%/%.git'
      AND instr(substr(clone_url, 9), '@') = 0
      AND instr(clone_url, '?') = 0 AND instr(clone_url, '#') = 0
    ))
  ))
);

INSERT INTO project_repository SELECT * FROM project_repository_0044;

CREATE TABLE project_source_authority (
  project_id TEXT PRIMARY KEY REFERENCES project_repository(project_id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'bitbucket', 'gitlab', 'forgejo')),
  owner_scope TEXT NOT NULL CHECK (owner_scope IN ('personal', 'workspace')),
  owner_id TEXT NOT NULL,
  owner_grant_id TEXT,
  installation_id TEXT,
  provider_workspace_id TEXT,
  provider_repository_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
  provenance TEXT NOT NULL CHECK (provenance IN ('live-grant', 'legacy')),
  default_branch TEXT,
  source_health TEXT NOT NULL CHECK (source_health IN ('available', 'action-required', 'unavailable', 'unknown')),
  source_health_reason TEXT,
  authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 0),
  installation_epoch INTEGER NOT NULL CHECK (installation_epoch >= 0),
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id, binding_revision)
    REFERENCES project_repository(project_id, binding_revision) ON DELETE CASCADE,
  CHECK (
    (provenance = 'live-grant' AND provider = 'github'
      AND owner_grant_id IS NOT NULL AND installation_id IS NOT NULL
      AND provider_workspace_id IS NULL
      AND default_branch IS NOT NULL AND source_health = 'available')
    OR (provenance = 'live-grant' AND provider = 'bitbucket'
      AND owner_scope = 'personal' AND owner_grant_id IS NOT NULL
      AND installation_id IS NULL AND provider_workspace_id IS NOT NULL
      AND ((length(provider_workspace_id) = 36 AND provider_workspace_id GLOB '????????-????-????-????-????????????')
        OR (length(provider_workspace_id) = 38 AND provider_workspace_id GLOB '{????????-????-????-????-????????????}'))
      AND installation_epoch = 0
      AND policy_revision = 0 AND default_branch IS NOT NULL
      AND source_health = 'available')
    OR (provenance = 'legacy' AND source_health = 'action-required')
  )
);

INSERT INTO project_source_authority (
  project_id, provider, owner_scope, owner_id, owner_grant_id, installation_id,
  provider_workspace_id, provider_repository_id, binding_revision, provenance,
  default_branch, source_health, source_health_reason, authorization_epoch,
  installation_epoch, policy_revision, created_at, updated_at
)
SELECT project_id, provider, owner_scope, owner_id, owner_grant_id, installation_id,
       NULL, provider_repository_id, binding_revision, provenance, default_branch,
       source_health, source_health_reason, authorization_epoch, installation_epoch,
       policy_revision, created_at, updated_at
  FROM project_source_authority_0044;

CREATE INDEX project_source_authority_grant_idx
  ON project_source_authority(owner_grant_id, installation_id, provider_repository_id);
CREATE INDEX project_source_authority_owner_idx
  ON project_source_authority(owner_scope, owner_id, source_health, project_id);
CREATE TABLE source_admission_assertion (
  project_id TEXT NOT NULL UNIQUE
    REFERENCES project_source_authority(project_id) ON DELETE CASCADE
);
INSERT INTO source_admission_assertion SELECT * FROM source_admission_assertion_0044;
DROP TABLE source_admission_assertion_0044;
DROP TABLE project_source_authority_0044;
DROP TABLE project_repository_0044;

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
  projects.public_code_enabled, projects.created_at, projects.updated_at
FROM projects
LEFT JOIN project_repository ON project_repository.project_id = projects.id;

CREATE TRIGGER project_source_authority_grant_insert
BEFORE INSERT ON project_source_authority
WHEN NEW.provenance = 'live-grant' AND NOT (
  (NEW.provider = 'github' AND EXISTS (
    SELECT 1 FROM github_owner_grant
     WHERE id = NEW.owner_grant_id AND installation_id = NEW.installation_id
  )) OR
  (NEW.provider = 'bitbucket' AND EXISTS (
    SELECT 1 FROM bitbucket_connection
     WHERE id = NEW.owner_grant_id AND user_id = NEW.owner_id
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'project source authority grant is invalid');
END;

CREATE TRIGGER project_source_authority_grant_update
BEFORE UPDATE ON project_source_authority
WHEN NEW.provenance = 'live-grant' AND NOT (
  (NEW.provider = 'github' AND EXISTS (
    SELECT 1 FROM github_owner_grant
     WHERE id = NEW.owner_grant_id AND installation_id = NEW.installation_id
  )) OR
  (NEW.provider = 'bitbucket' AND EXISTS (
    SELECT 1 FROM bitbucket_connection
     WHERE id = NEW.owner_grant_id AND user_id = NEW.owner_id
  ))
)
BEGIN
  SELECT RAISE(ABORT, 'project source authority grant is invalid');
END;

DROP TRIGGER source_control_operation_intent_immutable;
DROP TRIGGER source_control_operation_transition;
DROP TRIGGER source_control_operation_terminal_immutable;
DROP TRIGGER source_control_operation_no_delete;
DROP INDEX source_control_operation_thread_time_idx;
DROP INDEX source_control_operation_reconcile_idx;
ALTER TABLE source_control_operation RENAME TO source_control_operation_0044;

ALTER TABLE thread_source_finalization_assertion RENAME TO thread_source_finalization_assertion_0044;
ALTER TABLE thread_source_intent_assertion RENAME TO thread_source_intent_assertion_0044;
DROP TRIGGER thread_source_authority_immutable_update;
DROP TRIGGER thread_source_authority_immutable_delete;
DROP TRIGGER thread_source_snapshot_immutable_update;
DROP TRIGGER thread_source_snapshot_immutable_delete;
DROP TRIGGER thread_source_intent_immutable_update;
DROP TRIGGER thread_source_intent_finalized_delete;
DROP INDEX thread_source_snapshot_project_idx;
DROP INDEX thread_source_authority_grant_idx;
DROP INDEX thread_source_intent_project_idx;
ALTER TABLE thread_source_authority RENAME TO thread_source_authority_0044;
ALTER TABLE thread_source_snapshot RENAME TO thread_source_snapshot_0044;
ALTER TABLE thread_source_intent RENAME TO thread_source_intent_0044;

CREATE TABLE thread_source_snapshot (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
  provider TEXT NOT NULL CHECK (provider IN ('github', 'bitbucket')),
  repository_full_name TEXT NOT NULL CHECK (length(repository_full_name) BETWEEN 3 AND 512),
  clone_url TEXT NOT NULL CHECK (
    ((provider = 'github' AND clone_url LIKE 'https://github.com/%/%.git')
      OR (provider = 'bitbucket' AND clone_url LIKE 'https://bitbucket.org/%/%.git'))
    AND instr(substr(clone_url, 9), '@') = 0
    AND instr(clone_url, '?') = 0 AND instr(clone_url, '#') = 0
  ),
  default_branch TEXT NOT NULL,
  initial_ref TEXT NOT NULL,
  initial_commit_sha TEXT NOT NULL CHECK (
    length(initial_commit_sha) = 40 AND initial_commit_sha NOT GLOB '*[^a-f0-9]*'
  ),
  created_at TEXT NOT NULL
);
INSERT INTO thread_source_snapshot SELECT * FROM thread_source_snapshot_0044;

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
    CHECK (json_valid(private_submodule_repository_ids_json)
      AND json_type(private_submodule_repository_ids_json) = 'array'
      AND json_array_length(private_submodule_repository_ids_json) <= 16),
  CHECK ((installation_id IS NOT NULL AND provider_workspace_id IS NULL AND installation_epoch >= 1)
    OR (installation_id IS NULL AND provider_workspace_id IS NOT NULL
      AND ((length(provider_workspace_id) = 36 AND provider_workspace_id GLOB '????????-????-????-????-????????????')
        OR (length(provider_workspace_id) = 38 AND provider_workspace_id GLOB '{????????-????-????-????-????????????}'))
      AND installation_epoch = 0))
);
INSERT INTO thread_source_authority (
  thread_id, owner_grant_id, installation_id, provider_workspace_id,
  provider_repository_id, authorization_epoch, installation_epoch,
  policy_revision, private_submodule_repository_ids_json
)
SELECT thread_id, owner_grant_id, installation_id, NULL, provider_repository_id,
       authorization_epoch, installation_epoch, policy_revision,
       private_submodule_repository_ids_json
FROM thread_source_authority_0044;

CREATE TABLE thread_source_intent (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
  provider TEXT NOT NULL CHECK (provider IN ('github', 'bitbucket')),
  repository_full_name TEXT NOT NULL CHECK (length(repository_full_name) BETWEEN 3 AND 512),
  clone_url TEXT NOT NULL CHECK (
    ((provider = 'github' AND clone_url LIKE 'https://github.com/%/%.git')
      OR (provider = 'bitbucket' AND clone_url LIKE 'https://bitbucket.org/%/%.git'))
    AND instr(substr(clone_url, 9), '@') = 0
    AND instr(clone_url, '?') = 0 AND instr(clone_url, '#') = 0
  ),
  created_at TEXT NOT NULL
);
INSERT INTO thread_source_intent SELECT * FROM thread_source_intent_0044;

CREATE TRIGGER thread_source_authority_grant_insert
BEFORE INSERT ON thread_source_authority
WHEN NOT EXISTS (
  SELECT 1 FROM thread_source_snapshot AS snapshot
  WHERE snapshot.thread_id = NEW.thread_id AND (
    (snapshot.provider = 'github' AND NEW.provider_workspace_id IS NULL AND EXISTS (
      SELECT 1 FROM github_owner_grant
      WHERE id = NEW.owner_grant_id AND installation_id = NEW.installation_id
    )) OR
    (snapshot.provider = 'bitbucket' AND NEW.installation_id IS NULL AND EXISTS (
      SELECT 1 FROM bitbucket_connection WHERE id = NEW.owner_grant_id
    ))
  )
)
BEGIN SELECT RAISE(ABORT, 'thread source authority grant is invalid'); END;

CREATE INDEX thread_source_snapshot_project_idx ON thread_source_snapshot(project_id, binding_revision, thread_id);
CREATE INDEX thread_source_authority_grant_idx ON thread_source_authority(owner_grant_id, installation_id, provider_repository_id);
CREATE INDEX thread_source_intent_project_idx ON thread_source_intent(project_id, binding_revision, thread_id);
CREATE TABLE thread_source_finalization_assertion (thread_id TEXT NOT NULL UNIQUE REFERENCES thread_source_snapshot(thread_id) ON DELETE CASCADE);
CREATE TABLE thread_source_intent_assertion (thread_id TEXT NOT NULL UNIQUE REFERENCES thread_source_intent(thread_id) ON DELETE CASCADE);
INSERT INTO thread_source_finalization_assertion SELECT * FROM thread_source_finalization_assertion_0044;
INSERT INTO thread_source_intent_assertion SELECT * FROM thread_source_intent_assertion_0044;

CREATE TRIGGER thread_source_snapshot_immutable_update BEFORE UPDATE ON thread_source_snapshot BEGIN SELECT RAISE(ABORT, 'thread source snapshots are immutable'); END;
CREATE TRIGGER thread_source_snapshot_immutable_delete BEFORE DELETE ON thread_source_snapshot WHEN EXISTS (SELECT 1 FROM threads WHERE id = OLD.thread_id) BEGIN SELECT RAISE(ABORT, 'thread source snapshots are immutable'); END;
CREATE TRIGGER thread_source_authority_immutable_update BEFORE UPDATE ON thread_source_authority BEGIN SELECT RAISE(ABORT, 'thread source authority is immutable'); END;
CREATE TRIGGER thread_source_authority_immutable_delete BEFORE DELETE ON thread_source_authority WHEN EXISTS (SELECT 1 FROM threads WHERE id = OLD.thread_id) BEGIN SELECT RAISE(ABORT, 'thread source authority is immutable'); END;
CREATE TRIGGER thread_source_intent_immutable_update BEFORE UPDATE ON thread_source_intent BEGIN SELECT RAISE(ABORT, 'thread source intents are immutable'); END;
CREATE TRIGGER thread_source_intent_finalized_delete BEFORE DELETE ON thread_source_intent
WHEN EXISTS (SELECT 1 FROM threads WHERE id = OLD.thread_id) AND NOT EXISTS (
  SELECT 1 FROM thread_source_snapshot AS snapshot WHERE snapshot.thread_id = OLD.thread_id
    AND snapshot.project_id = OLD.project_id AND snapshot.binding_revision = OLD.binding_revision
    AND snapshot.provider = OLD.provider AND snapshot.repository_full_name = OLD.repository_full_name
    AND snapshot.clone_url = OLD.clone_url
) BEGIN SELECT RAISE(ABORT, 'thread source intents may only be deleted after finalization'); END;

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
  CHECK ((state IN ('pending', 'executing', 'reconcile-required') AND completed_at IS NULL)
    OR (state IN ('succeeded', 'failed') AND completed_at IS NOT NULL))
);
INSERT INTO source_control_operation SELECT * FROM source_control_operation_0044;
DROP TABLE source_control_operation_0044;
DROP TABLE thread_source_finalization_assertion_0044;
DROP TABLE thread_source_intent_assertion_0044;
DROP TABLE thread_source_authority_0044;
DROP TABLE thread_source_snapshot_0044;
DROP TABLE thread_source_intent_0044;

CREATE INDEX source_control_operation_thread_time_idx ON source_control_operation(thread_id, updated_at DESC, id DESC);
CREATE INDEX source_control_operation_reconcile_idx ON source_control_operation(state, updated_at, id) WHERE state IN ('executing', 'reconcile-required');
CREATE TRIGGER source_control_operation_intent_immutable BEFORE UPDATE ON source_control_operation
WHEN NEW.id != OLD.id OR NEW.idempotency_key_hash != OLD.idempotency_key_hash
 OR NEW.actor_user_id != OLD.actor_user_id OR NEW.project_id != OLD.project_id
 OR NEW.thread_id != OLD.thread_id OR NEW.provider != OLD.provider
 OR NEW.provider_repository_id != OLD.provider_repository_id OR NEW.semantic_kind != OLD.semantic_kind
 OR NEW.expected_remote_sha IS NOT OLD.expected_remote_sha OR NEW.intended_sha IS NOT OLD.intended_sha
 OR NEW.input_identity_hash IS NOT OLD.input_identity_hash OR NEW.created_at != OLD.created_at
BEGIN SELECT RAISE(ABORT, 'source-control operation intent is immutable'); END;
CREATE TRIGGER source_control_operation_transition BEFORE UPDATE ON source_control_operation
WHEN NOT ((OLD.state = 'pending' AND NEW.state IN ('executing', 'failed'))
 OR (OLD.state = 'executing' AND NEW.state IN ('succeeded', 'failed', 'reconcile-required'))
 OR (OLD.state = 'reconcile-required' AND NEW.state IN ('executing', 'succeeded', 'failed')))
 OR NEW.version != OLD.version + 1
 OR NEW.attempt != OLD.attempt + CASE WHEN NEW.state = 'executing' THEN 1 ELSE 0 END
BEGIN SELECT RAISE(ABORT, 'invalid source-control operation transition'); END;
CREATE TRIGGER source_control_operation_terminal_immutable BEFORE UPDATE ON source_control_operation
WHEN OLD.state IN ('succeeded', 'failed') BEGIN SELECT RAISE(ABORT, 'source-control operation is terminal'); END;
CREATE TRIGGER source_control_operation_no_delete BEFORE DELETE ON source_control_operation
BEGIN SELECT RAISE(ABORT, 'source-control operation cannot be deleted'); END;

CREATE TABLE dictation_job (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved','dispatching','provider','completed','failed','canceled')),
  provider_job_id TEXT,
  local_reads INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX dictation_job_owner_activity ON dictation_job(owner_id, created_at);
CREATE INDEX dictation_job_owner_expiry ON dictation_job(owner_id, expires_at);
CREATE UNIQUE INDEX dictation_job_owner_active ON dictation_job(owner_id)
  WHERE state IN ('reserved','dispatching','provider');

DROP TRIGGER startup_phase_event_monotonic_insert;
DROP TRIGGER startup_phase_event_immutable_update;
DROP TRIGGER startup_phase_event_retained_delete;
DROP INDEX startup_phase_expiry_idx;
DROP INDEX startup_phase_submission_idx;
DROP INDEX startup_phase_slo_idx;

ALTER TABLE startup_phase_event RENAME TO startup_phase_event_legacy;

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

INSERT INTO startup_phase_event (
  journey, request_id, thread_id, submission_id, phase, ordinal,
  occurred_at, expires_at, outcome, duration_ms, operation_count
)
SELECT
  CASE
    WHEN journey IN ('submission', 'submission_daemon_activation') AND phase IN (
      'daemon_requested', 'daemon_release_loaded', 'daemon_installed',
      'daemon_connected', 'daemon_environment_ready', 'sandbox_ready'
    ) THEN 'submission_daemon_activation'
    ELSE journey
  END ,
  request_id, thread_id, submission_id,
  CASE
    WHEN phase = 'daemon_requested' THEN 'requested'
    WHEN phase = 'daemon_release_loaded' THEN 'release_loaded'
    WHEN phase = 'daemon_installed' THEN 'installed'
    WHEN phase = 'daemon_connected' THEN 'connected'
    WHEN phase = 'daemon_environment_ready' THEN 'environment_ready'
    WHEN phase = 'sandbox_ready' THEN 'workspace_ready'
    ELSE phase
  END ,
  CASE
    WHEN phase = 'daemon_requested' THEN 0
    WHEN phase = 'daemon_release_loaded' THEN 1
    WHEN phase = 'daemon_installed' THEN 2
    WHEN phase = 'daemon_connected' THEN 3
    WHEN phase = 'daemon_environment_ready' THEN 4
    WHEN phase = 'sandbox_ready' THEN 5
    WHEN journey = 'submission' AND phase = 'changes_synced' THEN 6
    WHEN journey = 'submission' AND phase = 'context_discovered' THEN 7
    WHEN journey = 'submission' AND phase = 'model_requested' THEN 8
    WHEN journey = 'submission' AND phase = 'model_first_token' THEN 9
    WHEN journey = 'submission' AND phase = 'settled' THEN 10
    WHEN journey = 'terminal' AND phase = 'terminal_ready' THEN 30
    ELSE ordinal
  END ,
  occurred_at, expires_at, outcome, duration_ms, operation_count
FROM startup_phase_event_legacy;

DROP TABLE startup_phase_event_legacy;

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

DROP TABLE budget_alert;
DROP TABLE budget_admission;
DROP TABLE budget_policy_audit;
DROP TABLE budget_policy;

ALTER TABLE github_oauth_transaction
  ADD COLUMN return_to TEXT
  CHECK (
    return_to IS NULL OR (
      length(return_to) BETWEEN 1 AND 2048
      AND substr(return_to, 1, 1) = '/'
      AND substr(return_to, 1, 2) != '//'
    )
  );

ALTER TABLE github_setup_transaction
  ADD COLUMN return_to TEXT
  CHECK (
    return_to IS NULL OR (
      length(return_to) BETWEEN 1 AND 2048
      AND substr(return_to, 1, 1) = '/'
      AND substr(return_to, 1, 2) != '//'
    )
  );

-- Existing branch databases may apply this backfilled migration after 0050.
-- Remove the ordinary-name indexes while rows pass through their staging names;
-- 0050 creates them for fresh databases and 0052 restores them for backfills.
DROP INDEX IF EXISTS projects_personal_name_unique_idx;
DROP INDEX IF EXISTS projects_workspace_name_unique_idx;

CREATE TABLE project_identity_original AS
SELECT
  rowid AS project_rowid,
  owner_user_id,
  workspace_id,
  name AS original_name
FROM projects
WHERE name != 'No Project';

-- Move every ordinary Project into a rowid-derived namespace first. This makes
-- reconciliation deterministic even when a historical name already resembles
-- the suffix used for a duplicate.
UPDATE projects
SET name = 'p-' || rowid
WHERE name != 'No Project';

-- Restore the oldest row for each case-insensitive scoped name when that name
-- does not collide with another row's fallback. Later duplicates retain their
-- unique rowid-derived name, so no Project or foreign-key reference is lost.
UPDATE projects AS project
SET name = (
  SELECT original.original_name
  FROM project_identity_original AS original
  WHERE original.project_rowid = project.rowid
)
WHERE EXISTS (
  SELECT 1
  FROM project_identity_original AS original
  WHERE original.project_rowid = project.rowid
    AND original.project_rowid = (
      SELECT MIN(candidate.project_rowid)
      FROM project_identity_original AS candidate
      WHERE candidate.original_name = original.original_name COLLATE NOCASE
        AND (
          (candidate.workspace_id IS NULL
            AND original.workspace_id IS NULL
            AND candidate.owner_user_id = original.owner_user_id)
          OR candidate.workspace_id = original.workspace_id
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM project_identity_original AS fallback
      WHERE fallback.project_rowid != original.project_rowid
        AND ('p-' || fallback.project_rowid) = original.original_name COLLATE NOCASE
        AND (
          (fallback.workspace_id IS NULL
            AND original.workspace_id IS NULL
            AND fallback.owner_user_id = original.owner_user_id)
          OR fallback.workspace_id = original.workspace_id
        )
    )
);

DROP TABLE project_identity_original;

CREATE TABLE model_connection_v2 (
  id TEXT NOT NULL PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  target_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK (kind IN ('workers-ai-binding', 'built-in-deployment', 'openai-platform', 'openai-compatible', 'provider-api-key', 'personal-subscription')),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
  endpoint TEXT CHECK (endpoint IS NULL OR length(endpoint) BETWEEN 1 AND 2048),
  credential_reference_id TEXT REFERENCES environment_variable(id) ON DELETE RESTRICT,
  retention TEXT NOT NULL CHECK (retention IN ('provider-policy', 'zero-data-retention', 'may-retain')),
  configured_models TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(configured_models) AND json_array_length(configured_models) <= 100),
  health_state TEXT NOT NULL DEFAULT 'untested' CHECK (health_state IN ('untested', 'healthy', 'unhealthy', 'unavailable')),
  health_code TEXT NOT NULL DEFAULT 'NOT_TESTED' CHECK (length(health_code) BETWEEN 1 AND 64),
  health_checked_at TEXT,
  health_latency_ms INTEGER CHECK (health_latency_ms BETWEEN 0 AND 30000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope, target_id, name),
  CHECK (kind <> 'personal-subscription' OR (scope = 'personal' AND provider_id = 'dx-subscription')),
  CHECK (kind <> 'provider-api-key' OR credential_reference_id IS NOT NULL)
);

INSERT INTO model_connection_v2 SELECT * FROM model_connection;
DROP TABLE model_connection;
ALTER TABLE model_connection_v2 RENAME TO model_connection;
CREATE INDEX model_connection_target_idx ON model_connection (scope, target_id, name, id);

ALTER TABLE thread_changes_state
ADD COLUMN summary_additions INTEGER CHECK (
  summary_additions IS NULL OR summary_additions >= 0
);

ALTER TABLE thread_changes_state
ADD COLUMN summary_deletions INTEGER CHECK (
  summary_deletions IS NULL OR summary_deletions >= 0
);

ALTER TABLE thread_changes_state
ADD COLUMN summary_files INTEGER CHECK (
  summary_files IS NULL OR summary_files >= 0
);

CREATE TABLE auth_waitlist (
  email TEXT PRIMARY KEY COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  approved_at TEXT
);

CREATE INDEX auth_waitlist_status_created_idx
  ON auth_waitlist(status, created_at);

ALTER TABLE model_connection
  ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1));

ALTER TABLE model_connection
  ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX projects_personal_name_unique_idx
  ON projects(owner_user_id, name COLLATE NOCASE)
  WHERE workspace_id IS NULL AND name != 'No Project';

CREATE UNIQUE INDEX projects_workspace_name_unique_idx
  ON projects(workspace_id, name COLLATE NOCASE)
  WHERE workspace_id IS NOT NULL AND name != 'No Project';

CREATE UNIQUE INDEX projects_projectless_owner_unique_idx
  ON projects(owner_user_id)
  WHERE name = 'No Project';

CREATE TABLE model_credential (
  id TEXT NOT NULL PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  target_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  envelope_version INTEGER NOT NULL CHECK (envelope_version = 1),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  value_nonce TEXT NOT NULL CHECK (length(value_nonce) = 16),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 24 AND 65536),
  wrapped_key_nonce TEXT NOT NULL CHECK (length(wrapped_key_nonce) = 16),
  wrapped_key TEXT NOT NULL CHECK (length(wrapped_key) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX model_credential_target_idx
  ON model_credential (scope, target_id, id);

-- Rebuilding the parent table would otherwise cascade-delete subscription
-- credentials and entitlement state while foreign key enforcement is on.
CREATE TABLE model_subscription_connection_0051 AS
SELECT * FROM personal_model_subscription_connection;
DROP TABLE personal_model_subscription_connection;

CREATE TABLE model_connection_v3 (
  id TEXT NOT NULL PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  target_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK (kind IN ('workers-ai-binding', 'built-in-deployment', 'openai-platform', 'openai-compatible', 'provider-api-key', 'personal-subscription')),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
  endpoint TEXT CHECK (endpoint IS NULL OR length(endpoint) BETWEEN 1 AND 2048),
  credential_reference_id TEXT REFERENCES environment_variable(id) ON DELETE RESTRICT,
  model_credential_id TEXT REFERENCES model_credential(id) ON DELETE RESTRICT,
  retention TEXT NOT NULL CHECK (retention IN ('provider-policy', 'zero-data-retention', 'may-retain')),
  configured_models TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(configured_models) AND json_array_length(configured_models) <= 100),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 0,
  health_state TEXT NOT NULL DEFAULT 'untested' CHECK (health_state IN ('untested', 'healthy', 'unhealthy', 'unavailable')),
  health_code TEXT NOT NULL DEFAULT 'NOT_TESTED' CHECK (length(health_code) BETWEEN 1 AND 64),
  health_checked_at TEXT,
  health_latency_ms INTEGER CHECK (health_latency_ms BETWEEN 0 AND 30000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope, target_id, name),
  CHECK (kind <> 'personal-subscription' OR (scope = 'personal' AND provider_id = 'dx-subscription')),
  CHECK (credential_reference_id IS NULL OR model_credential_id IS NULL),
  CHECK (kind <> 'provider-api-key' OR credential_reference_id IS NOT NULL OR model_credential_id IS NOT NULL)
);

INSERT INTO model_connection_v3 (
  id, scope, target_id, name, kind, provider_id, endpoint,
  credential_reference_id, retention, configured_models, enabled, priority,
  health_state, health_code, health_checked_at, health_latency_ms,
  created_at, updated_at
)
SELECT
  id, scope, target_id, name, kind, provider_id, endpoint,
  credential_reference_id, retention, configured_models, enabled, priority,
  health_state, health_code, health_checked_at, health_latency_ms,
  created_at, updated_at
FROM model_connection;

DROP TABLE model_connection;
ALTER TABLE model_connection_v3 RENAME TO model_connection;
CREATE INDEX model_connection_target_idx ON model_connection (scope, target_id, name, id);

CREATE TABLE personal_model_subscription_connection (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE CHECK (length(owner_user_id) BETWEEN 1 AND 128),
  provider TEXT NOT NULL CHECK (provider = 'github-copilot'),
  provider_account_id TEXT NOT NULL CHECK (length(provider_account_id) BETWEEN 1 AND 256),
  provider_account_login TEXT NOT NULL CHECK (length(provider_account_login) BETWEEN 1 AND 256),
  status TEXT NOT NULL CHECK (status IN ('connected', 'needs-reauthorization')),
  credential_envelope_json TEXT CHECK (credential_envelope_json IS NULL OR (json_valid(credential_envelope_json) AND length(credential_envelope_json) <= 16384)),
  credential_revision INTEGER NOT NULL DEFAULT 1 CHECK (credential_revision >= 1),
  entitlement_model_ids_json TEXT NOT NULL CHECK (json_valid(entitlement_model_ids_json) AND json_type(entitlement_model_ids_json) = 'array' AND json_array_length(entitlement_model_ids_json) <= 100),
  entitlement_catalog_revision TEXT NOT NULL CHECK (length(entitlement_catalog_revision) BETWEEN 1 AND 128),
  entitlement_observed_at TEXT NOT NULL CHECK (length(entitlement_observed_at) BETWEEN 20 AND 40),
  entitlement_refresh_after TEXT NOT NULL CHECK (length(entitlement_refresh_after) BETWEEN 20 AND 40),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  connected_at TEXT NOT NULL CHECK (length(connected_at) BETWEEN 20 AND 40),
  FOREIGN KEY (id) REFERENCES model_connection(id) ON DELETE CASCADE,
  UNIQUE (owner_user_id, provider),
  CHECK ((status = 'connected' AND credential_envelope_json IS NOT NULL) OR (status = 'needs-reauthorization' AND credential_envelope_json IS NULL))
);
INSERT INTO personal_model_subscription_connection
SELECT * FROM model_subscription_connection_0051;
DROP TABLE model_subscription_connection_0051;
CREATE INDEX personal_model_subscription_refresh_idx ON personal_model_subscription_connection(status, entitlement_refresh_after, owner_user_id);

DROP INDEX projects_projectless_owner_unique_idx;

CREATE UNIQUE INDEX projects_projectless_personal_unique_idx
  ON projects(owner_user_id)
  WHERE workspace_id IS NULL AND name = 'No Project';

CREATE UNIQUE INDEX projects_projectless_workspace_unique_idx
  ON projects(owner_user_id, workspace_id)
  WHERE workspace_id IS NOT NULL AND name = 'No Project';

-- Model routing v2 (Phase 1: domain + storage).
--
-- Drops the legacy routing tables (model_connection, model_routing_policy,
-- model_credential) and recreates them for the canonical provider/model
-- connection model. Local data, including configured connections, is
-- discarded per the locked v2 decision.
--
-- `personal_model_subscription_connection` and its subscription projection
-- are rebuilt around the parent-table reset so its encrypted credentials and
-- entitlement state survive with foreign key enforcement enabled.
--
-- `usage_event.model_route_version` is RETAINED: the usage observability
-- columns still describe model-route attribution, so Phase 1 writes the
-- literal version 2 plus selection-derived attribution until Phase 4 wires
-- ResolvedSubmissionModel through the usage writers.
--
-- `threads.model_route_snapshot` is dropped in favour of `model_selection`
-- (the stored ThreadModelSelection; resolution happens per submission).

CREATE TABLE model_subscription_connection_0052 AS
SELECT subscription.*, connection.name AS projection_name,
  connection.enabled AS projection_enabled,
  connection.priority AS projection_priority
FROM personal_model_subscription_connection AS subscription
JOIN model_connection AS connection ON connection.id = subscription.id;
DROP TABLE personal_model_subscription_connection;

DROP TABLE IF EXISTS model_connection;
DROP TABLE IF EXISTS model_routing_policy;
DROP TABLE IF EXISTS model_credential;

CREATE TABLE model_credential (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  target_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  envelope_version INTEGER NOT NULL CHECK (envelope_version = 1),
  key_version INTEGER NOT NULL CHECK (key_version >= 1),
  value_nonce TEXT NOT NULL CHECK (length(value_nonce) = 16),
  ciphertext TEXT NOT NULL CHECK (length(ciphertext) BETWEEN 24 AND 65536),
  wrapped_key_nonce TEXT NOT NULL CHECK (length(wrapped_key_nonce) = 16),
  wrapped_key TEXT NOT NULL CHECK (length(wrapped_key) = 64),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX model_credential_target_idx
  ON model_credential (scope, target_id, id);

CREATE TABLE model_connection (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  target_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind TEXT NOT NULL CHECK (kind IN ('subscription', 'provider', 'custom', 'deployment')),
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 128),
  base_url TEXT CHECK (base_url IS NULL OR length(base_url) BETWEEN 1 AND 2048),
  format TEXT CHECK (format IS NULL OR format IN ('openai-completions', 'openai-responses', 'anthropic-messages')),
  fields TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(fields)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 0,
  health_state TEXT NOT NULL DEFAULT 'untested' CHECK (health_state IN ('untested', 'healthy', 'unhealthy')),
  health_code TEXT NOT NULL DEFAULT 'NOT_TESTED' CHECK (length(health_code) BETWEEN 1 AND 64),
  health_checked_at TEXT,
  model_credential_id TEXT REFERENCES model_credential(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (scope, target_id, name),
  CHECK (kind <> 'custom' OR (base_url IS NOT NULL AND format IS NOT NULL)),
  CHECK (kind = 'custom' OR format IS NULL),
  CHECK (kind IN ('custom', 'provider') OR base_url IS NULL),
  CHECK (kind <> 'deployment' OR model_credential_id IS NULL)
);

CREATE INDEX model_connection_target_idx
  ON model_connection (scope, target_id, priority, id);

INSERT INTO model_connection (
  id, scope, target_id, name, kind, provider_id, fields, enabled, priority,
  health_state, health_code, health_checked_at, created_at, updated_at
)
SELECT id, 'personal', owner_user_id, projection_name, 'subscription', provider,
  '{}', projection_enabled, projection_priority,
  CASE WHEN status = 'connected' AND json_array_length(entitlement_model_ids_json) > 0
    THEN 'healthy' ELSE 'unhealthy' END ,
  CASE WHEN status = 'needs-reauthorization' THEN 'NEEDS_REAUTHORIZATION'
    WHEN json_array_length(entitlement_model_ids_json) = 0 THEN 'NO_ACTIVE_MODELS'
    ELSE 'CONNECTED' END ,
  updated_at, created_at, updated_at
FROM model_subscription_connection_0052;

CREATE TABLE personal_model_subscription_connection (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  owner_user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE CHECK (length(owner_user_id) BETWEEN 1 AND 128),
  provider TEXT NOT NULL CHECK (provider = 'github-copilot'),
  provider_account_id TEXT NOT NULL CHECK (length(provider_account_id) BETWEEN 1 AND 256),
  provider_account_login TEXT NOT NULL CHECK (length(provider_account_login) BETWEEN 1 AND 256),
  status TEXT NOT NULL CHECK (status IN ('connected', 'needs-reauthorization')),
  credential_envelope_json TEXT CHECK (credential_envelope_json IS NULL OR (json_valid(credential_envelope_json) AND length(credential_envelope_json) <= 16384)),
  credential_revision INTEGER NOT NULL DEFAULT 1 CHECK (credential_revision >= 1),
  entitlement_model_ids_json TEXT NOT NULL CHECK (json_valid(entitlement_model_ids_json) AND json_type(entitlement_model_ids_json) = 'array' AND json_array_length(entitlement_model_ids_json) <= 100),
  entitlement_catalog_revision TEXT NOT NULL CHECK (length(entitlement_catalog_revision) BETWEEN 1 AND 128),
  entitlement_observed_at TEXT NOT NULL CHECK (length(entitlement_observed_at) BETWEEN 20 AND 40),
  entitlement_refresh_after TEXT NOT NULL CHECK (length(entitlement_refresh_after) BETWEEN 20 AND 40),
  created_at TEXT NOT NULL CHECK (length(created_at) BETWEEN 20 AND 40),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  connected_at TEXT NOT NULL CHECK (length(connected_at) BETWEEN 20 AND 40),
  FOREIGN KEY (id) REFERENCES model_connection(id) ON DELETE CASCADE,
  UNIQUE (owner_user_id, provider),
  CHECK ((status = 'connected' AND credential_envelope_json IS NOT NULL) OR (status = 'needs-reauthorization' AND credential_envelope_json IS NULL))
);
INSERT INTO personal_model_subscription_connection (
  id, owner_user_id, provider, provider_account_id, provider_account_login,
  status, credential_envelope_json, credential_revision,
  entitlement_model_ids_json, entitlement_catalog_revision,
  entitlement_observed_at, entitlement_refresh_after, created_at, updated_at,
  connected_at
)
SELECT id, owner_user_id, provider, provider_account_id, provider_account_login,
  status, credential_envelope_json, credential_revision,
  entitlement_model_ids_json, entitlement_catalog_revision,
  entitlement_observed_at, entitlement_refresh_after, created_at, updated_at,
  connected_at
FROM model_subscription_connection_0052;
DROP TABLE model_subscription_connection_0052;
CREATE INDEX personal_model_subscription_refresh_idx ON personal_model_subscription_connection(status, entitlement_refresh_after, owner_user_id);

-- Declared served models for custom connections; empty means the connection
-- serves its provider's whole catalog.
CREATE TABLE model_connection_model (
  connection_id TEXT NOT NULL REFERENCES model_connection(id) ON DELETE CASCADE,
  canonical TEXT NOT NULL CHECK (length(canonical) BETWEEN 3 AND 385),
  upstream TEXT CHECK (upstream IS NULL OR length(upstream) BETWEEN 1 AND 256),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (connection_id, canonical)
);

CREATE INDEX model_connection_model_canonical_idx
  ON model_connection_model (canonical, connection_id);

CREATE TABLE model_connection_header (
  connection_id TEXT NOT NULL REFERENCES model_connection(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  value TEXT NOT NULL CHECK (length(value) <= 4096),
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (connection_id, name)
);

-- One row per (user, profile, mode) override; an absent row resolves from
-- the shipped default profile.
CREATE TABLE mode_profile_override (
  user_id TEXT NOT NULL,
  profile_id TEXT NOT NULL CHECK (profile_id = 'default'),
  mode TEXT NOT NULL CHECK (mode IN ('low', 'medium', 'high', 'ultra')),
  config TEXT NOT NULL CHECK (json_valid(config)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, profile_id, mode)
);

ALTER TABLE threads DROP COLUMN model_route_snapshot;
ALTER TABLE threads ADD COLUMN model_selection TEXT NOT NULL
  DEFAULT '{"kind":"mode","profileId":"default","mode":"medium"}'
  CHECK (json_valid(model_selection));

CREATE UNIQUE INDEX IF NOT EXISTS projects_personal_name_unique_idx
  ON projects(owner_user_id, name COLLATE NOCASE)
  WHERE workspace_id IS NULL AND name != 'No Project';

CREATE UNIQUE INDEX IF NOT EXISTS projects_workspace_name_unique_idx
  ON projects(workspace_id, name COLLATE NOCASE)
  WHERE workspace_id IS NOT NULL AND name != 'No Project';

ALTER TABLE personal_account
  ADD COLUMN appearance TEXT NOT NULL DEFAULT 'dark'
  CHECK (appearance IN ('system', 'light', 'dark'));

ALTER TABLE personal_account
  ADD COLUMN palette TEXT NOT NULL DEFAULT 'daydream'
  CHECK (palette IN ('daydream', 'deadpan'));

ALTER TABLE personal_account
  ADD COLUMN terminal_theme TEXT NOT NULL DEFAULT 'github'
  CHECK (terminal_theme IN ('github', 'gruvbox'));

CREATE TABLE personal_account_next (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
  display_name TEXT NOT NULL
    CHECK (display_name = trim(display_name))
    CHECK (length(display_name) BETWEEN 1 AND 128),
  username TEXT NOT NULL COLLATE NOCASE
    CHECK (username = lower(username))
    CHECK (length(username) BETWEEN 3 AND 32)
    CHECK (username NOT GLOB '*[^a-z0-9-]*')
    CHECK (substr(username, 1, 1) GLOB '[a-z0-9]')
    CHECK (substr(username, -1, 1) GLOB '[a-z0-9]'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  appearance TEXT NOT NULL DEFAULT 'dark'
    CHECK (appearance IN ('system', 'light', 'dark')),
  palette TEXT NOT NULL DEFAULT 'daydream'
    CHECK (palette IN ('daydream', 'deadpan')),
  terminal_theme TEXT NOT NULL DEFAULT 'github'
    CHECK (terminal_theme IN (
      'github',
      'gruvbox',
      'catppuccin',
      'solarized',
      'tokyo-night',
      'rose-pine',
      'one-half',
      'material'
    ))
);

INSERT INTO personal_account_next (
  user_id,
  display_name,
  username,
  created_at,
  updated_at,
  appearance,
  palette,
  terminal_theme
)
SELECT
  user_id,
  display_name,
  username,
  created_at,
  updated_at,
  appearance,
  palette,
  terminal_theme
FROM personal_account;

DROP TRIGGER personal_account_after_user_insert;
DROP TABLE personal_account;
ALTER TABLE personal_account_next RENAME TO personal_account;

CREATE UNIQUE INDEX personal_account_username_uidx
  ON personal_account (username COLLATE NOCASE);

CREATE TRIGGER personal_account_after_user_insert
AFTER INSERT ON "user"
BEGIN
  INSERT INTO personal_account (
    user_id,
    display_name,
    username,
    created_at,
    updated_at
  ) VALUES (
    NEW.id,
    CASE
      WHEN length(trim(NEW.name)) = 0 THEN 'User'
      ELSE substr(trim(NEW.name), 1, 128)
    END ,
    'user-' || lower(hex(randomblob(12))),
    datetime('now'),
    datetime('now')
  );
END;

ALTER TABLE threads
  ADD COLUMN runner_profile_id TEXT
    CHECK (runner_profile_id IS NULL OR length(runner_profile_id) BETWEEN 1 AND 64);

DROP VIEW project_read_model;
ALTER TABLE source_admission_assertion RENAME TO source_admission_assertion_0055;
DROP INDEX project_source_authority_grant_idx;
DROP INDEX project_source_authority_owner_idx;
ALTER TABLE project_source_authority RENAME TO project_source_authority_0055;
ALTER TABLE project_repository RENAME TO project_repository_0055;

CREATE TABLE project_repository (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'bitbucket', 'gitlab', 'forgejo', 'git')),
  binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
  full_name TEXT NOT NULL CHECK (length(full_name) BETWEEN 3 AND 512),
  web_url TEXT NOT NULL CHECK (length(web_url) BETWEEN 1 AND 512),
  clone_url TEXT CHECK (clone_url IS NULL OR length(clone_url) BETWEEN 1 AND 512),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(project_id, binding_revision),
  CHECK (provider != 'github' OR clone_url IS NULL OR (
    clone_url LIKE 'https://github.com/%/%.git'
    AND instr(substr(clone_url, 9), '@') = 0
    AND instr(clone_url, '?') = 0 AND instr(clone_url, '#') = 0
  )),
  CHECK (provider != 'bitbucket' OR (
    web_url LIKE 'https://bitbucket.org/%/%'
    AND web_url NOT LIKE 'https://bitbucket.org/%/%/%'
    AND instr(substr(web_url, 9), '@') = 0
    AND instr(web_url, '?') = 0 AND instr(web_url, '#') = 0
    AND (clone_url IS NULL OR (
      clone_url LIKE 'https://bitbucket.org/%/%.git'
      AND instr(substr(clone_url, 9), '@') = 0
      AND instr(clone_url, '?') = 0 AND instr(clone_url, '#') = 0
    ))
  )),
  CHECK (provider != 'git' OR (
    substr(web_url, 1, 8) = 'https://' AND instr(substr(web_url, 9), '/') > 1
    AND substr(web_url, 8 + instr(substr(web_url, 9), '/') + 1) != ''
    AND instr(web_url, '@') = 0 AND instr(web_url, '?') = 0 AND instr(web_url, '#') = 0
    AND clone_url IS NOT NULL
    AND substr(clone_url, 1, 8) = 'https://' AND instr(substr(clone_url, 9), '/') > 1
    AND substr(clone_url, 8 + instr(substr(clone_url, 9), '/') + 1) != ''
    AND instr(clone_url, '@') = 0 AND instr(clone_url, '?') = 0 AND instr(clone_url, '#') = 0
  ))
);
INSERT INTO project_repository SELECT * FROM project_repository_0055;

CREATE TABLE project_source_authority (
  project_id TEXT PRIMARY KEY REFERENCES project_repository(project_id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('github', 'bitbucket', 'gitlab', 'forgejo')),
  owner_scope TEXT NOT NULL CHECK (owner_scope IN ('personal', 'workspace')),
  owner_id TEXT NOT NULL,
  owner_grant_id TEXT,
  installation_id TEXT,
  provider_workspace_id TEXT,
  provider_repository_id TEXT NOT NULL,
  binding_revision INTEGER NOT NULL CHECK (binding_revision >= 1),
  provenance TEXT NOT NULL CHECK (provenance IN ('live-grant', 'legacy')),
  default_branch TEXT,
  source_health TEXT NOT NULL CHECK (source_health IN ('available', 'action-required', 'unavailable', 'unknown')),
  source_health_reason TEXT,
  authorization_epoch INTEGER NOT NULL CHECK (authorization_epoch >= 0),
  installation_epoch INTEGER NOT NULL CHECK (installation_epoch >= 0),
  policy_revision INTEGER NOT NULL CHECK (policy_revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(project_id, binding_revision) REFERENCES project_repository(project_id, binding_revision) ON DELETE CASCADE,
  CHECK (
    (provenance = 'live-grant' AND provider = 'github'
      AND owner_grant_id IS NOT NULL AND installation_id IS NOT NULL
      AND provider_workspace_id IS NULL
      AND default_branch IS NOT NULL AND source_health = 'available')
    OR (provenance = 'live-grant' AND provider = 'bitbucket'
      AND owner_scope = 'personal' AND owner_grant_id IS NOT NULL
      AND installation_id IS NULL AND provider_workspace_id IS NOT NULL
      AND ((length(provider_workspace_id) = 36 AND provider_workspace_id GLOB '????????-????-????-????-????????????')
        OR (length(provider_workspace_id) = 38 AND provider_workspace_id GLOB '{????????-????-????-????-????????????}'))
      AND installation_epoch = 0 AND policy_revision = 0 AND default_branch IS NOT NULL
      AND source_health = 'available')
    OR (provenance = 'legacy' AND source_health = 'action-required')
  )
);
INSERT INTO project_source_authority SELECT * FROM project_source_authority_0055;
CREATE INDEX project_source_authority_grant_idx ON project_source_authority(owner_grant_id, installation_id, provider_repository_id);
CREATE INDEX project_source_authority_owner_idx ON project_source_authority(owner_scope, owner_id, source_health, project_id);
CREATE TABLE source_admission_assertion (project_id TEXT NOT NULL UNIQUE REFERENCES project_source_authority(project_id) ON DELETE CASCADE);
INSERT INTO source_admission_assertion SELECT * FROM source_admission_assertion_0055;
DROP TABLE source_admission_assertion_0055;
DROP TABLE project_source_authority_0055;
DROP TABLE project_repository_0055;

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
  projects.public_code_enabled, projects.created_at, projects.updated_at
FROM projects LEFT JOIN project_repository ON project_repository.project_id = projects.id;

CREATE TRIGGER project_source_authority_grant_insert BEFORE INSERT ON project_source_authority
WHEN NEW.provenance = 'live-grant' AND NOT (
  (NEW.provider = 'github' AND EXISTS (SELECT 1 FROM github_owner_grant WHERE id = NEW.owner_grant_id AND installation_id = NEW.installation_id)) OR
  (NEW.provider = 'bitbucket' AND EXISTS (SELECT 1 FROM bitbucket_connection WHERE id = NEW.owner_grant_id AND user_id = NEW.owner_id))
) BEGIN SELECT RAISE(ABORT, 'project source authority grant is invalid'); END;
CREATE TRIGGER project_source_authority_grant_update BEFORE UPDATE ON project_source_authority
WHEN NEW.provenance = 'live-grant' AND NOT (
  (NEW.provider = 'github' AND EXISTS (SELECT 1 FROM github_owner_grant WHERE id = NEW.owner_grant_id AND installation_id = NEW.installation_id)) OR
  (NEW.provider = 'bitbucket' AND EXISTS (SELECT 1 FROM bitbucket_connection WHERE id = NEW.owner_grant_id AND user_id = NEW.owner_id))
) BEGIN SELECT RAISE(ABORT, 'project source authority grant is invalid'); END;

DROP TRIGGER source_control_operation_intent_immutable;
DROP TRIGGER source_control_operation_transition;
DROP TRIGGER source_control_operation_terminal_immutable;
DROP TRIGGER source_control_operation_no_delete;
DROP INDEX source_control_operation_thread_time_idx;
DROP INDEX source_control_operation_reconcile_idx;
ALTER TABLE source_control_operation RENAME TO source_control_operation_0055;
ALTER TABLE thread_source_finalization_assertion RENAME TO thread_source_finalization_assertion_0055;
ALTER TABLE thread_source_intent_assertion RENAME TO thread_source_intent_assertion_0055;
DROP TRIGGER thread_source_authority_grant_insert;
DROP TRIGGER thread_source_authority_immutable_update;
DROP TRIGGER thread_source_authority_immutable_delete;
DROP TRIGGER thread_source_snapshot_immutable_update;
DROP TRIGGER thread_source_snapshot_immutable_delete;
DROP TRIGGER thread_source_intent_immutable_update;
DROP TRIGGER thread_source_intent_finalized_delete;
DROP INDEX thread_source_snapshot_project_idx;
DROP INDEX thread_source_authority_grant_idx;
DROP INDEX thread_source_intent_project_idx;
ALTER TABLE thread_source_authority RENAME TO thread_source_authority_0055;
ALTER TABLE thread_source_snapshot RENAME TO thread_source_snapshot_0055;
ALTER TABLE thread_source_intent RENAME TO thread_source_intent_0055;

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
INSERT INTO thread_source_snapshot SELECT * FROM thread_source_snapshot_0055;

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
INSERT INTO thread_source_authority SELECT * FROM thread_source_authority_0055;

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
INSERT INTO thread_source_intent SELECT * FROM thread_source_intent_0055;

CREATE TRIGGER thread_source_authority_grant_insert BEFORE INSERT ON thread_source_authority
WHEN NOT EXISTS (
  SELECT 1 FROM thread_source_snapshot AS snapshot WHERE snapshot.thread_id = NEW.thread_id AND (
    (snapshot.provider = 'github' AND NEW.provider_workspace_id IS NULL AND EXISTS (
      SELECT 1 FROM github_owner_grant WHERE id = NEW.owner_grant_id AND installation_id = NEW.installation_id)) OR
    (snapshot.provider = 'bitbucket' AND NEW.installation_id IS NULL AND EXISTS (
      SELECT 1 FROM bitbucket_connection WHERE id = NEW.owner_grant_id))
  )
) BEGIN SELECT RAISE(ABORT, 'thread source authority grant is invalid'); END;
CREATE INDEX thread_source_snapshot_project_idx ON thread_source_snapshot(project_id, binding_revision, thread_id);
CREATE INDEX thread_source_authority_grant_idx ON thread_source_authority(owner_grant_id, installation_id, provider_repository_id);
CREATE INDEX thread_source_intent_project_idx ON thread_source_intent(project_id, binding_revision, thread_id);
CREATE TABLE thread_source_finalization_assertion (thread_id TEXT NOT NULL UNIQUE REFERENCES thread_source_snapshot(thread_id) ON DELETE CASCADE);
CREATE TABLE thread_source_intent_assertion (thread_id TEXT NOT NULL UNIQUE REFERENCES thread_source_intent(thread_id) ON DELETE CASCADE);
INSERT INTO thread_source_finalization_assertion SELECT * FROM thread_source_finalization_assertion_0055;
INSERT INTO thread_source_intent_assertion SELECT * FROM thread_source_intent_assertion_0055;
CREATE TRIGGER thread_source_snapshot_immutable_update BEFORE UPDATE ON thread_source_snapshot BEGIN SELECT RAISE(ABORT, 'thread source snapshots are immutable'); END;
CREATE TRIGGER thread_source_snapshot_immutable_delete BEFORE DELETE ON thread_source_snapshot WHEN EXISTS (SELECT 1 FROM threads WHERE id = OLD.thread_id) BEGIN SELECT RAISE(ABORT, 'thread source snapshots are immutable'); END;
CREATE TRIGGER thread_source_authority_immutable_update BEFORE UPDATE ON thread_source_authority BEGIN SELECT RAISE(ABORT, 'thread source authority is immutable'); END;
CREATE TRIGGER thread_source_authority_immutable_delete BEFORE DELETE ON thread_source_authority WHEN EXISTS (SELECT 1 FROM threads WHERE id = OLD.thread_id) BEGIN SELECT RAISE(ABORT, 'thread source authority is immutable'); END;
CREATE TRIGGER thread_source_intent_immutable_update BEFORE UPDATE ON thread_source_intent BEGIN SELECT RAISE(ABORT, 'thread source intents are immutable'); END;
CREATE TRIGGER thread_source_intent_finalized_delete BEFORE DELETE ON thread_source_intent
WHEN EXISTS (SELECT 1 FROM threads WHERE id = OLD.thread_id) AND NOT EXISTS (
  SELECT 1 FROM thread_source_snapshot AS snapshot WHERE snapshot.thread_id = OLD.thread_id
    AND snapshot.project_id = OLD.project_id AND snapshot.binding_revision = OLD.binding_revision
    AND snapshot.provider = OLD.provider AND snapshot.repository_full_name = OLD.repository_full_name
    AND snapshot.clone_url = OLD.clone_url
) BEGIN SELECT RAISE(ABORT, 'thread source intents may only be deleted after finalization'); END;

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
INSERT INTO source_control_operation SELECT * FROM source_control_operation_0055;
DROP TABLE source_control_operation_0055;
DROP TABLE thread_source_finalization_assertion_0055;
DROP TABLE thread_source_intent_assertion_0055;
DROP TABLE thread_source_authority_0055;
DROP TABLE thread_source_snapshot_0055;
DROP TABLE thread_source_intent_0055;
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
