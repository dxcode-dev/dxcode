-- The person's Sidebar Layout and Sidebar Order, kept with their sidebar
-- panel and shared by every device they sign in on: Threads grouped by
-- Project or in one list ('project', 'list'), and sorted by last activity or
-- by when they were created ('activity', 'created'). NULL until the person
-- chooses, so the defaults (By Project, Recent Activity) apply.
ALTER TABLE sidebar_panel
  ADD COLUMN thread_grouping TEXT
  CHECK (thread_grouping IS NULL OR thread_grouping IN ('project', 'list'));

ALTER TABLE sidebar_panel
  ADD COLUMN thread_order TEXT
  CHECK (thread_order IS NULL OR thread_order IN ('activity', 'created'));

-- The Thread investigating a bug report: at most one per report, so two
-- clicks on Investigate at once start one Thread. A person claims the row
-- before the Thread exists, with the Thread ID it will have; another claim
-- replaces it only once that Thread is deleted, or when its creation never
-- wrote a Thread and the claim is stale.
CREATE TABLE bug_report_investigation (
  report_id TEXT PRIMARY KEY
    REFERENCES bug_report (id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL,
  started_by_user_id TEXT NOT NULL,
  claimed_at TEXT NOT NULL
) WITHOUT ROWID;

-- The bug report tools find the report a Thread investigates.
CREATE INDEX bug_report_investigation_thread
  ON bug_report_investigation (thread_id);
