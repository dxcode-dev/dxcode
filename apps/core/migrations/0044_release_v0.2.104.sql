-- Changes an agent proposes to a person's settings, waiting for a person's
-- review (plugin plan M5, agent skill management). The agent's
-- `manage_skills` tool writes a pending row; nothing else changes until
-- someone who could save the change themselves approves it on the Skills
-- settings page, which then saves it through the ordinary skill service.
--
-- kind names what the proposal changes. Only 'skill' exists today; agent
-- plugin management adds 'plugin' with its own payload.
--
-- payload_json holds the exact import bundle the agent proposed, and
-- integrity that bundle's reviewed hash, so approval saves what the person
-- read. subject_id and current_version record the skill an update proposes a
-- new version of, as it was when proposed.
--
-- ask_artifact_id is the Thread artifact holding the owner's review ask;
-- deciding the proposal ticks it, which wakes the agent's Thread.
CREATE TABLE agent_proposal (
  id TEXT NOT NULL PRIMARY KEY
    CHECK (length(id) BETWEEN 5 AND 64 AND id GLOB 'apr_*'),
  kind TEXT NOT NULL CHECK (kind IN ('skill')),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 128),
  thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 128),
  proposed_by_user_id TEXT NOT NULL
    REFERENCES "user" (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  change TEXT NOT NULL CHECK (change IN ('new', 'update')),
  subject_id TEXT CHECK (subject_id IS NULL OR length(subject_id) <= 128),
  current_version INTEGER CHECK (current_version IS NULL OR current_version >= 1),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  payload_json TEXT NOT NULL
    CHECK (length(payload_json) <= 1000000)
    CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  integrity TEXT NOT NULL
    CHECK (length(integrity) = 64)
    CHECK (integrity NOT GLOB '*[^a-f0-9]*'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  ask_artifact_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by_user_id TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  result_subject_id TEXT,
  result_version INTEGER
);

CREATE INDEX agent_proposal_target_idx
  ON agent_proposal (kind, scope, target_id, status, created_at);

CREATE INDEX agent_proposal_thread_idx
  ON agent_proposal (thread_id, created_at);

-- dx plugin code (wiki/plugin-platform-direction.md, "Plugin code"). A
-- plugin's code runs in an isolated Dynamic Worker with no storage of its
-- own; dx keeps its key-value storage and its install-time settings here,
-- keyed by install (one trusted_plugin row per personal or workspace scope).

CREATE TABLE plugin_install_storage (
  plugin_id TEXT NOT NULL REFERENCES trusted_plugin (id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 256),
  value_json TEXT NOT NULL
    CHECK (length(value_json) <= 65536)
    CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
);

CREATE TABLE plugin_install_setting (
  plugin_id TEXT NOT NULL REFERENCES trusted_plugin (id) ON DELETE CASCADE,
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 64),
  value_json TEXT NOT NULL
    CHECK (length(value_json) <= 2048)
    CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL,
  updated_by_user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  PRIMARY KEY (plugin_id, key)
);

-- MCP Apps cards (apps/core/src/plugins/code/mcp-apps.ts): the `ui://` view
-- an MCP tool named in `_meta.ui.resourceUri`, read when a `code_exec` call
-- ran that tool, and shown in that call's tool row. A call's views form one
-- card set, under an id dx made (`mcpa_…`) and printed in the call's output;
-- tool call ids are not used, since providers may repeat them. One row per
-- view, in call order. The view's HTML and the call's input and result are what the card
-- hands its sandboxed frame; they never reach the model. Deleting a Thread
-- removes its rows.
CREATE TABLE mcp_app_view (
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  card_set_id TEXT NOT NULL CHECK (length(card_set_id) = 37),
  ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 7),
  server TEXT NOT NULL CHECK (length(server) BETWEEN 1 AND 256),
  tool TEXT NOT NULL CHECK (length(tool) BETWEEN 1 AND 256),
  resource_uri TEXT NOT NULL CHECK (length(resource_uri) BETWEEN 6 AND 2048),
  html TEXT NOT NULL CHECK (length(html) <= 524288),
  tool_input TEXT NOT NULL CHECK (json_valid(tool_input)),
  tool_result TEXT NOT NULL CHECK (json_valid(tool_result)),
  prefers_border INTEGER CHECK (prefers_border IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, card_set_id, ordinal)
) WITHOUT ROWID;

