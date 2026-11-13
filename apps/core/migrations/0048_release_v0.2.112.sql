-- Standalone artifacts: an artifact made from the Artifacts library, not in
-- a Thread. Each one lives in its own artifact home, a Thread row marked
-- `artifact_home = 1` that holds exactly that artifact and nothing else: no
-- messages, no agent, no Orb. Revisions, comments, images, live drawing,
-- realtime, and sharing (`workspace_access`, per artifact) work as they do
-- for any Thread's artifacts. Homes never list as Threads; the Artifacts
-- library lists their artifacts instead. Deleting the artifact deletes its
-- home. See wiki/artifacts-library.md.
ALTER TABLE threads ADD COLUMN artifact_home INTEGER NOT NULL DEFAULT 0
  CHECK (artifact_home IN (0, 1));

-- The library reads a person's homes, newest first.
CREATE INDEX threads_artifact_home_idx
  ON threads (owner_user_id, updated_at DESC)
  WHERE artifact_home = 1;
