-- Work that happens after a turn ends (apps/core/src/automations/). A dx run
-- ends with its turn, so nothing in the workspace waits: the Worker's
-- one-minute cron finds what is due here and wakes the Thread with a message,
-- exactly as send_thread_message does, in dx and Claude Code mode alike.

-- A Thread's one schedule. `rrule` is the stored RFC 5545 text with an
-- explicit DTSTART;TZID line; `next_run_at` is null once it has finished
-- (COUNT reached or UNTIL passed). The sweep claims a firing by moving
-- `next_run_at` from the value it read, so each occurrence fires once.
CREATE TABLE thread_schedule (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  prompt TEXT NOT NULL CHECK (length(prompt) BETWEEN 1 AND 32000),
  rrule TEXT NOT NULL CHECK (length(rrule) BETWEEN 1 AND 1000),
  time_zone TEXT NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 64),
  label TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 200),
  run_mode TEXT NOT NULL CHECK (run_mode IN ('existing', 'fresh')),
  agent_mode TEXT CHECK (agent_mode IS NULL OR length(agent_mode) <= 128),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  next_run_at TEXT,
  fired_count INTEGER NOT NULL DEFAULT 0 CHECK (fired_count >= 0),
  last_run_at TEXT,
  last_run_status TEXT CHECK (
    last_run_status IS NULL
    OR last_run_status IN ('delivered', 'started', 'skipped', 'failed')
  ),
  last_run_detail TEXT CHECK (last_run_detail IS NULL OR length(last_run_detail) <= 500),
  last_run_thread_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX thread_schedule_due_idx ON thread_schedule (next_run_at)
  WHERE enabled = 1 AND next_run_at IS NOT NULL;
CREATE INDEX thread_schedule_owner_idx ON thread_schedule (owner_user_id);

-- A GitHub event subscription. dx reads GitHub as the Thread's `gh` does
-- (the owner's GITHUB_TOKEN environment variable, else their dx GitHub
-- connection) and polls while active; `cursor_json` remembers what it has
-- seen. `equivalence_key` makes creating the same subscription again return
-- the saved one.
CREATE TABLE github_subscription (
  id TEXT PRIMARY KEY CHECK (id GLOB 'ghs_*' AND length(id) = 36),
  owner_user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  repository TEXT NOT NULL CHECK (length(repository) BETWEEN 3 AND 200),
  filter_kind TEXT NOT NULL CHECK (
    filter_kind IN ('ci', 'pr-comments', 'issue-comments', 'issue-opened', 'pr-opened')
  ),
  filter_json TEXT NOT NULL CHECK (json_valid(filter_json) AND length(filter_json) <= 2000),
  destination TEXT NOT NULL CHECK (destination IN ('this-thread', 'new-thread')),
  project_id TEXT,
  agent_mode TEXT CHECK (agent_mode IS NULL OR length(agent_mode) <= 128),
  instructions TEXT CHECK (instructions IS NULL OR length(instructions) <= 32000),
  automatic INTEGER NOT NULL CHECK (automatic IN (0, 1)),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('active', 'finished', 'expired', 'failed')),
  state_detail TEXT CHECK (state_detail IS NULL OR length(state_detail) <= 500),
  expires_at TEXT,
  equivalence_key TEXT NOT NULL CHECK (length(equivalence_key) = 64),
  cursor_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(cursor_json) AND length(cursor_json) <= 16000),
  next_poll_at TEXT,
  last_polled_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (owner_user_id, equivalence_key)
);

CREATE INDEX github_subscription_due_idx ON github_subscription (next_poll_at)
  WHERE enabled = 1 AND state = 'active';
CREATE INDEX github_subscription_owner_idx
  ON github_subscription (owner_user_id, created_at DESC);
CREATE INDEX github_subscription_thread_idx ON github_subscription (thread_id);

-- Each event a subscription delivered, once: the key names the event (a
-- comment ID, a CI result digest), so a repeated poll delivers nothing new.
CREATE TABLE github_subscription_event (
  subscription_id TEXT NOT NULL REFERENCES github_subscription(id) ON DELETE CASCADE,
  event_key TEXT NOT NULL CHECK (length(event_key) BETWEEN 1 AND 200),
  summary TEXT NOT NULL CHECK (length(summary) <= 500),
  url TEXT CHECK (url IS NULL OR length(url) <= 2000),
  status TEXT NOT NULL CHECK (status IN ('delivered', 'started', 'failed')),
  delivered_thread_id TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (subscription_id, event_key)
);

-- The owner's IANA time zone, from their browser, where a schedule without
-- DTSTART is anchored. Without a row, schedules use UTC.
CREATE TABLE user_time_zone (
  user_id TEXT PRIMARY KEY,
  time_zone TEXT NOT NULL CHECK (length(time_zone) BETWEEN 1 AND 64),
  updated_at TEXT NOT NULL
);

-- GitHub subscriptions (0090) are driven by the dx GitHub App's webhooks:
-- the delivery ledger now also records check, status, workflow, pull
-- request, review, comment, and issue events. SQLite cannot widen a CHECK,
-- so the table is rebuilt as in 0029.
ALTER TABLE github_webhook_delivery RENAME TO github_webhook_delivery_0029;

CREATE TABLE github_webhook_delivery (
  delivery_id TEXT NOT NULL PRIMARY KEY CHECK (length(delivery_id) BETWEEN 1 AND 128),
  event TEXT NOT NULL CHECK (event IN (
    'ping', 'installation', 'installation_repositories', 'installation_target',
    'github_app_authorization', 'repository', 'check_run', 'check_suite',
    'status', 'workflow_run', 'pull_request', 'pull_request_review',
    'pull_request_review_comment', 'issue_comment', 'issues'
  )),
  action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 64),
  payload_sha256 TEXT NOT NULL CHECK (length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^a-f0-9]*'),
  state TEXT NOT NULL CHECK (state IN ('received', 'processing', 'processed', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 16),
  installation_id TEXT,
  received_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  processed_at TEXT,
  expires_at TEXT NOT NULL,
  CHECK ((state = 'processed' AND processed_at IS NOT NULL) OR (state != 'processed' AND processed_at IS NULL))
);

INSERT INTO github_webhook_delivery SELECT * FROM github_webhook_delivery_0029;
DROP TABLE github_webhook_delivery_0029;

CREATE INDEX github_webhook_delivery_state_idx
  ON github_webhook_delivery (state, expires_at, delivery_id);

-- Subscriptions no longer poll: a webhook finds its subscriptions by
-- repository. cursor_json, next_poll_at, last_polled_at, and
-- consecutive_failures are unused from here on.
DROP INDEX github_subscription_due_idx;
CREATE INDEX github_subscription_repository_idx
  ON github_subscription (repository COLLATE NOCASE)
  WHERE enabled = 1 AND state = 'active';

-- What the Thread header lists, kept current by the dx GitHub App's
-- webhooks so no view reads GitHub.
-- A pr-comments subscription's pull request: title, first description line,
-- state, and when that state last changed, from its pull_request webhooks.
ALTER TABLE github_subscription ADD COLUMN subject_json TEXT CHECK (
  subject_json IS NULL OR (json_valid(subject_json) AND length(subject_json) <= 2000)
);
-- A delivered CI result's commit, branch, and checks.
ALTER TABLE github_subscription_event ADD COLUMN detail_json TEXT CHECK (
  detail_json IS NULL OR (json_valid(detail_json) AND length(detail_json) <= 8000)
);
