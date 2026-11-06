-- Composer quick actions picked at turn end (experimental).
--
-- When the agent completes a turn in a Thread where someone has the
-- `composer-quick-actions` flag on, the turn-end hook asks Clef Flash which
-- actions to show after the agent message that ended it, and keeps the
-- pick here, one row per Thread, replaced by the next turn's. `actions` is
-- a JSON array in Clef's order of {"kind":"reply","text"} and
-- {"kind":"snooze"}; an empty array means Clef offered nothing or did not
-- answer. Only the hook writes rows; the quick-actions route only reads
-- them. Additive: no existing table changes.
CREATE TABLE thread_quick_actions (
  thread_id TEXT PRIMARY KEY REFERENCES threads (id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  actions TEXT NOT NULL CHECK (json_valid(actions)),
  picked_at TEXT NOT NULL
) WITHOUT ROWID;

-- Feedback Widget (experimental): a script a website embeds so people send
-- comments on its elements to a new Thread in the Project. `client_id` is the
-- public ID in the script's address; it is NULL while the widget is off, and
-- turning it on again issues a new one. Allowed origins stay when it is off.
CREATE TABLE project_feedback_widget (
  project_id TEXT NOT NULL PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  client_id TEXT UNIQUE CHECK (client_id IS NULL OR length(client_id) BETWEEN 20 AND 64),
  enabled_by_user_id TEXT,
  enabled_at TEXT,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

-- Scheme, host, and port only: https, or http on a loopback host.
CREATE TABLE project_feedback_widget_origin (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK (
    length(origin) BETWEEN 10 AND 300
    AND (substr(origin, 1, 8) = 'https://' OR substr(origin, 1, 7) = 'http://')
    AND instr(substr(origin, 9), '/') = 0
  ),
  created_at TEXT NOT NULL,
  PRIMARY KEY (project_id, origin)
) WITHOUT ROWID;

-- A person's consent in the sign-in popup, waiting for the widget panel that
-- asked for it to claim it with the verifier only that panel holds. Claiming
-- mints the grant; unclaimed rows expire after ten minutes.
CREATE TABLE feedback_widget_authorization (
  challenge TEXT NOT NULL PRIMARY KEY CHECK (length(challenge) = 64),
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  approved_at TEXT NOT NULL,
  claimed_at TEXT
) WITHOUT ROWID;

-- The token a person's widget panel sends with each request, stored as its
-- SHA-256. Turning the widget off deletes every grant for it.
CREATE TABLE feedback_widget_grant (
  token_sha256 TEXT NOT NULL PRIMARY KEY CHECK (length(token_sha256) = 64),
  client_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
) WITHOUT ROWID;

CREATE INDEX feedback_widget_grant_client ON feedback_widget_grant (client_id);
CREATE INDEX feedback_widget_grant_project ON feedback_widget_grant (project_id);

-- Feedback Widget on dx itself (experimental): the widget script a person
-- chose to load in this dx app, from this dx or another dx host. Its client
-- ID names the Project that receives what they send. One per person.
CREATE TABLE personal_feedback_widget_embed (
  user_id TEXT NOT NULL PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
  script_url TEXT NOT NULL CHECK (
    length(script_url) BETWEEN 40 AND 400
    AND (substr(script_url, 1, 8) = 'https://' OR substr(script_url, 1, 7) = 'http://')
  ),
  updated_at TEXT NOT NULL
) WITHOUT ROWID;