-- Workspace and personal installs of the same plugin never run together
-- (wiki/plugin-platform-direction.md, "Same plugin in a workspace and
-- personally"). By default a member's personal copy pauses while a workspace
-- they belong to installs the plugin. With this policy on, the member's own
-- copy runs instead of the workspace's, for that member only.
ALTER TABLE workspace_policy ADD COLUMN allow_personal_plugin_install_overrides
  INTEGER NOT NULL DEFAULT 0
  CHECK (allow_personal_plugin_install_overrides IN (0, 1));

-- Plugins a repository carries (wiki/plugin-platform-direction.md,
-- "Repository plugins"). Each submission of a Thread reads them from the
-- repository's committed `.agents/plugins/<name>/` and `.dx/plugins/<name>/`
-- folders in its Orb. Nothing is installed: dx keeps only what plugin code
-- needs between calls.

-- A repository plugin's JavaScript modules, by the plugin's integrity. The
-- Dynamic Worker that runs the code loads them from here and checks each
-- module's hash against the manifest the Thread resolved.
CREATE TABLE repository_plugin_file (
  bundle_integrity TEXT NOT NULL
    CHECK (length(bundle_integrity) = 64)
    CHECK (bundle_integrity NOT GLOB '*[^a-f0-9]*'),
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 256),
  content TEXT NOT NULL CHECK (length(content) <= 65536),
  integrity TEXT NOT NULL
    CHECK (length(integrity) = 64)
    CHECK (integrity NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  PRIMARY KEY (bundle_integrity, path)
);

-- Key-value storage of a repository plugin's code, shared by the project's
-- Threads, as plugin_install_storage is for an install. `plugin_id` is
-- `repository:<project id>:<plugin name>`; deleting the project deletes it.
CREATE TABLE repository_plugin_storage (
  plugin_id TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 1 AND 256),
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 256),
  value_json TEXT NOT NULL
    CHECK (length(value_json) <= 65536)
    CHECK (json_valid(value_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, key)
);

-- A workspace may turn repository plugins off for its projects.
ALTER TABLE workspace_policy ADD COLUMN allow_repository_plugins
  INTEGER NOT NULL DEFAULT 1
  CHECK (allow_repository_plugins IN (0, 1));

-- The remote MCP servers a Thread's repository plugins declared, as its
-- latest submission found them, with the tools listed then. dx calls a
-- repository server's tool only while its row is here and the tool's
-- contract still matches; each submission replaces the Thread's rows.
CREATE TABLE thread_repository_mcp_server (
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  server_id TEXT NOT NULL CHECK (length(server_id) BETWEEN 1 AND 64),
  plugin_name TEXT NOT NULL CHECK (length(plugin_name) BETWEEN 1 AND 64),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 128),
  endpoint TEXT NOT NULL CHECK (length(endpoint) BETWEEN 1 AND 2048),
  headers_json TEXT NOT NULL CHECK (json_valid(headers_json)),
  tools_json TEXT NOT NULL CHECK (json_valid(tools_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, server_id)
);

-- dx plugin UI in Threads (wiki/plugin-platform-direction.md, "Plugin UI").
-- A plugin's code asks a person something above the composer (confirm,
-- input, select) or shows a toast (notify); each is a row here that the
-- Thread page reads and answers. The plugin's call waits on its row until a
-- person answers or it expires. Quick actions are buttons a plugin keeps
-- above a Thread's composer.

