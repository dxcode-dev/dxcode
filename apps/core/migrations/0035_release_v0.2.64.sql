-- Environment variable names follow the shell: letters in either case,
-- digits, and underscores, not starting with a digit (#1165). Names stay
-- case-sensitive (BINARY), so MY_TOKEN and my_token are two variables.
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt with
-- unchanged rows. No table references it; foreign keys are deferred as in
-- 0067 so a reference would be checked once, at the end. The revision
-- triggers are recreated after the rename, so the copy bumps no revision.
PRAGMA defer_foreign_keys = on;

CREATE TABLE environment_variable_rebuilt (
  id TEXT NOT NULL PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'project', 'workspace')),
  target_id TEXT NOT NULL,
  name TEXT NOT NULL COLLATE BINARY
    CHECK (length(name) BETWEEN 1 AND 64)
    CHECK (name NOT GLOB '*[^A-Za-z0-9_]*')
    CHECK (substr(name, 1, 1) GLOB '[A-Za-z_]'),
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

INSERT INTO environment_variable_rebuilt (
  id, scope, target_id, name, kind, enabled, policy_locked, envelope_version,
  key_version, value_nonce, ciphertext, wrapped_key_nonce, wrapped_key,
  created_at, updated_at, rotated_at
)
SELECT
  id, scope, target_id, name, kind, enabled, policy_locked, envelope_version,
  key_version, value_nonce, ciphertext, wrapped_key_nonce, wrapped_key,
  created_at, updated_at, rotated_at
FROM environment_variable;

DROP TABLE environment_variable;
ALTER TABLE environment_variable_rebuilt RENAME TO environment_variable;

CREATE INDEX environment_variable_target_name_idx
  ON environment_variable (scope, target_id, name, id);

CREATE INDEX environment_variable_target_enabled_idx
  ON environment_variable (scope, target_id, enabled, policy_locked, name);

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

-- The message a person has typed in one Thread's composer and not yet sent,
-- the same on every device they sign in on; the last write wins. Each member
-- of a shared Thread has their own. Sending, or clearing the composer,
-- deletes the row, and deleting a Thread removes its rows.
CREATE TABLE thread_draft (
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 65536),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  PRIMARY KEY (thread_id, user_id)
) WITHOUT ROWID;

-- A draft never outlives its reader's access. Deleting the account deletes
-- the person's drafts (through this index); deleting a Thread cascades, and
-- every change that takes access away (unsharing, leaving or deleting a
-- workspace, deleting a Project) prunes the drafts its people can no longer
-- read.
CREATE INDEX thread_draft_user_idx ON thread_draft (user_id);

CREATE TRIGGER thread_draft_account_deleted
AFTER DELETE ON "user"
BEGIN
  DELETE FROM thread_draft WHERE user_id = OLD.id;
END;

-- Workspace Instructions (#1538): one AGENTS.md per workspace that admins
-- write and every member's top-level agent receives, ahead of the member's
-- own instructions and the project's AGENTS.md. No row means none yet.
CREATE TABLE workspace_agent_instructions (
  workspace_id TEXT PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  content TEXT NOT NULL CHECK (length(content) <= 8000),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

-- Text Size scales the web app's text; Thread Width sets how wide a Thread's
-- transcript and composer grow. Both sync with the account's other appearance
-- values.
ALTER TABLE personal_account
  ADD COLUMN text_size TEXT NOT NULL DEFAULT 'default'
  CHECK (text_size IN ('small', 'default', 'large', 'larger'));

ALTER TABLE personal_account
  ADD COLUMN thread_width TEXT NOT NULL DEFAULT 'default'
  CHECK (thread_width IN ('narrow', 'default', 'wide', 'full'));

-- The terminal's light or dark choice ('match' follows the app's theme) and
-- the Code Font. A NULL Code Font value uses the default. Core validates the
-- values; these checks only bound their length.
ALTER TABLE personal_account
  ADD COLUMN terminal_appearance TEXT NOT NULL DEFAULT 'match'
  CHECK (terminal_appearance IN ('match', 'light', 'dark'));

ALTER TABLE personal_account
  ADD COLUMN code_font_family TEXT
  CHECK (code_font_family IS NULL OR length(code_font_family) BETWEEN 1 AND 200);

ALTER TABLE personal_account
  ADD COLUMN code_font_size TEXT
  CHECK (code_font_size IS NULL OR length(code_font_size) BETWEEN 1 AND 16);

ALTER TABLE personal_account
  ADD COLUMN code_line_height TEXT
  CHECK (code_line_height IS NULL OR length(code_line_height) BETWEEN 1 AND 16);

-- Motion & Sound: whether the home page's dx logo animates (reduced motion
-- still holds it), and whether dictation, the mode dial, and other
-- interactions play short sounds.
ALTER TABLE personal_account
  ADD COLUMN logo_animation INTEGER NOT NULL DEFAULT 1
  CHECK (logo_animation IN (0, 1));

ALTER TABLE personal_account
  ADD COLUMN ui_sounds INTEGER NOT NULL DEFAULT 0
  CHECK (ui_sounds IN (0, 1));
