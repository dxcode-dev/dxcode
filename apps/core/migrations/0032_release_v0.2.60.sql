-- Needs you reads a person's asks by their owner (#1490). The list walked
-- every Thread the person owns and probed each for an ask; it now seeks
-- the person's asks, newest first. A Thread never changes owner, so every
-- writer copies the owner onto the ask. Existing asks take theirs from
-- `threads`.
ALTER TABLE thread_attention_request ADD COLUMN owner_user_id TEXT;

UPDATE thread_attention_request
   SET owner_user_id = (
     SELECT owner_user_id FROM threads
      WHERE threads.id = thread_attention_request.thread_id);

CREATE INDEX thread_attention_request_owner_idx
  ON thread_attention_request (owner_user_id, requested_at DESC, thread_id);
