-- A Thread whose latest submission failed on its Claude plan's limit (#1578).
-- The Worker cron resumes the Thread once `resets_at` (epoch seconds) passes,
-- with an idempotency key from `submission_id`, so it runs once. The Thread's
-- next submission starting deletes the row; one that fails on the limit
-- again writes a new one.
CREATE TABLE thread_plan_wait (
  thread_id TEXT PRIMARY KEY REFERENCES threads (id) ON DELETE CASCADE,
  submission_id TEXT NOT NULL CHECK (length(submission_id) BETWEEN 1 AND 200),
  resets_at INTEGER NOT NULL,
  recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 20 AND 40)
);

CREATE INDEX thread_plan_wait_due_idx ON thread_plan_wait (resets_at);