CREATE TABLE plugin_ui_prompt (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL REFERENCES trusted_plugin (id) ON DELETE CASCADE,
  plugin_name TEXT NOT NULL CHECK (length(plugin_name) BETWEEN 1 AND 96),
  kind TEXT NOT NULL CHECK (kind IN ('confirm', 'input', 'select', 'notify')),
  spec_json TEXT NOT NULL
    CHECK (length(spec_json) <= 16384)
    CHECK (json_valid(spec_json)),
  -- An input only the Thread's owner may answer; its answer is cleared once
  -- the plugin reads it.
  owner_only INTEGER NOT NULL DEFAULT 0 CHECK (owner_only IN (0, 1)),
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'answered', 'expired', 'shown')),
  answer_json TEXT CHECK (answer_json IS NULL OR json_valid(answer_json)),
  answered_by_user_id TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  answered_at TEXT
);

CREATE INDEX plugin_ui_prompt_thread
  ON plugin_ui_prompt (thread_id, status, created_at);

CREATE TABLE plugin_quick_action (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL REFERENCES trusted_plugin (id) ON DELETE CASCADE,
  plugin_name TEXT NOT NULL CHECK (length(plugin_name) BETWEEN 1 AND 96),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 48),
  action TEXT NOT NULL
    CHECK (action IN ('send-message', 'open-url', 'copy', 'run-command')),
  args_json TEXT NOT NULL
    CHECK (length(args_json) <= 8192)
    CHECK (json_valid(args_json)),
  created_at TEXT NOT NULL
);

CREATE INDEX plugin_quick_action_thread
  ON plugin_quick_action (thread_id, created_at);

-- The legacy code plugins (their own manifest, run in one E2B sandbox per
-- call) are gone: plugin code runs in Dynamic Workers now
-- (wiki/plugin-platform-direction.md, "Plugin code"). Their rows are
-- retired as a removal would retire them, so their names are free for an
-- Agent Plugins import, and their webhook triggers are revoked instead of
-- showing as active while every delivery is refused.

UPDATE plugin_trigger
   SET status = 'revoked',
       revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE status != 'revoked'
   AND plugin_id IN (SELECT id FROM trusted_plugin WHERE kind = 'code');

UPDATE trusted_plugin
   SET enabled = 0,
       name = id,
       removed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE kind = 'code'
   AND removed_at IS NULL;

-- The local (stdio) MCP servers a Thread's repository plugins declared, as
-- its latest submission found them (wiki/plugin-platform-direction.md,
-- "Repository plugins"). dxd runs each from the plugin's committed files,
-- which Core keeps in R2 by digest. dx relays a request to one only while
-- its row is here, under the same key; each submission replaces the
-- Thread's rows. The key digests the plugin, the server's configuration, and
-- its files, so the row needs nothing else to authorize a request.
CREATE TABLE thread_repository_local_mcp_server (
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  server_key TEXT NOT NULL
    CHECK (length(server_key) = 64)
    CHECK (server_key NOT GLOB '*[^a-f0-9]*'),
  plugin_name TEXT NOT NULL CHECK (length(plugin_name) BETWEEN 1 AND 64),
  server_name TEXT NOT NULL CHECK (length(server_name) BETWEEN 1 AND 80),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (thread_id, server_key)
);

-- Agent plugin management (plugin plan M5): the `manage_skills` tool also
-- proposes installing or updating a plugin. A plugin proposal's payload_json
-- holds the GitHub source pinned to the reviewed commit and what the review
-- shows; integrity is that bundle's hash, so approval installs exactly what
-- the person read. subject_id is the installed plugin an update replaces.
--
-- SQLite cannot widen a CHECK in place, so the table is rebuilt with 'plugin'
-- allowed in kind, keeping every row. No table references it.
PRAGMA defer_foreign_keys = on;

