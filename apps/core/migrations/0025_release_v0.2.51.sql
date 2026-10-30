-- The Claude Pro/Max connection a Claude Code Thread runs on. A person may
-- connect several plans; a Thread's first submission takes the first one in
-- routing order that is not used up, and the Thread stays on it, used up or
-- not. Deleting the connection lets the Thread take another.
ALTER TABLE threads ADD COLUMN claude_connection_id TEXT
  REFERENCES model_connection (id) ON DELETE SET NULL;

CREATE INDEX threads_claude_connection_idx ON threads (claude_connection_id)
  WHERE claude_connection_id IS NOT NULL;
