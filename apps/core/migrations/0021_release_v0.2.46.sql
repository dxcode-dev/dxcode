-- A Thread keeps its repository for life, but the connection that reaches it
-- may change: after a disconnect and reconnect, a reconnect with another
-- account that can reach the same repository, or a reinstalled GitHub App,
-- healThreadSourceAuthority (src/source-control/heal.ts) moves the Thread to
-- its owner's live connection. The repository, workspace, policy revision,
-- and private submodules never change; the provider never changes; the new
-- connection must belong to the Thread's owner; and with the same connection
-- the epochs only move forward.
DROP TRIGGER thread_source_authority_immutable_update;
CREATE TRIGGER thread_source_authority_immutable_update BEFORE UPDATE ON thread_source_authority
WHEN NEW.thread_id IS NOT OLD.thread_id
  OR NEW.provider_workspace_id IS NOT OLD.provider_workspace_id
  OR NEW.provider_repository_id IS NOT OLD.provider_repository_id
  OR NEW.policy_revision IS NOT OLD.policy_revision
  OR NEW.private_submodule_repository_ids_json IS NOT OLD.private_submodule_repository_ids_json
  OR (NEW.installation_id IS NULL) IS NOT (OLD.installation_id IS NULL)
  OR (NEW.owner_grant_id IS OLD.owner_grant_id
    AND (NEW.installation_id IS NOT OLD.installation_id
      OR NEW.authorization_epoch < OLD.authorization_epoch
      OR NEW.installation_epoch < OLD.installation_epoch))
  OR (NEW.owner_grant_id IS NOT OLD.owner_grant_id AND NOT (
    (NEW.installation_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM github_owner_grant AS grant_row
        JOIN threads AS thread ON thread.id = NEW.thread_id
       WHERE grant_row.id = NEW.owner_grant_id
         AND grant_row.installation_id = NEW.installation_id
         AND grant_row.owner_scope = 'personal'
         AND grant_row.owner_id = thread.owner_user_id))
    OR (NEW.installation_id IS NULL AND EXISTS (
      SELECT 1 FROM bitbucket_connection AS connection
        JOIN threads AS thread ON thread.id = NEW.thread_id
       WHERE connection.id = NEW.owner_grant_id
         AND connection.user_id = thread.owner_user_id))))
BEGIN SELECT RAISE(ABORT, 'thread source authority is immutable'); END;
