-- A sign-in a Feedback Widget panel started: the challenge of the verifier
-- it keeps, for one widget. Consent is recorded only for a challenge started
-- here in the last ten minutes, and the grant is issued only for it, so a
-- link built with someone else's challenge cannot be allowed (#2406, #2420).
CREATE TABLE feedback_widget_sign_in (
  challenge TEXT NOT NULL PRIMARY KEY CHECK (length(challenge) = 64),
  client_id TEXT NOT NULL,
  started_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX feedback_widget_sign_in_started ON feedback_widget_sign_in (started_at);
