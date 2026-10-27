-- Files a Thread keeps in dx, outside its Orb: media its agent shows in the
-- transcript and, later, files other Threads fetch from it. The bytes live in
-- R2 under `thread-storage/<thread>/<id>`. Only the Thread's own daemon key
-- writes a file; anyone who can read the Thread reads it.
CREATE TABLE thread_storage_files (
  id TEXT PRIMARY KEY CHECK (id GLOB 'tsf_[0-9a-f]*' AND length(id) = 36),
  thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 128),
  object_key TEXT NOT NULL UNIQUE,
  upload_id TEXT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 1024),
  mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 255),
  size INTEGER NOT NULL CHECK (size > 0),
  state TEXT NOT NULL CHECK (state IN ('uploading', 'ready')),
  created_at INTEGER NOT NULL
);

CREATE INDEX thread_storage_files_thread_idx
  ON thread_storage_files (thread_id, state, created_at);
