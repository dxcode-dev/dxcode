-- Bug reports are kept in dx and never filed on GitHub, and a report sent
-- from Settings concerns no Thread. SQLite cannot drop a NOT NULL or a
-- column with a CHECK, so the table is rebuilt as in 0091: `thread_id`
-- becomes optional, and `status`, `issue_number`, `issue_url`, and
-- `updated_at`, which only recorded GitHub filing, are dropped. Every
-- report's message, reporter, Thread, images, and diagnostics stay.
ALTER TABLE bug_report RENAME TO bug_report_0105;

CREATE TABLE bug_report (
  id TEXT PRIMARY KEY CHECK (id GLOB 'bug_*' AND length(id) = 36),
  reporter_user_id TEXT NOT NULL,
  -- NULL for a report sent from Settings.
  thread_id TEXT,
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 10000),
  image_count INTEGER NOT NULL CHECK (image_count BETWEEN 0 AND 5),
  diagnostics TEXT NOT NULL,
  created_at TEXT NOT NULL
) WITHOUT ROWID;

INSERT INTO bug_report
  (id, reporter_user_id, thread_id, message, image_count, diagnostics,
   created_at)
SELECT id, reporter_user_id, thread_id, message, image_count, diagnostics,
       created_at
  FROM bug_report_0105;

DROP TABLE bug_report_0105;

CREATE INDEX bug_report_reporter_created
  ON bug_report (reporter_user_id, created_at DESC);

-- Report readers and their agents list every report, newest first.
CREATE INDEX bug_report_created ON bug_report (created_at DESC, id DESC);
