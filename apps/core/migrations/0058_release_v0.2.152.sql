-- Runners: a person's own Mac or Linux machine that runs their Threads
-- (Orb provider `runner`, behind the `orb-provider-runner` experimental
-- feature). `dxd runner` on the machine pairs once with a one-time code and
-- then dials out with the token it was given; dx keeps only hashes of both.
-- A Thread pins its machine in execution_workspace.provider_template.
-- IF NOT EXISTS: the PR #2315 preview applied this under earlier numbers
-- before main took them, so a renumbered file must apply cleanly over it.
CREATE TABLE IF NOT EXISTS runner_machine (
  id TEXT NOT NULL PRIMARY KEY CHECK (id GLOB 'rnm_[0-9a-f]*' AND length(id) = 28),
  owner_user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
  os TEXT NOT NULL CHECK (os IN ('macos', 'linux')),
  arch TEXT NOT NULL CHECK (length(arch) BETWEEN 1 AND 32),
  version TEXT NOT NULL DEFAULT '' CHECK (length(version) <= 32),
  token_sha256 TEXT NOT NULL UNIQUE CHECK (length(token_sha256) = 64),
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);

CREATE INDEX IF NOT EXISTS runner_machine_owner_idx
  ON runner_machine (owner_user_id, revoked_at, last_seen_at);

-- One-time pairing codes from Settings or the Orb picker: single use, 15
-- minutes, five wrong guesses.
CREATE TABLE IF NOT EXISTS runner_pairing (
  code_sha256 TEXT NOT NULL PRIMARY KEY CHECK (length(code_sha256) = 64),
  owner_user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at INTEGER
);

CREATE INDEX IF NOT EXISTS runner_pairing_owner_idx ON runner_pairing (owner_user_id);
