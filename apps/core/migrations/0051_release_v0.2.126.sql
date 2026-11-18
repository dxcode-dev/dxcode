-- dx Mailbox (wiki/agent-mail.md): one mailbox per person at
-- `username@<mail domain>`, shared by the person and their agents. Mail
-- reaches the core Worker's email handler only when the deployment sets a
-- mail domain.

-- A username a person no longer holds. It keeps delivering to their
-- mailbox, and no one can ever take it, so a service's password reset for
-- the old address cannot reach someone else.
CREATE TABLE retired_username (
  username TEXT NOT NULL PRIMARY KEY COLLATE NOCASE
    CHECK (username = lower(username))
    CHECK (length(username) BETWEEN 1 AND 64),
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 128),
  retired_at TEXT NOT NULL
);

CREATE INDEX retired_username_user_idx ON retired_username (user_id);

-- A person's mailbox settings. A row exists once they opened the Mailbox.
CREATE TABLE mailbox (
  user_id TEXT NOT NULL PRIMARY KEY CHECK (length(user_id) BETWEEN 1 AND 128),
  -- What the person's agents may read: everything but private mail and
  -- other projects' tags, only their own project's tag, or nothing.
  agent_access TEXT NOT NULL DEFAULT 'all'
    CHECK (agent_access IN ('all', 'project', 'none')),
  -- A deployment admin paused this person's sending.
  sending_suspended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The fixed `username+tag@` address of one person for one Project: made
-- the first time it is needed, never changed, never reused within that
-- mailbox.
CREATE TABLE mailbox_project_tag (
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 128),
  tag TEXT NOT NULL
    CHECK (tag = lower(tag))
    CHECK (length(tag) BETWEEN 1 AND 31)
    CHECK (tag NOT GLOB '*[^a-z0-9-]*'),
  project_id TEXT NOT NULL CHECK (length(project_id) BETWEEN 1 AND 128),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, tag),
  UNIQUE (user_id, project_id)
);

-- Whether a member's own email to their `+tag` starts or continues Threads
-- in a Project, and how those Threads run; set by the Project's managers,
-- the same for every member's `+tag`.
CREATE TABLE project_mail_setting (
  project_id TEXT NOT NULL PRIMARY KEY CHECK (length(project_id) BETWEEN 1 AND 128),
  start_threads INTEGER NOT NULL DEFAULT 1 CHECK (start_threads IN (0, 1)),
  agent_mode TEXT CHECK (agent_mode IS NULL OR agent_mode IN ('low', 'medium', 'high', 'ultra')),
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'workspace')),
  updated_at TEXT NOT NULL
);

-- One email in a mailbox: received, or sent by the person. The raw message
-- and its parsed parts live in R2 under `r2_key`.
CREATE TABLE mail_item (
  id TEXT NOT NULL PRIMARY KEY CHECK (id GLOB 'mail_[0-9a-f]*' AND length(id) = 37),
  owner_user_id TEXT NOT NULL CHECK (length(owner_user_id) BETWEEN 1 AND 128),
  direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  folder TEXT NOT NULL CHECK (folder IN ('inbox', 'sent', 'archive', 'spam')),
  -- The `+tag` it was sent to, when that tag names one of the person's
  -- Projects; the Project at the time it arrived.
  tag TEXT CHECK (tag IS NULL OR length(tag) BETWEEN 1 AND 31),
  project_id TEXT,
  -- Never shown to agents.
  private INTEGER NOT NULL DEFAULT 0 CHECK (private IN (0, 1)),
  read_at TEXT,
  received_at TEXT NOT NULL,
  header_from TEXT CHECK (header_from IS NULL OR length(header_from) <= 998),
  from_address TEXT CHECK (from_address IS NULL OR length(from_address) <= 320),
  envelope_from TEXT CHECK (envelope_from IS NULL OR length(envelope_from) <= 998),
  rcpt_to TEXT NOT NULL CHECK (length(rcpt_to) <= 998),
  -- JSON arrays of addresses as the headers named them.
  to_addresses TEXT NOT NULL DEFAULT '[]',
  cc_addresses TEXT NOT NULL DEFAULT '[]',
  subject TEXT CHECK (subject IS NULL OR length(subject) <= 998),
  message_id TEXT CHECK (message_id IS NULL OR length(message_id) <= 998),
  -- Groups an email conversation: its first known Message-ID.
  conversation_key TEXT NOT NULL CHECK (length(conversation_key) BETWEEN 1 AND 998),
  dmarc TEXT CHECK (dmarc IS NULL OR length(dmarc) <= 32),
  -- Cloudflare passed DMARC for the From: domain with an aligned DKIM pass.
  authenticated INTEGER NOT NULL DEFAULT 0 CHECK (authenticated IN (0, 1)),
  size INTEGER NOT NULL CHECK (size >= 0),
  has_attachments INTEGER NOT NULL DEFAULT 0 CHECK (has_attachments IN (0, 1)),
  r2_key TEXT,
  preview TEXT CHECK (preview IS NULL OR length(preview) <= 400),
  -- What dx did with it: stored, started or followed up a Thread, sent by
  -- the person, the Started notice, or a `+tag` email from the owner that
  -- failed a check (`spam_<reason>`).
  disposition TEXT NOT NULL CHECK (
    disposition IN ('stored', 'started_thread', 'followed_up', 'sent', 'sent_started')
    OR disposition GLOB 'spam_*'
  ),
  thread_id TEXT
);

