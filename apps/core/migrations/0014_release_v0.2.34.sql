-- Orb provider connections (tasks/orb-provider-connections.md): people and
-- workspaces connect their own account for any Orb provider, and no
-- deployment provider is required.
--
-- 1. orb_connection holds one connection per scope, target, and
--    provider. Its credentials are one JSON object in the shared
--    configuration envelope, bound to the same additional data as Orb keys
--    in plugin_setting (plugin 'execution'). A row copied from there still
--    decrypts, to the bare E2B API key it always held. The row also records
--    the preparation dx runs in that account: status, the recipe it ran
--    for, the provider account, progress, provider state (E2B's template
--    builds), and the error.
-- 2. Every Orb key and its template build state are copied across.
--    plugin_setting rows for 'execution' and execution_account_template are
--    no longer read; they stay, unchanged, so an earlier Core still finds
--    them.
-- 3. A person's or workspace's account may pin a Thread for any provider,
--    not only E2B. The pin's provider_template is the per-size target the
--    connection prepared (E2B's template, or a Cloudflare Orb Worker URL).
--
-- Every change adds a table or replaces a trigger; no row is rewritten.

CREATE TABLE orb_connection (
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
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
  -- When these credentials were saved; saving again restarts preparation.
  configured_at TEXT NOT NULL CHECK (length(configured_at) BETWEEN 20 AND 40),
  -- The provider recipe the preparation ran for; a new recipe prepares the
  -- account again. Null before the first step.
  recipe TEXT CHECK (recipe IS NULL OR length(recipe) BETWEEN 1 AND 64),
  -- The provider account the credentials belong to (E2B team, Cloudflare
  -- account), once known.
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
SELECT setting.scope,
       setting.target_id,
       setting.provider_id,
       setting.envelope_version,
       setting.key_version,
       setting.value_nonce,
       setting.ciphertext,
       setting.wrapped_key_nonce,
       setting.wrapped_key,
       setting.configured_at,
       CASE WHEN template.configured_at = setting.configured_at
            THEN template.recipe END ,
       CASE WHEN template.configured_at = setting.configured_at
            THEN template.account END ,
       CASE WHEN template.configured_at IS NOT setting.configured_at
              THEN 'preparing'
            WHEN template.state = 'building' THEN 'preparing'
            ELSE template.state END ,
       CASE WHEN template.configured_at = setting.configured_at
            THEN json_object('builds', json(template.builds_json))
            ELSE '{"builds":[]}' END ,
       NULL,
       CASE WHEN template.configured_at = setting.configured_at
             AND template.state = 'failed'
            THEN template.error END ,
       0,
       COALESCE(template.updated_at, setting.updated_at)
  FROM plugin_setting AS setting
  LEFT JOIN execution_account_template AS template
    ON template.scope = setting.scope
   AND template.target_id = setting.target_id
   AND template.provider_id = setting.provider_id
 WHERE setting.plugin_id = 'execution'
   AND setting.provider_id IS NOT NULL
   AND setting.configured_at IS NOT NULL;

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

-- A browser that accepted push notifications (0.2.33). The endpoint is the
-- address its push service issued, and it is also a secret: anyone holding it
-- can wake that browser, so it is never returned to a client. The keys are
-- the device's ECDH public key and authentication secret, which every push
-- message is encrypted to (RFC 8291); dx cannot read a delivered message
-- back out of them. One endpoint belongs to one person: a browser signed in
-- as someone else re-registers the same endpoint, which moves it.
CREATE TABLE push_subscription (
  id TEXT PRIMARY KEY CHECK (id GLOB 'psb_*' AND length(id) = 36),
  user_id TEXT NOT NULL,
  endpoint TEXT NOT NULL UNIQUE CHECK (length(endpoint) BETWEEN 1 AND 2048),
  p256dh TEXT NOT NULL CHECK (length(p256dh) BETWEEN 1 AND 128),
  auth TEXT NOT NULL CHECK (length(auth) BETWEEN 1 AND 64),
  label TEXT NOT NULL CHECK (length(label) <= 128),
  created_at TEXT NOT NULL,
  last_delivered_at TEXT
);

CREATE INDEX push_subscription_user_idx
  ON push_subscription (user_id, created_at DESC);

-- The five-minute sweep that tells a person their snoozed Thread is back
-- (notifications/snooze-wake.ts) looks for wake times that just passed. The
-- partial index keeps that a short scan over the few sleeping Threads
-- instead of a pass over every Thread.
CREATE INDEX threads_snooze_due_idx ON threads (snoozed_until)
  WHERE snoozed_until IS NOT NULL;
