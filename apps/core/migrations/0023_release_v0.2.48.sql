-- Temporary Thread storage files: links a Thread shares and files one Thread
-- hands to another. Each expires three hours after it is stored; reads refuse
-- it from then on, and the scheduled sweep deletes its row and bytes. A file
-- without an expiry lasts as long as its Thread, as before.
ALTER TABLE thread_storage_files ADD COLUMN expires_at INTEGER
  CHECK (expires_at IS NULL OR expires_at > created_at);

CREATE INDEX thread_storage_files_expiry_idx
  ON thread_storage_files (expires_at)
  WHERE expires_at IS NOT NULL;

-- The Thread storage sweep's second query: uploads left unfinished across
-- every Thread. Without this it scans the whole table on every cron tick.
CREATE INDEX thread_storage_files_uploading_idx
  ON thread_storage_files (created_at)
  WHERE state = 'uploading';
