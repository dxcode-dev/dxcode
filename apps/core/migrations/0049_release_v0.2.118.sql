-- Richer plugins P0 (wiki/plugin-platform-direction.md, "Plugin icons" and
-- "Archived Threads").
--
-- plugin_icon: every icon file a plugin version carries (its icon set and
-- its item icons), keyed by the sha256 of its bytes. The bytes never change
-- for a hash, so GET /v1/plugins/icons/:sha256 is cached for a year and a
-- message author tag keeps the icon of the version that posted it. Rows are
-- shared by every install that carries the same file.
CREATE TABLE plugin_icon (
  hash TEXT PRIMARY KEY CHECK (length(hash) = 64),
  media_type TEXT NOT NULL CHECK (media_type IN ('image/png', 'image/svg+xml')),
  -- base64, at most 64 KB before encoding
  data TEXT NOT NULL CHECK (length(data) BETWEEN 1 AND 87384),
  created_at TEXT NOT NULL
);

-- plugin_pane_snapshot: the last state a plugin saved for one of its panes
-- with ctx.panes.get(id).snapshot(state). An archived Thread whose plugin
-- says archivedThreads "show" draws the pane read-only from it.
CREATE TABLE plugin_pane_snapshot (
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  plugin_name TEXT NOT NULL CHECK (length(plugin_name) BETWEEN 1 AND 96),
  pane_id TEXT NOT NULL CHECK (length(pane_id) BETWEEN 1 AND 48),
  plugin_id TEXT NOT NULL REFERENCES trusted_plugin (id) ON DELETE CASCADE,
  state_json TEXT NOT NULL
    CHECK (length(state_json) <= 65536)
    CHECK (json_valid(state_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, plugin_name, pane_id)
);

-- P5: a plugin Thread type, `<plugin name>/<type id>`, set only when the
-- Thread is created. The plugin's view draws the Thread's main area; a Thread
-- whose type is no longer available opens as a plain chat with a notice.
ALTER TABLE threads ADD COLUMN plugin_thread_type TEXT;

-- What plugin hosts beyond the Worker cost (decision D4 of the richer
-- plugins plan): Durable Object time, container time, and Orbs kept awake by
-- plugins, charged to the workspace that installed the plugin. One row per
-- metered span: the container host writes one per call, the Durable Object
-- host one per install about every 15 minutes. The Plugins page sums a
-- plugin's rows into its cost line.
CREATE TABLE plugin_host_usage (
  id TEXT NOT NULL PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  -- trusted_plugin.id of the install.
  plugin_id TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 1 AND 128),
  plugin_name TEXT NOT NULL CHECK (length(plugin_name) BETWEEN 1 AND 128),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace', 'repository')),
  -- The installer's workspace, which pays.
  workspace_id TEXT,
  -- Who the call ran for; the installer for host-initiated work.
  owner_user_id TEXT NOT NULL,
  host TEXT NOT NULL CHECK (host IN ('worker', 'durable', 'orb', 'container')),
  -- The container instance type, such as `basic`; NULL for other hosts.
  instance TEXT CHECK (instance IS NULL OR length(instance) BETWEEN 1 AND 32),
  -- Wall time the host was billed for in this span.
  units_ms INTEGER NOT NULL CHECK (units_ms >= 0),
  requests INTEGER NOT NULL DEFAULT 0 CHECK (requests >= 0),
  -- SQL and blob bytes held at the end of the span (Durable Object host).
  storage_bytes INTEGER NOT NULL DEFAULT 0 CHECK (storage_bytes >= 0),
  -- Estimated list price in millionths of a US dollar.
  cost_microusd INTEGER NOT NULL CHECK (cost_microusd >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'error', 'blocked')),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL CHECK (period_end >= period_start),
  expires_at TEXT NOT NULL CHECK (expires_at > period_end)
);

CREATE INDEX plugin_host_usage_workspace_time_idx
  ON plugin_host_usage (workspace_id, period_end DESC);