CREATE INDEX mail_item_folder_idx
  ON mail_item (owner_user_id, folder, received_at DESC);
CREATE INDEX mail_item_conversation_idx
  ON mail_item (owner_user_id, conversation_key, received_at);
CREATE INDEX mail_item_tag_idx
  ON mail_item (owner_user_id, tag, received_at DESC) WHERE tag IS NOT NULL;
CREATE INDEX mail_item_message_idx
  ON mail_item (owner_user_id, message_id) WHERE message_id IS NOT NULL;
-- The rate limits count each owner's started Threads, follow-ups and sends.
CREATE INDEX mail_item_disposition_idx
  ON mail_item (owner_user_id, disposition, received_at);

-- A label: the person's own, or one dx's automatic labelling uses.
CREATE TABLE mail_label (
  id TEXT NOT NULL PRIMARY KEY CHECK (id GLOB 'mlb_[0-9a-f]*' AND length(id) = 36),
  user_id TEXT NOT NULL CHECK (length(user_id) BETWEEN 1 AND 128),
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  kind TEXT NOT NULL CHECK (kind IN ('user', 'auto')),
  created_at TEXT NOT NULL,
  UNIQUE (user_id, name)
);

-- A label on an email, and who put it there. Labels never widen what an
-- agent may read.
CREATE TABLE mail_item_label (
  mail_id TEXT NOT NULL,
  label_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('user', 'clef')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (mail_id, label_id)
);

CREATE INDEX mail_item_label_label_idx ON mail_item_label (label_id);

-- Which Thread's agent read which email, for "Read by agent in …".
CREATE TABLE mail_read_log (
  mail_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  read_at TEXT NOT NULL,
  PRIMARY KEY (mail_id, thread_id)
);

CREATE INDEX mail_read_log_thread_idx ON mail_read_log (thread_id);

-- Mail a shared Thread claimed with wait_for_email: it arrived after the
-- call began, from the sender domain the call named.
CREATE TABLE mail_thread_claim (
  mail_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  PRIMARY KEY (mail_id, thread_id)
);

CREATE INDEX mail_thread_claim_thread_idx ON mail_thread_claim (thread_id);

-- "Always keep mail from this sender private."
CREATE TABLE mail_private_sender (
  user_id TEXT NOT NULL,
  address TEXT NOT NULL CHECK (address = lower(address) AND length(address) <= 320),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, address)
);

-- Every Message-ID received or sent in a Thread's email conversation, so
-- the owner's replies reach that Thread.
CREATE TABLE mail_reply_ref (
  owner_user_id TEXT NOT NULL,
  message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 998),
  thread_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_user_id, message_id)
);

CREATE INDEX mail_reply_ref_thread_idx ON mail_reply_ref (thread_id);

-- Every send a person makes: a 'pending' row reserves one of the day's sends
-- before the binding is called, so parallel sends can't pass the daily limit;
-- 'failed' rows over the daily threshold pause sending until they age out.
CREATE TABLE mail_send_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'sent', 'failed')),
  reason TEXT CHECK (reason IS NULL OR length(reason) <= 500)
);

CREATE INDEX mail_send_log_user_idx ON mail_send_log (user_id, at);

-- Usernames are dx Mailbox addresses (wiki/agent-mail.md), so they follow
-- mail rules:
--
-- * A person changes their username once. username_changed_at records that
--   change; everyone starts with NULL, so existing people get one change
--   too. A pick away from a `user-<24 hex>` placeholder or a reserved name
--   is free and leaves it NULL. A deployment admin can clear it again.
-- * A username a person leaves, by a change or by deleting the account, is
--   retired (retired_username, migration 0201): it keeps delivering to its
--   old owner and no one can ever take it. Reserved names are not retired;
--   they stay reserved.
-- * Sign-up never derives a reserved or retired name.
--
-- The reserved names match RESERVED_USERNAMES in
-- packages/domain/src/settings/personal-account.ts.

