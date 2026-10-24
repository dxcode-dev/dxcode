-- Deleting a Thread keeps its row as a tombstone (lifecycle_state 'deleted')
-- so its ID is never issued again; every read already skips such rows. This
-- table records each deletion and whether the Thread's data outside D1 (its
-- Flue history, sandbox, search text, and stored files) is gone yet. The
-- cron retries a deletion until `completed_at` is set.
CREATE TABLE thread_deletion (
  thread_id TEXT PRIMARY KEY REFERENCES threads (id),
  owner_user_id TEXT NOT NULL CHECK (length(owner_user_id) BETWEEN 1 AND 128),
  requested_at TEXT NOT NULL CHECK (length(requested_at) BETWEEN 20 AND 40),
  completed_at TEXT
    CHECK (completed_at IS NULL OR length(completed_at) BETWEEN 20 AND 40),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at TEXT
    CHECK (last_attempt_at IS NULL OR length(last_attempt_at) BETWEEN 20 AND 40),
  last_error TEXT CHECK (last_error IS NULL OR length(last_error) <= 512)
);

CREATE INDEX thread_deletion_pending_idx
  ON thread_deletion (last_attempt_at)
  WHERE completed_at IS NULL;

-- A tombstone is permanent: it cannot be restored or removed, so its ID
-- stays taken.
CREATE TRIGGER threads_tombstone_no_restore
BEFORE UPDATE OF lifecycle_state ON threads
WHEN OLD.lifecycle_state = 'deleted' AND NEW.lifecycle_state != 'deleted'
BEGIN
  SELECT RAISE(ABORT, 'thread tombstone is permanent');
END;

CREATE TRIGGER threads_tombstone_no_delete
BEFORE DELETE ON threads
WHEN OLD.lifecycle_state = 'deleted'
BEGIN
  SELECT RAISE(ABORT, 'thread tombstone is permanent');
END;

-- What a sidebar row draws attention to. turn_settled_at is when the
-- agent last finished a turn, completed or failed; an aborted turn was
-- stopped by someone watching and does not count. turn_failed is 1 while
-- the latest turn ended in an error, until the next one starts. Existing
-- Threads start with neither, so no Thread turns unread on deploy.
ALTER TABLE threads ADD COLUMN turn_settled_at TEXT
  CHECK (turn_settled_at IS NULL OR length(turn_settled_at) BETWEEN 20 AND 40);
ALTER TABLE threads ADD COLUMN turn_failed INTEGER NOT NULL DEFAULT 0
  CHECK (turn_failed IN (0, 1));

-- When each person last saw a Thread: opened it, or had it open when a turn
-- settled. A Thread is unread for them while its turn_settled_at is later.
CREATE TABLE thread_seen (
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  seen_at TEXT NOT NULL CHECK (length(seen_at) BETWEEN 20 AND 40),
  PRIMARY KEY (thread_id, user_id)
);
