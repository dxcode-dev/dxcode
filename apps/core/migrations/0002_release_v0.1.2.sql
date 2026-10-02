-- Bitbucket gateway leases authorize the Thread owner's Bitbucket connection,
-- not one repository: the gateway takes the repository from the request path
-- and Bitbucket decides access. Rebuild the lease table without repository,
-- binding, and branch columns, keeping live leases. Leases last three minutes;
-- dropping the old table cascades only its equally short-lived LFS actions.
CREATE TABLE bitbucket_git_lease_0059 (
  id_hash TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  authorization_epoch INTEGER NOT NULL,
  operation TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(connection_id) REFERENCES bitbucket_connection(id)
);

INSERT INTO bitbucket_git_lease_0059 (
  id_hash, thread_id, actor_user_id, connection_id, authorization_epoch,
  operation, expires_at, created_at
)
SELECT
  id_hash, thread_id, actor_user_id, connection_id, authorization_epoch,
  operation, expires_at, created_at
FROM bitbucket_git_lease;

DROP TABLE bitbucket_git_lease;
ALTER TABLE bitbucket_git_lease_0059 RENAME TO bitbucket_git_lease;

CREATE INDEX bitbucket_git_lease_expiry_idx
  ON bitbucket_git_lease(expires_at);

-- While DxTitleAgent generates a new Thread's title, clients show a loading
-- state instead of the stored fallback title. The deadline bounds that state
-- even when the background job never finishes. NULL means the title is final.
ALTER TABLE threads
  ADD COLUMN title_pending_until TEXT
  CHECK (title_pending_until IS NULL OR length(title_pending_until) BETWEEN 20 AND 40);