CREATE TABLE agent_proposal_next (
  id TEXT NOT NULL PRIMARY KEY
    CHECK (length(id) BETWEEN 5 AND 64 AND id GLOB 'apr_*'),
  kind TEXT NOT NULL CHECK (kind IN ('skill', 'plugin')),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 128),
  thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 128),
  proposed_by_user_id TEXT NOT NULL
    REFERENCES "user" (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  change TEXT NOT NULL CHECK (change IN ('new', 'update')),
  subject_id TEXT CHECK (subject_id IS NULL OR length(subject_id) <= 128),
  current_version INTEGER CHECK (current_version IS NULL OR current_version >= 1),
  note TEXT NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  payload_json TEXT NOT NULL
    CHECK (length(payload_json) <= 1000000)
    CHECK (json_valid(payload_json) AND json_type(payload_json) = 'object'),
  integrity TEXT NOT NULL
    CHECK (length(integrity) = 64)
    CHECK (integrity NOT GLOB '*[^a-f0-9]*'),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  ask_artifact_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by_user_id TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  result_subject_id TEXT,
  result_version INTEGER
);

INSERT INTO agent_proposal_next SELECT * FROM agent_proposal;

DROP TABLE agent_proposal;

ALTER TABLE agent_proposal_next RENAME TO agent_proposal;

CREATE INDEX agent_proposal_target_idx
  ON agent_proposal (kind, scope, target_id, status, created_at);

CREATE INDEX agent_proposal_thread_idx
  ON agent_proposal (thread_id, created_at);

-- Share links for plugins (plugin plan M5). Anyone signed in to dx who holds
-- a link can review the shared install's active version and install their
-- own copy, which then updates from the same install. Only the token's
-- SHA-256 is kept. Revoking a link stops new installs and updates through it.
CREATE TABLE plugin_share_link (
  id TEXT NOT NULL PRIMARY KEY
    CHECK (length(id) BETWEEN 5 AND 64 AND id GLOB 'psl_*'),
  token_hash TEXT NOT NULL UNIQUE
    CHECK (length(token_hash) = 64)
    CHECK (token_hash NOT GLOB '*[^a-f0-9]*'),
  plugin_id TEXT NOT NULL REFERENCES trusted_plugin (id) ON DELETE CASCADE,
  created_by_user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX plugin_share_link_plugin_idx
  ON plugin_share_link (plugin_id, revoked_at);

-- dx plugin panes (wiki/plugin-platform-direction.md, "Plugin panes"). A
-- plugin's code posts messages to one of its panes, or asks open copies of
-- the Thread page to open it; each is a row here, as is each message a
-- pane's view sends the plugin ('call'), for its rate limit. Open panes read
-- the posts after the last one they showed, and a pane that opens later
-- reads the latest few. dx keeps the last 20 posts per pane and Thread plus
-- the last minute's, open requests for a day, and calls for a minute.
CREATE TABLE plugin_pane_event (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL REFERENCES trusted_plugin (id) ON DELETE CASCADE,
  -- The plugin's manifest name: pane tabs name it, so a new version or a
  -- reinstall keeps the pane's tab.
  plugin_name TEXT NOT NULL CHECK (length(plugin_name) BETWEEN 1 AND 96),
  pane_id TEXT NOT NULL CHECK (length(pane_id) BETWEEN 1 AND 48),
  kind TEXT NOT NULL CHECK (kind IN ('post', 'open', 'call')),
  message_json TEXT
    CHECK (message_json IS NULL OR length(message_json) <= 65536)
    CHECK (message_json IS NULL OR json_valid(message_json)),
  created_at TEXT NOT NULL
);

CREATE INDEX plugin_pane_event_pane
  ON plugin_pane_event (thread_id, plugin_name, pane_id, kind, seq);

-- Quick actions may open one of the plugin's panes.
CREATE TABLE plugin_quick_action_next (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  plugin_id TEXT NOT NULL REFERENCES trusted_plugin (id) ON DELETE CASCADE,
  plugin_name TEXT NOT NULL CHECK (length(plugin_name) BETWEEN 1 AND 96),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 48),
  action TEXT NOT NULL
    CHECK (action IN ('send-message', 'open-url', 'copy', 'run-command',
                      'open-pane')),
  args_json TEXT NOT NULL
    CHECK (length(args_json) <= 8192)
    CHECK (json_valid(args_json)),
  created_at TEXT NOT NULL
);

