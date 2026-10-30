-- A Claude Code Thread never leaves the Claude Pro/Max plan it ran on, even
-- when that plan is deleted. `claude_connection_id` is cleared by the
-- connection's deletion (ON DELETE SET NULL), so the time the Thread took its
-- plan is kept here: a Thread with a bound time and no connection has lost
-- its plan and takes no other.
ALTER TABLE threads ADD COLUMN claude_connection_bound_at TEXT
  CHECK (claude_connection_bound_at IS NULL OR length(claude_connection_bound_at) BETWEEN 20 AND 40);

UPDATE threads SET claude_connection_bound_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE claude_connection_id IS NOT NULL;

-- Migration 0103 left the Threads that had already run Claude Code without
-- a plan, so each took the first plan not used up at its next message, which
-- could be another account than the one it ran on. The usage ledger names
-- the plan of every turn: put each such Thread back on the plan of its
-- latest Claude Code turn. A Thread with no Claude Code turn yet stays
-- without a plan and takes one at its first.
UPDATE threads SET
  claude_connection_id = (
    SELECT usage_event.connection_id FROM usage_event
    JOIN model_connection ON model_connection.id = usage_event.connection_id
    WHERE usage_event.owner_user_id = threads.owner_user_id
      AND usage_event.thread_id = threads.id
      AND usage_event.provider_id = 'claude-code'
    ORDER BY usage_event.occurred_at DESC, usage_event.id DESC
    LIMIT 1
  ),
  claude_connection_bound_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE claude_connection_id IS NULL
  AND claude_connection_bound_at IS NULL
  AND EXISTS (
    SELECT 1 FROM usage_event
    JOIN model_connection ON model_connection.id = usage_event.connection_id
    WHERE usage_event.owner_user_id = threads.owner_user_id
      AND usage_event.thread_id = threads.id
      AND usage_event.provider_id = 'claude-code'
  );
