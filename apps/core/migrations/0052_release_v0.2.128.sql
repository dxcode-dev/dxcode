-- Unsent text in every other composer, kept the way thread_draft keeps a
-- Thread's: per person, the same on each device, the last write wins, and
-- "" deletes the row.
--
-- thread_slot_draft: a box inside a Thread other than its composer, named by
-- its slot, such as the comment box under one Space post
-- ("post-comment:<message id>") or a Thread artifact's new comment
-- ("artifact-comment:<artifact id>"). It follows the Thread's access like
-- thread_draft: deleting the Thread cascades, and every change that takes
-- access away prunes it.
CREATE TABLE thread_slot_draft (
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (length(slot) BETWEEN 1 AND 200),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 65536),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  PRIMARY KEY (thread_id, user_id, slot)
) WITHOUT ROWID;
CREATE INDEX thread_slot_draft_user_idx ON thread_slot_draft (user_id);

-- workspace_draft: a composer that starts something in a workspace, before
-- any Thread exists: New Thread ("new-thread") and New Space ("new-space").
-- workspace_key is the workspace's id, or 'personal' outside any workspace.
-- Leaving or deleting the workspace prunes it.
CREATE TABLE workspace_draft (
  user_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL CHECK (length(workspace_key) BETWEEN 1 AND 128),
  slot TEXT NOT NULL CHECK (slot IN ('new-thread', 'new-space')),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 65536),
  updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 20 AND 40),
  PRIMARY KEY (user_id, workspace_key, slot)
) WITHOUT ROWID;
CREATE INDEX workspace_draft_workspace_idx ON workspace_draft (workspace_key);

CREATE TRIGGER composer_drafts_account_deleted
AFTER DELETE ON "user"
BEGIN
  DELETE FROM thread_slot_draft WHERE user_id = OLD.id;
  DELETE FROM workspace_draft WHERE user_id = OLD.id;
END;

-- A Thread keeps the workspace instructions it started with, as it keeps
-- its owner's personal instructions (`agent_instructions`): an admin's edit
-- reaches new Threads only, so an open Thread's prompt cache stays valid.
-- The Thread's insert copies the owner's active workspace's instructions.
ALTER TABLE threads
  ADD COLUMN workspace_agent_instructions TEXT NOT NULL DEFAULT '';

-- Threads that exist now keep what their agents read today; a deleted
-- Thread's tombstone keeps none.
UPDATE threads
   SET workspace_agent_instructions = (
     SELECT instructions.content
       FROM member
       JOIN organization ON organization.id = member.organizationId
                        AND organization.lifecycleState = 'active'
       JOIN workspace_agent_instructions AS instructions
         ON instructions.workspace_id = member.organizationId
      WHERE member.userId = threads.owner_user_id
   )
 WHERE lifecycle_state <> 'deleted'
   AND owner_user_id IN (
     SELECT member.userId
       FROM member
       JOIN organization ON organization.id = member.organizationId
                        AND organization.lifecycleState = 'active'
       JOIN workspace_agent_instructions AS instructions
         ON instructions.workspace_id = member.organizationId
   );

-- The model every thread a Space starts runs on, picked when the Space is
-- created or edited. NULL means the threads run on the Space's own model.
-- create_thread uses it whenever the Space's agent names no agent mode, so
-- the agent needs no instruction for it.
ALTER TABLE space ADD COLUMN thread_model TEXT;
ALTER TABLE space ADD COLUMN thread_thinking TEXT;

-- A person who is a collaborator on a repository in someone else's GitHub App
-- installation reaches it through a grant of their own on that installation,
-- limited to the repositories GitHub lists for their user token
-- (`GET /user/installations/{id}/repositories`). `installation` grants come
-- from installing the App and reach every repository it is entitled to;
-- `selected` grants reach only their rows in
-- `github_owner_repository_selection`.
ALTER TABLE github_owner_grant
  ADD COLUMN repository_scope TEXT NOT NULL DEFAULT 'installation'
    CHECK (repository_scope IN ('installation', 'selected'));

-- When the person's collaborator grants were last matched to GitHub, so the
-- Project list re-checks them at most once a minute.
ALTER TABLE github_user_authorization
  ADD COLUMN collaborator_grants_synced_at TEXT;
