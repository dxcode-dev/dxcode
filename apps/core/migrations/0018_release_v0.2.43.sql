-- A Thread's source authority stays immutable except that its GitHub epochs
-- may move forward, when a reconcile confirms the same grant, installation,
-- and repository are live again (realignSourceAuthority in
-- src/source-control/github/control-plane.ts).
DROP TRIGGER thread_source_authority_immutable_update;
CREATE TRIGGER thread_source_authority_immutable_update BEFORE UPDATE ON thread_source_authority
WHEN NEW.thread_id IS NOT OLD.thread_id
  OR NEW.owner_grant_id IS NOT OLD.owner_grant_id
  OR NEW.installation_id IS NOT OLD.installation_id
  OR NEW.provider_workspace_id IS NOT OLD.provider_workspace_id
  OR NEW.provider_repository_id IS NOT OLD.provider_repository_id
  OR NEW.policy_revision IS NOT OLD.policy_revision
  OR NEW.private_submodule_repository_ids_json IS NOT OLD.private_submodule_repository_ids_json
  OR NEW.installation_id IS NULL
  OR NEW.authorization_epoch < OLD.authorization_epoch
  OR NEW.installation_epoch < OLD.installation_epoch
BEGIN SELECT RAISE(ABORT, 'thread source authority is immutable'); END;

-- Accepting new GitHub App permissions used to advance every grant and
-- installation epoch, which left every GitHub Project and Thread refusing
-- its source until a manual rebind. Realign the copies whose grant is still
-- active, whose installation is active, and whose repository is still
-- entitled. Workspace policy revisions are not realigned.
UPDATE project_source_authority
   SET authorization_epoch = COALESCE((SELECT epoch FROM github_authorization_epoch
         WHERE subject_kind = 'owner-grant'
           AND subject_id = project_source_authority.owner_grant_id), 1),
       installation_epoch = COALESCE((SELECT epoch FROM github_authorization_epoch
         WHERE subject_kind = 'installation'
           AND subject_id = project_source_authority.installation_id), 1),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE provider = 'github' AND provenance = 'live-grant'
   AND provider_repository_id IN (
     SELECT provider_repository_id FROM github_installation_repository
      WHERE installation_id = project_source_authority.installation_id AND entitled = 1)
   AND EXISTS (SELECT 1 FROM github_owner_grant
      WHERE id = project_source_authority.owner_grant_id
        AND installation_id = project_source_authority.installation_id
        AND status = 'active')
   AND EXISTS (SELECT 1 FROM github_installation
      WHERE installation_id = project_source_authority.installation_id
        AND status = 'active')
   AND (authorization_epoch < COALESCE((SELECT epoch FROM github_authorization_epoch
          WHERE subject_kind = 'owner-grant'
            AND subject_id = project_source_authority.owner_grant_id), 1)
     OR installation_epoch < COALESCE((SELECT epoch FROM github_authorization_epoch
          WHERE subject_kind = 'installation'
            AND subject_id = project_source_authority.installation_id), 1));

UPDATE thread_source_authority
   SET authorization_epoch = COALESCE((SELECT epoch FROM github_authorization_epoch
         WHERE subject_kind = 'owner-grant'
           AND subject_id = thread_source_authority.owner_grant_id), 1),
       installation_epoch = COALESCE((SELECT epoch FROM github_authorization_epoch
         WHERE subject_kind = 'installation'
           AND subject_id = thread_source_authority.installation_id), 1)
 WHERE installation_id IS NOT NULL
   AND provider_repository_id IN (
     SELECT provider_repository_id FROM github_installation_repository
      WHERE installation_id = thread_source_authority.installation_id AND entitled = 1)
   AND EXISTS (SELECT 1 FROM github_owner_grant
      WHERE id = thread_source_authority.owner_grant_id
        AND installation_id = thread_source_authority.installation_id
        AND status = 'active')
   AND EXISTS (SELECT 1 FROM github_installation
      WHERE installation_id = thread_source_authority.installation_id
        AND status = 'active')
   AND (authorization_epoch < COALESCE((SELECT epoch FROM github_authorization_epoch
          WHERE subject_kind = 'owner-grant'
            AND subject_id = thread_source_authority.owner_grant_id), 1)
     OR installation_epoch < COALESCE((SELECT epoch FROM github_authorization_epoch
          WHERE subject_kind = 'installation'
            AND subject_id = thread_source_authority.installation_id), 1));
