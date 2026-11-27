-- Who set an automation up when it was not the owner: a Contribute member of
-- the shared Thread whose message started the turn. NULL means the owner.
-- A member's schedule or subscription pauses once their Contribute access
-- to its Thread ends, so it never keeps running as the owner (#2667).
ALTER TABLE thread_schedule ADD COLUMN created_by_user_id TEXT;
ALTER TABLE github_subscription ADD COLUMN created_by_user_id TEXT;
