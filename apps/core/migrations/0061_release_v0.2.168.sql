-- The Orb a new Claude Code Space's coordinator runs on, chosen in
-- Settings → Orb Providers: a person's own choice, else their workspace's.
-- runner_profile_id is an Orb size ID as the Orb picker names it (such as
-- e2b.small, or a deployment's named size); the Space's Thread pins it at
-- creation like any Thread, so a later change applies to new Spaces only.
-- target_id is the person's user ID (personal) or the workspace's ID.
CREATE TABLE IF NOT EXISTS space_coordinator_orb (
  scope TEXT NOT NULL CHECK (scope IN ('personal', 'workspace')),
  target_id TEXT NOT NULL CHECK (length(target_id) BETWEEN 1 AND 128),
  runner_profile_id TEXT NOT NULL CHECK (
    length(runner_profile_id) BETWEEN 1 AND 64
  ),
  updated_by TEXT NOT NULL CHECK (length(updated_by) BETWEEN 1 AND 128),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (scope, target_id)
);