INSERT INTO plugin_quick_action_next
  SELECT id, thread_id, plugin_id, plugin_name, label, action, args_json,
         created_at
    FROM plugin_quick_action;

DROP TABLE plugin_quick_action;

ALTER TABLE plugin_quick_action_next RENAME TO plugin_quick_action;

CREATE INDEX plugin_quick_action_thread
  ON plugin_quick_action (thread_id, created_at);

-- Plugin catalogs: marketplace.json files a person or workspace admin added
-- from GitHub. A catalog only lists plugins; installing one goes through the
-- plugin bundle import, which records the catalog in the bundle's source when
-- the catalog's publisher proved the domain in the plugin's name.
-- catalog_json holds the entries and the publisher proofs read at add or
-- refresh time (apps/core/src/settings/plugins/catalogs/).

CREATE TABLE plugin_catalog (
  id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  target_id TEXT NOT NULL,
  name TEXT NOT NULL,
  repository TEXT NOT NULL,
  catalog_json TEXT NOT NULL,
  added_by_user_id TEXT NOT NULL,
  added_at TEXT NOT NULL,
  refreshed_at TEXT NOT NULL,
  UNIQUE (scope, target_id, name),
  UNIQUE (scope, target_id, repository)
);

-- Indexes for the plugin UI reads that filter by kind and time: recent pane
-- opens (every Thread page load), the pane rate limit, the open and call
-- prunes, and the plugin notice rate limit. Without them each of these scans
-- every row the Thread has in its table.
CREATE INDEX plugin_pane_event_kind_time
  ON plugin_pane_event (thread_id, kind, created_at);

CREATE INDEX plugin_ui_prompt_plugin_kind_time
  ON plugin_ui_prompt (thread_id, plugin_id, kind, created_at);

-- Plugin signatures (plugin plan M5): the signer of a plugin version, kept
-- when dx verified its plugin.sig at install or update. publisher is the
-- domain the plugin's name claims, when that domain listed the signer's key
-- then. A version's signature never changes, as the version never does.
CREATE TABLE plugin_version_signature (
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK (fingerprint LIKE 'SHA256:%'),
  public_key TEXT NOT NULL CHECK (public_key LIKE 'ssh-ed25519 %'),
  publisher TEXT CHECK (publisher IS NULL OR length(publisher) BETWEEN 3 AND 253),
  verified_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, version),
  FOREIGN KEY (plugin_id, version)
    REFERENCES trusted_plugin_version (plugin_id, version) ON DELETE CASCADE
);

-- manage_dx (wiki/runtime-architecture.md, "The agent manages dx settings"):
-- the agent's settings changes and secret requests wait above the composer
-- in the same rows plugin prompts use, so the Thread page reads both in one
-- query and the same answer route and wake path serve both.
--
-- - plugin_id is NULL for dx's own prompts.
-- - kind 'change' is a settings change the owner applies or cancels; its
--   plan_json holds the settings requests that apply it, run inside the
--   owner's own browser request when they click Apply, and is cleared then.
-- - kind 'secret' asks the owner for a secret value; the answer route stores
--   it straight in the chosen secret store and never writes it here.
-- - status 'applying' marks a change whose requests are running.
--
-- SQLite cannot widen a CHECK in place, so the table is rebuilt, keeping
-- every row. No table references it.
PRAGMA defer_foreign_keys = on;

