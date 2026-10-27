-- Uploaded pictures for people and workspaces, stored in DX_STORAGE under
-- avatars/. A person's upload takes precedence over their identity
-- provider's "user".image.
ALTER TABLE personal_account ADD COLUMN avatar_key TEXT
  CHECK (avatar_key IS NULL OR length(avatar_key) BETWEEN 1 AND 512);
ALTER TABLE organization ADD COLUMN avatar_key TEXT
  CHECK (avatar_key IS NULL OR length(avatar_key) BETWEEN 1 AND 512);
