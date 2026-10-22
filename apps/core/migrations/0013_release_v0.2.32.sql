-- Browser sessions that ended within the last hour. Better Auth's signed
-- session cookie cache (auth/better-auth.ts, one hour) lets a browser skip
-- D1, so a deleted session row alone does not stop a browser holding a warm
-- cache. Core checks this record on every cache hit
-- (auth/session-revocation.ts). The trigger records every deletion however it
-- happens: ending one or all other sessions, signing out, expiry cleanup, or
-- a deleted user. Rows older than the cache max age protect nothing and are
-- pruned on the next deletion.
CREATE TABLE session_revocation (
  session_id TEXT PRIMARY KEY,
  ended_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX session_revocation_ended_at ON session_revocation (ended_at);

CREATE TRIGGER session_revocation_record
AFTER DELETE ON "session"
BEGIN
  DELETE FROM session_revocation
  WHERE ended_at < CAST(unixepoch('subsec') * 1000 AS INTEGER) - 3600000;
  INSERT INTO session_revocation (session_id, ended_at)
  VALUES (OLD.id, CAST(unixepoch('subsec') * 1000 AS INTEGER))
  ON CONFLICT (session_id) DO UPDATE SET ended_at = excluded.ended_at;
END;

-- Dictation vocabulary: names, technical terms, and other words dictation
-- should recognize. One list per person and one per workspace; a
-- transcription is biased toward both, personal terms first
-- (dictation/vocabulary.ts). `terms` is a JSON array of at most 50 terms of
-- at most 64 characters, validated by the route before it is written.
CREATE TABLE dictation_vocabulary (
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 128),
  terms TEXT NOT NULL CHECK (json_valid(terms) AND json_type(terms) = 'array' AND json_array_length(terms) <= 50),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, target_id)
) WITHOUT ROWID;

-- A Thread its owner snoozed: hidden in the sidebar's Snoozed section until
-- `snoozed_until`, then back in its usual section marked Woke until the owner
-- opens it. Nothing runs at the wake time; readers compare it with the clock.
-- `snoozed_at` is when the owner snoozed it. Waking clears both and records
-- `snooze_woke_at`, so the time asleep does not count toward Inactive. Only
-- active root Threads are snoozed; archiving clears the snooze.
ALTER TABLE threads ADD COLUMN snoozed_until TEXT;
ALTER TABLE threads ADD COLUMN snoozed_at TEXT;
ALTER TABLE threads ADD COLUMN snooze_woke_at TEXT;