CREATE TABLE plugin_ui_prompt_next (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  plugin_id TEXT REFERENCES trusted_plugin (id) ON DELETE CASCADE,
  plugin_name TEXT NOT NULL CHECK (length(plugin_name) BETWEEN 1 AND 96),
  kind TEXT NOT NULL
    CHECK (kind IN ('confirm', 'input', 'select', 'notify', 'change', 'secret')),
  spec_json TEXT NOT NULL
    CHECK (length(spec_json) <= 16384 OR kind = 'change')
    CHECK (length(spec_json) <= 600000)
    CHECK (json_valid(spec_json)),
  owner_only INTEGER NOT NULL DEFAULT 0 CHECK (owner_only IN (0, 1)),
  status TEXT NOT NULL
    CHECK (status IN ('pending', 'applying', 'answered', 'expired', 'shown')),
  answer_json TEXT CHECK (answer_json IS NULL OR json_valid(answer_json)),
  answered_by_user_id TEXT REFERENCES "user" (id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  answered_at TEXT,
  plan_json TEXT
    CHECK (plan_json IS NULL OR length(plan_json) <= 1000000)
    CHECK (plan_json IS NULL OR json_valid(plan_json)),
  CHECK (plugin_id IS NOT NULL OR kind IN ('change', 'secret'))
);

INSERT INTO plugin_ui_prompt_next
  (id, thread_id, plugin_id, plugin_name, kind, spec_json, owner_only, status,
   answer_json, answered_by_user_id, created_at, expires_at, answered_at)
SELECT id, thread_id, plugin_id, plugin_name, kind, spec_json, owner_only,
       status, answer_json, answered_by_user_id, created_at, expires_at,
       answered_at
  FROM plugin_ui_prompt;

DROP TABLE plugin_ui_prompt;

ALTER TABLE plugin_ui_prompt_next RENAME TO plugin_ui_prompt;

CREATE INDEX plugin_ui_prompt_thread
  ON plugin_ui_prompt (thread_id, status, created_at);

CREATE INDEX plugin_ui_prompt_plugin_kind_time
  ON plugin_ui_prompt (thread_id, plugin_id, kind, created_at);

-- Plugin audit: one row per capability a plugin's code used on someone's
-- behalf (wiki/plugin-platform-direction.md, "Plugin code"). Thread access
-- writes `thread.read`, `thread.messages`, `thread.post`, and
-- `thread.note`; other capabilities add their own actions.
--
-- - plugin_id names the install (trusted_plugin.id) or, for a repository
--   plugin, its Project-scoped id. It has no foreign key: the audit outlives
--   an uninstall.
-- - owner_user_id is who the call ran as: the Thread's or trigger's owner.
-- - thread_id is the Thread the call ran in, NULL for a webhook trigger.
-- - target is what the action reached, such as another Thread's id.
-- - outcome 'rejected' records a request dx refused: not granted, out of
--   reach, or invalid. detail_json says why, briefly; it never holds message
--   text.
-- - Rows are immutable. Readers list by plugin or by owner, newest first.
CREATE TABLE plugin_audit (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 128),
  plugin_id TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 1 AND 256),
  plugin_name TEXT NOT NULL CHECK (length(plugin_name) BETWEEN 1 AND 214),
  plugin_version TEXT NOT NULL CHECK (length(plugin_version) BETWEEN 1 AND 160),
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace', 'repository')),
  owner_user_id TEXT NOT NULL CHECK (length(owner_user_id) BETWEEN 1 AND 128),
  thread_id TEXT CHECK (thread_id IS NULL OR length(thread_id) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 96),
  target TEXT CHECK (target IS NULL OR length(target) BETWEEN 1 AND 256),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'rejected', 'failed')),
  detail_json TEXT
    CHECK (detail_json IS NULL OR (length(detail_json) <= 4096 AND json_valid(detail_json))),
  created_at TEXT NOT NULL
);

CREATE INDEX plugin_audit_plugin_idx
  ON plugin_audit (plugin_id, created_at DESC, id DESC);

CREATE INDEX plugin_audit_owner_idx
  ON plugin_audit (owner_user_id, created_at DESC, id DESC);

CREATE TRIGGER plugin_audit_no_update
BEFORE UPDATE ON plugin_audit
BEGIN
  SELECT RAISE(ABORT, 'plugin audit is immutable');
END;

