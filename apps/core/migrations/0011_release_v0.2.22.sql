-- One-time Portal sign-in codes. The dx app mints one after it authorizes a
-- signed-in user for a Thread port; the Portal host redeems it within 60
-- seconds, with the handshake state cookie it set, for its own session
-- cookie. Only SHA-256 hashes of the code and the state are stored, and
-- redemption deletes the row, so a code works once.
CREATE TABLE portal_auth_codes (
  code_hash TEXT PRIMARY KEY CHECK (length(code_hash) = 64),
  state_hash TEXT NOT NULL CHECK (length(state_hash) = 64),
  portal_host TEXT NOT NULL CHECK (length(portal_host) BETWEEN 1 AND 253),
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  user_email TEXT,
  user_name TEXT,
  return_path TEXT NOT NULL CHECK (
    length(return_path) BETWEEN 1 AND 4096 AND substr(return_path, 1, 1) = '/'
  ),
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX portal_auth_codes_expiry_idx ON portal_auth_codes (expires_at);

-- Public Portal links. While a row is unexpired, anyone may open that one
-- port of the Thread at its Portal host without signing in; they get no
-- identity headers and no Thread access. The owner sets a 1 hour, 1 day, or
-- 7 day lifetime and can delete the row at any time. `id` changes with each
-- new link, so a visitor's first-visit acknowledgement does not carry over to
-- a later link for the same port.
CREATE TABLE portal_public_links (
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  id TEXT NOT NULL CHECK (length(id) = 43),
  created_by_user_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, port)
);

-- A Thread that stops being active loses its public links for good:
-- unarchiving does not republish them.
CREATE TRIGGER portal_public_links_after_thread_inactive
AFTER UPDATE OF lifecycle_state ON threads
WHEN NEW.lifecycle_state <> 'active'
BEGIN
  DELETE FROM portal_public_links WHERE thread_id = NEW.id;
END;
