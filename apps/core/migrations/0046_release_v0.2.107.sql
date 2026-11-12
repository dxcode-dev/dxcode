-- GitHub user-token renewal (#1953). GitHub App user tokens rotate like
-- Bitbucket's: a used refresh token, and the access token issued with it,
-- stop working. dx renews every active authorization on its own schedule,
-- server to server, through one Durable Object per authorization
-- (apps/core/src/source-control/github/token-renewal.ts), instead of inside
-- whichever request needed a token. These columns are that schedule and its
-- health:
--   next_renewal_at        when the cron next asks the authorization's object
--                          to renew: an hour before the access token expires,
--                          or a backoff after a failure. NULL means "derive
--                          from expires_at" (rows from before this migration).
--   last_renewed_at        the last committed rotation.
--   last_verified_at       the last rotation whose new access token GitHub
--                          accepted on an authenticated call.
--   renewal_failures       consecutive failed renewals; 0 when healthy.
--   renewal_failing_since  the first of those failures.
--   last_renewal_error     the last failure's category, never a secret.

ALTER TABLE github_user_authorization ADD COLUMN next_renewal_at TEXT;
ALTER TABLE github_user_authorization ADD COLUMN last_renewed_at TEXT;
ALTER TABLE github_user_authorization ADD COLUMN last_verified_at TEXT;
ALTER TABLE github_user_authorization ADD COLUMN renewal_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE github_user_authorization ADD COLUMN renewal_failing_since TEXT;
ALTER TABLE github_user_authorization ADD COLUMN last_renewal_error TEXT;

CREATE INDEX github_user_authorization_renewal_idx
  ON github_user_authorization(next_renewal_at) WHERE status = 'active';

-- Artifact saves no longer wake the agent (#1765, Notify agent graduated):
-- people reach it through Notify agent or a comment that mentions it, so the
-- per-Thread wake interval has nothing left to limit.
DROP TABLE IF EXISTS thread_artifact_wake;
