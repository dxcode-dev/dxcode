-- Thread sharing (0.2.9). The owner shares a Thread with their workspace for
-- View or Contribute. Contribute ("multiplayer") lasts until
-- contribute_until; afterward members keep View. `visibility` remains the
-- coarse private/workspace flag that usage audit and realtime presence read.
ALTER TABLE threads ADD COLUMN workspace_access TEXT NOT NULL DEFAULT 'none'
  CHECK (workspace_access IN ('none', 'view', 'contribute'));
ALTER TABLE threads ADD COLUMN shared_workspace_id TEXT
  CHECK (shared_workspace_id IS NULL OR length(shared_workspace_id) BETWEEN 1 AND 128);
ALTER TABLE threads ADD COLUMN contribute_until TEXT
  CHECK (contribute_until IS NULL OR length(contribute_until) BETWEEN 20 AND 40);

CREATE INDEX threads_shared_workspace_idx
  ON threads (shared_workspace_id, last_activity_at DESC)
  WHERE workspace_access != 'none';

-- Everyone who opened or messaged a shared Thread, for avatars and names.
-- Who sent each message travels with the message itself, in the
-- <dx_message_author> tag dx prefixes to every user message.
CREATE TABLE thread_participant (
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  first_seen_at TEXT NOT NULL CHECK (length(first_seen_at) BETWEEN 20 AND 40),
  last_seen_at TEXT NOT NULL CHECK (length(last_seen_at) BETWEEN 20 AND 40),
  last_message_at TEXT
    CHECK (last_message_at IS NULL OR length(last_message_at) BETWEEN 20 AND 40),
  PRIMARY KEY (thread_id, user_id)
);

-- "Don't ask me again" for the Enable Multiplayer confirmation.
CREATE TABLE thread_sharing_preference (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
  skip_multiplayer_confirmation INTEGER NOT NULL DEFAULT 0
    CHECK (skip_multiplayer_confirmation IN (0, 1)),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40)
);

-- Chat in shared Threads (0.2.9). Members of a shared Thread talk to each
-- other in the same conversation as the agent; Flue records those chat
-- messages without a model call. conversation_mode is the Thread's current
-- mode: tagging a member switches it to chat, tagging @dx switches it back
-- to agent, and an untagged message keeps it. A private Thread is always in
-- agent mode, whatever this column holds.
ALTER TABLE threads ADD COLUMN conversation_mode TEXT NOT NULL DEFAULT 'agent'
  CHECK (conversation_mode IN ('agent', 'chat'));

-- Members following another member's shared Thread. A followed Thread shows
-- in the member's sidebar under its Project. Opening a Thread or being
-- tagged in it follows it; the owner always follows their own Thread and
-- has no row here.
CREATE TABLE thread_follower (
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  followed_at TEXT NOT NULL CHECK (length(followed_at) BETWEEN 20 AND 40),
  PRIMARY KEY (thread_id, user_id)
);

CREATE INDEX thread_follower_user_idx ON thread_follower (user_id, thread_id);

-- Members who opened or messaged another member's shared Thread before
-- following existed keep it in their sidebar: they follow it.
INSERT OR IGNORE INTO thread_follower (thread_id, user_id, followed_at)
SELECT participant.thread_id, participant.user_id, participant.first_seen_at
  FROM thread_participant AS participant
  JOIN threads AS thread ON thread.id = participant.thread_id
 WHERE participant.user_id != thread.owner_user_id;