-- Plugin agents (wiki/plugin-platform-direction.md, "Plugin agents"): one
-- row per Thread that runs as an agent a plugin's code defined, written
-- before the Thread is created, so its first submission already runs as the
-- agent.
--
-- - plugin_id is the install (trusted_plugin.id) that defined the agent. A
--   Thread whose plugin no longer runs for its owner refuses to start a turn
--   rather than run without the agent's instructions or tool limits.
-- - owner_user_id must be the Thread's owner; a row for another owner's
--   Thread is ignored.
-- - definition_json is the agent as dx validated it when the Thread started
--   (name, instructions, tools, model, reasoning effort, display), so later
--   versions of the plugin do not change a running Thread's agent.
-- - mode_key is the declared agent mode the Thread was started in, NULL for
--   a subagent run from plugin code (agent.run).
-- - plugin_display_name and the definition's display are what the Thread
--   shows, read with the Thread's detail, so showing it costs no manifest
--   read.
-- - parent_thread_id is the Thread that started it, NULL when a person did.
CREATE TABLE plugin_agent_thread (
  thread_id TEXT PRIMARY KEY CHECK (length(thread_id) BETWEEN 1 AND 128),
  owner_user_id TEXT NOT NULL CHECK (length(owner_user_id) BETWEEN 1 AND 128),
  plugin_id TEXT NOT NULL CHECK (length(plugin_id) BETWEEN 1 AND 256),
  plugin_name TEXT NOT NULL CHECK (length(plugin_name) BETWEEN 1 AND 214),
  plugin_display_name TEXT NOT NULL
    CHECK (length(plugin_display_name) BETWEEN 1 AND 96),
  plugin_version TEXT NOT NULL CHECK (length(plugin_version) BETWEEN 1 AND 160),
  agent_name TEXT NOT NULL CHECK (length(agent_name) BETWEEN 1 AND 24),
  mode_key TEXT CHECK (mode_key IS NULL OR length(mode_key) BETWEEN 1 AND 24),
  parent_thread_id TEXT
    CHECK (parent_thread_id IS NULL OR length(parent_thread_id) BETWEEN 1 AND 128),
  definition_json TEXT NOT NULL
    CHECK (length(definition_json) <= 32768 AND json_valid(definition_json)),
  created_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX plugin_agent_thread_plugin_idx
  ON plugin_agent_thread (plugin_id, created_at DESC);

-- When Core pauses an idle Orb whose provider has no pause deadline of its
-- own (Lizard: a sandbox's timeout deletes it, so dx pauses it instead).
-- An Orb's activity moves its row's deadline; the Worker's minute cron
-- pauses every Orb past its deadline and removes the row
-- (apps/core/src/execution/idle-deadlines.ts). Archiving or destroying the
-- Orb removes the row too.

CREATE TABLE orb_idle_deadline (
  provider_id TEXT NOT NULL,
  sandbox_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  -- Epoch milliseconds.
  deadline_at INTEGER NOT NULL,
  PRIMARY KEY (provider_id, sandbox_id)
);

CREATE INDEX orb_idle_deadline_due ON orb_idle_deadline (deadline_at);

-- Reactions on a shared Thread's messages (apps/core/src/thread-sharing/
-- message-reactions.ts): one row per person, message, and reaction. A
-- message is its Flue history id. Rows stay while the Thread is private and
-- show again when it is shared again; deleting the Thread drops them.
CREATE TABLE thread_reaction (
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reaction TEXT NOT NULL
    CHECK (reaction IN ('thumbs_up', 'heart', 'joy', 'eyes', 'wave')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, message_id, user_id, reaction)
) WITHOUT ROWID;

CREATE INDEX thread_reaction_user_idx
  ON thread_reaction (user_id);

-- Deleting an account drops its reactions.
CREATE TRIGGER thread_reaction_account_deleted
AFTER DELETE ON "user"
BEGIN
  DELETE FROM thread_reaction WHERE user_id = OLD.id;
END;
