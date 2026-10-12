-- A person's notification inbox. A row records that something happened that
-- concerns them (a topic such as `mention`) in a Thread; delivery channels
-- such as email are recorded separately in notification_delivery. The
-- source key names the event, so a retried message notifies once.
CREATE TABLE notification (
  id TEXT PRIMARY KEY CHECK (id GLOB 'ntf_*' AND length(id) = 36),
  recipient_user_id TEXT NOT NULL,
  topic TEXT NOT NULL CHECK (length(topic) BETWEEN 1 AND 64),
  source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 256),
  thread_id TEXT NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 128),
  message_id TEXT CHECK (message_id IS NULL OR length(message_id) <= 64),
  actor_user_id TEXT,
  excerpt TEXT NOT NULL CHECK (length(excerpt) <= 512),
  created_at TEXT NOT NULL,
  read_at TEXT,
  UNIQUE (recipient_user_id, source_key)
);

CREATE INDEX notification_recipient_idx
  ON notification (recipient_user_id, created_at DESC);

CREATE INDEX notification_unread_idx
  ON notification (recipient_user_id)
  WHERE read_at IS NULL;

-- A person's choice for one topic on one channel. Without a row the topic's
-- default for that channel applies.
CREATE TABLE notification_preference (
  user_id TEXT NOT NULL,
  topic TEXT NOT NULL CHECK (length(topic) BETWEEN 1 AND 64),
  channel TEXT NOT NULL CHECK (length(channel) BETWEEN 1 AND 64),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, topic, channel)
);

-- The outcome of delivering one notification on one channel. `error` is a
-- bounded code, never provider text or message content.
CREATE TABLE notification_delivery (
  notification_id TEXT NOT NULL REFERENCES notification (id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (length(channel) BETWEEN 1 AND 64),
  status TEXT NOT NULL CHECK (status IN ('sent', 'failed')),
  error TEXT CHECK (error IS NULL OR length(error) <= 64),
  attempted_at TEXT NOT NULL,
  PRIMARY KEY (notification_id, channel)
);
