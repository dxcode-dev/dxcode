-- Bitbucket token renewal (#1952). Bitbucket refresh tokens are single-use
-- since CHANGE-3052, so dx renews every active connection on its own
-- schedule, server to server, through one Durable Object per connection
-- (apps/core/src/source-control/bitbucket/token-renewal.ts), instead of
-- inside whichever request needed a token. These columns are that schedule
-- and its health:
--   next_renewal_at        when the cron next asks the connection's object to
--                          renew: 30 minutes before the access token expires,
--                          or a backoff after a failure. NULL means "derive
--                          from expires_at" (rows from before this migration).
--   last_renewed_at        the last committed rotation.
--   last_verified_at       the last rotation whose new access token Bitbucket
--                          accepted on an authenticated call.
--   renewal_failures       consecutive failed renewals; 0 when healthy.
--   renewal_failing_since  the first of those failures, which Settings shows
--                          as a warning before any reconnect is needed.
--   last_renewal_error     the last failure's category, never a secret.
-- refresh_lock_id and refresh_lock_until are no longer used.

ALTER TABLE bitbucket_connection ADD COLUMN next_renewal_at TEXT;
ALTER TABLE bitbucket_connection ADD COLUMN last_renewed_at TEXT;
ALTER TABLE bitbucket_connection ADD COLUMN last_verified_at TEXT;
ALTER TABLE bitbucket_connection ADD COLUMN renewal_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE bitbucket_connection ADD COLUMN renewal_failing_since TEXT;
ALTER TABLE bitbucket_connection ADD COLUMN last_renewal_error TEXT;

CREATE INDEX bitbucket_connection_renewal_idx
  ON bitbucket_connection(next_renewal_at) WHERE status = 'active';