ALTER TABLE personal_account ADD COLUMN username_changed_at TEXT;

CREATE TRIGGER personal_account_retire_changed_username
AFTER UPDATE OF username ON personal_account
WHEN OLD.username <> NEW.username
  AND OLD.username NOT IN (
    'postmaster', 'abuse', 'hostmaster', 'webmaster', 'mailer-daemon',
    'root', 'admin', 'noreply', 'no-reply', 'support', 'security',
    'billing', 'dx', 'administrator'
  )
BEGIN
  INSERT OR IGNORE INTO retired_username (username, user_id, retired_at)
  VALUES (OLD.username, OLD.user_id, datetime('now'));
END;

CREATE TRIGGER personal_account_retire_deleted_username
AFTER DELETE ON personal_account
WHEN OLD.username NOT IN (
    'postmaster', 'abuse', 'hostmaster', 'webmaster', 'mailer-daemon',
    'root', 'admin', 'noreply', 'no-reply', 'support', 'security',
    'billing', 'dx', 'administrator'
  )
BEGIN
  INSERT OR IGNORE INTO retired_username (username, user_id, retired_at)
  VALUES (OLD.username, OLD.user_id, datetime('now'));
END;

-- Migration 0097's derivation, now skipping reserved and retired names.
DROP TRIGGER personal_account_after_user_insert;

CREATE TRIGGER personal_account_after_user_insert
AFTER INSERT ON "user"
BEGIN
  INSERT INTO personal_account (
    user_id,
    display_name,
    username,
    created_at,
    updated_at
  )
  SELECT
    NEW.id,
    CASE
      WHEN length(trim(NEW.name)) = 0 THEN 'User'
      ELSE substr(trim(NEW.name), 1, 128)
    END ,
    coalesce(
      (
        SELECT slug.base || suffix.digits
        FROM
          (
            SELECT rtrim(substr(trim(
              replace(replace(replace(
                replace(replace(
                  substr(address.local, 1, instr(address.local || '+', '+') - 1),
                  '.', '-'), '_', '-'),
                '--', '-'), '--', '-'), '--', '-'),
              '-'), 1, 29), '-') AS base
            FROM (
              SELECT lower(substr(NEW.email, 1, instr(NEW.email, '@') - 1))
                AS local
            ) AS address
          ) AS slug,
          (
            SELECT 0 AS preference, '' AS digits
            UNION ALL
            SELECT 1, 10 + (
              ifnull(unicode(substr(NEW.id, -1, 1)), 0) * 31
              + ifnull(unicode(substr(NEW.id, -2, 1)), 0)
            ) % 90
            UNION ALL
            SELECT 2, 100 + (
              ifnull(unicode(substr(NEW.id, -3, 1)), 0) * 961
              + ifnull(unicode(substr(NEW.id, -4, 1)), 0) * 31
              + ifnull(unicode(substr(NEW.id, -5, 1)), 0)
            ) % 900
            UNION ALL
            SELECT 3, 100 + (
              ifnull(unicode(substr(NEW.id, -6, 1)), 0) * 961
              + ifnull(unicode(substr(NEW.id, -7, 1)), 0) * 31
              + ifnull(unicode(substr(NEW.id, -8, 1)), 0)
            ) % 900
            UNION ALL
            SELECT 4, 100 + (
              ifnull(unicode(substr(NEW.id, -9, 1)), 0) * 961
              + ifnull(unicode(substr(NEW.id, -10, 1)), 0) * 31
              + ifnull(unicode(substr(NEW.id, -11, 1)), 0)
            ) % 900
          ) AS suffix
        WHERE slug.base <> ''
          AND slug.base NOT GLOB '*[^a-z0-9-]*'
          AND length(slug.base || suffix.digits) >= 3
          AND slug.base || suffix.digits NOT IN (
            'postmaster', 'abuse', 'hostmaster', 'webmaster', 'mailer-daemon',
            'root', 'admin', 'noreply', 'no-reply', 'support', 'security',
            'billing', 'dx', 'administrator'
          )
          AND NOT EXISTS (
            SELECT 1
            FROM personal_account AS taken
            WHERE taken.username = slug.base || suffix.digits
          )
          AND NOT EXISTS (
            SELECT 1
            FROM retired_username AS retired
            WHERE retired.username = slug.base || suffix.digits
          )
        ORDER BY suffix.preference
        LIMIT 1
      ),
      'user-' || lower(hex(randomblob(12)))
    ),
    datetime('now'),
    datetime('now');
END;
