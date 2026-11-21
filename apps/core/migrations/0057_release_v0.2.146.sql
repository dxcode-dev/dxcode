-- A person's progress through new-account onboarding, the same on every
-- device: when they finished or skipped setup (`/welcome`), when they
-- finished the thread tour, and when they hid the home page's setup
-- checklist. No row means none of these happened yet: a new account sees
-- setup. Accounts that existed before onboarding shipped are recorded as
-- done, so they never see it.
CREATE TABLE user_onboarding (
  user_id TEXT PRIMARY KEY NOT NULL,
  setup_finished_at TEXT,
  tour_finished_at TEXT,
  checklist_hidden_at TEXT,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

INSERT INTO user_onboarding (
  user_id,
  setup_finished_at,
  tour_finished_at,
  checklist_hidden_at,
  updated_at
)
SELECT
  id,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM "user";
