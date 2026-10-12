-- Files a user uploads for a message. The bytes live in R2 under
-- `attachments/<uploader>/<id>`; a message carries only the id and URL.
-- An upload belongs to its uploader until a message admits it.
CREATE TABLE attachments (
  id TEXT PRIMARY KEY CHECK (id GLOB 'att_[0-9a-f]*' AND length(id) = 36),
  uploader_user_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE,
  upload_id TEXT,
  filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 1024),
  mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 255),
  size INTEGER NOT NULL CHECK (size > 0),
  state TEXT NOT NULL CHECK (state IN ('uploading', 'ready')),
  created_at INTEGER NOT NULL
);

CREATE INDEX attachments_uploader_idx
  ON attachments (uploader_user_id, created_at);

-- Each Thread a message sent the file in. A sent file is never deleted by
-- its uploader, and anyone who can read one of these Threads can read it.
-- One file may be sent in several Threads, for example forwarded by an agent.
CREATE TABLE attachment_threads (
  attachment_id TEXT NOT NULL REFERENCES attachments (id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 128),
  sender_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (attachment_id, thread_id)
);

CREATE INDEX attachment_threads_thread_idx
  ON attachment_threads (thread_id);