CREATE INDEX plugin_host_usage_plugin_time_idx
  ON plugin_host_usage (plugin_id, period_end DESC);

CREATE INDEX plugin_host_usage_expiry_idx
  ON plugin_host_usage (expires_at);

CREATE TRIGGER plugin_host_usage_immutable_update
BEFORE UPDATE ON plugin_host_usage
BEGIN
  SELECT RAISE(ABORT, 'plugin host usage rows are immutable');
END;

-- Plugin trust tiers (rich plugins P1, wiki/plugin-platform-direction.md).
-- A workspace admin caps the highest tier any plugin gets in the workspace,
-- lists the projects whose repository plugins are trusted
-- (workspace-trusted instead of sandboxed), and lists the signing key
-- fingerprints that make a workspace install `verified`. Thread resolution
-- reads all three with the installs it already loads.
ALTER TABLE workspace_policy ADD COLUMN plugin_tier_cap
  TEXT NOT NULL DEFAULT 'verified'
  CHECK (plugin_tier_cap IN
    ('sandboxed', 'personal-dev', 'workspace-trusted', 'verified'));

ALTER TABLE workspace_policy ADD COLUMN trusted_plugin_project_ids
  TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(trusted_plugin_project_ids)
    AND json_type(trusted_plugin_project_ids) = 'array'
    AND length(trusted_plugin_project_ids) <= 16384);

ALTER TABLE workspace_policy ADD COLUMN trusted_plugin_signers
  TEXT NOT NULL DEFAULT '[]'
  CHECK (json_valid(trusted_plugin_signers)
    AND json_type(trusted_plugin_signers) = 'array'
    AND length(trusted_plugin_signers) <= 8192);

-- Personal-dev hot reload. The owner turns it on for one of their personal
-- plugins on the Plugins page (a row here); only then does `dxd plugin dev`
-- in one of their Threads reload it, and only with a version that asks for
-- nothing new. thread_id and folder name the latest reload.
CREATE TABLE plugin_dev_link (
  plugin_id TEXT NOT NULL PRIMARY KEY
    REFERENCES trusted_plugin (id) ON DELETE CASCADE,
  enabled_at TEXT NOT NULL,
  thread_id TEXT CHECK (thread_id IS NULL OR length(thread_id) BETWEEN 1 AND 128),
  folder TEXT CHECK (folder IS NULL OR length(folder) BETWEEN 1 AND 512),
  reloads INTEGER NOT NULL DEFAULT 0 CHECK (reloads >= 0),
  reloaded_at TEXT
);

-- plugin_pane_snapshot's plugin_id cascades from trusted_plugin; without an
-- index every trusted_plugin delete scans the whole table.
CREATE INDEX IF NOT EXISTS plugin_pane_snapshot_plugin_idx
  ON plugin_pane_snapshot (plugin_id);

-- The plugin Durable Object host's objects (rich plugins P3), one row per
-- object the first time it is used: per install, or per install and Thread.
-- dx purges an object's storage and its R2 blobs when its install is removed
-- for good or its Thread is deleted (workspace deletion does both), and the
-- minute cron retries any purge that did not finish.
CREATE TABLE plugin_durable_object (
  -- The object's name: `<install id>` or `<install id>/<thread id>`.
  name TEXT NOT NULL PRIMARY KEY CHECK (length(name) BETWEEN 1 AND 256),
  install_id TEXT NOT NULL CHECK (length(install_id) BETWEEN 1 AND 128),
  thread_id TEXT CHECK (thread_id IS NULL OR length(thread_id) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL,
  purged_at TEXT
);

CREATE INDEX plugin_durable_object_install_idx
  ON plugin_durable_object (install_id) WHERE purged_at IS NULL;

CREATE INDEX plugin_durable_object_thread_idx
  ON plugin_durable_object (thread_id) WHERE purged_at IS NULL;
