-- A Thread's color, chosen by its owner from the sidebar or Thread menu. NULL
-- means auto: clients derive an orb color from the Thread id and leave the
-- title uncolored. A chosen color tints both the orb and the title.
ALTER TABLE threads ADD COLUMN color TEXT
  CHECK (color IS NULL OR color IN (
    'gray', 'blue', 'purple', 'pink', 'red', 'orange', 'yellow', 'green', 'cyan'
  ));

-- Child Threads (0.2.10). A Thread the agent started with create_thread
-- records the Thread it was started from. Children never nest: a child that
-- starts another Thread gives it its own parent, so the new Thread is a
-- sibling. The sidebar lists a child under its parent while both are in the
-- same lifecycle state. Deleting the parent keeps the child as a top-level
-- Thread.
ALTER TABLE threads ADD COLUMN parent_thread_id TEXT
  REFERENCES threads (id) ON DELETE SET NULL;

CREATE INDEX threads_parent_idx ON threads (parent_thread_id, lifecycle_state)
  WHERE parent_thread_id IS NOT NULL;

-- The Thread whose agent sent a submission with a Thread tool (0.2.10).
-- Set only for a message sent while this Thread was working: Flue shows it
-- only once it joins the running turn, so clients show that a message from
-- this source is on its way until Flue's history holds the submission. The
-- message itself stays in Flue.
ALTER TABLE thread_activity_submission ADD COLUMN source_thread_id TEXT
  CHECK (source_thread_id IS NULL OR length(source_thread_id) BETWEEN 1 AND 128);

-- better-auth 1.7.7 finds an account by (providerId, accountId), as
-- Cloudflare Access sign-in does on every exchange. Only (issuer,
-- accountId) and userId were indexed, so each lookup scanned the table.
-- Not unique: uniqueness stays on (issuer, accountId).
CREATE INDEX "account_providerId_accountId_idx"
  ON "account" ("providerId", "accountId");
