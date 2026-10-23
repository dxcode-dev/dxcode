-- A Thread family (a root Thread and its children) now shares as one unit:
-- sharing or unsharing any Thread in it applies to all of them, and a new
-- child starts with its family's sharing. Families shared before this had
-- only the Thread the owner shared; give every Thread in such a family the
-- most permissive sharing any of them has, so nobody loses access.
UPDATE threads
   SET (workspace_access, shared_workspace_id, contribute_until, visibility) = (
     SELECT source.workspace_access, source.shared_workspace_id,
            source.contribute_until, 'workspace'
       FROM threads AS source
      WHERE (source.id = COALESCE(threads.parent_thread_id, threads.id)
             OR source.parent_thread_id = COALESCE(threads.parent_thread_id, threads.id))
        AND source.owner_user_id = threads.owner_user_id
        AND source.lifecycle_state != 'deleted'
        AND source.workspace_access != 'none'
      ORDER BY source.workspace_access = 'contribute' DESC,
               source.contribute_until DESC,
               source.parent_thread_id IS NULL DESC
      LIMIT 1)
 WHERE lifecycle_state != 'deleted'
   AND EXISTS (
     SELECT 1 FROM threads AS source
      WHERE (source.id = COALESCE(threads.parent_thread_id, threads.id)
             OR source.parent_thread_id = COALESCE(threads.parent_thread_id, threads.id))
        AND source.owner_user_id = threads.owner_user_id
        AND source.lifecycle_state != 'deleted'
        AND source.workspace_access != 'none');
