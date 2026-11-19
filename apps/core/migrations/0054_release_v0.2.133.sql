-- Skills from directories such as skills.sh carry many files: scripts,
-- references, and assets at any path in the skill's folder, and a SKILL.md
-- body as large as any of its files (1 MiB). A skill may now
-- hold 200 files of up to 1 MiB each and 5 MiB in all. A file larger than
-- 16 KiB keeps its content in R2 at skill-files/<sha256>, named by its
-- integrity so identical files share one object; its row's content is NULL.
--
-- A version also records where it came from: browser files, or a folder of
-- a public GitHub repository at one commit (source_json holds the
-- repository, path, commit, and the directory that listed it).
--
-- SQLite cannot change a CHECK constraint in place, and D1 cannot disable
-- foreign keys, so both tables are rebuilt: renamed aside (which rewrites
-- the foreign key between them), recreated, copied, then dropped leaf-first.
PRAGMA defer_foreign_keys = on;

ALTER TABLE skill_resource RENAME TO skill_resource_0200;
ALTER TABLE skill_version RENAME TO skill_version_0200;
DROP INDEX skill_version_integrity_uidx;

CREATE TABLE skill_version (
  skill_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 1024),
  instructions TEXT NOT NULL CHECK (length(instructions) BETWEEN 1 AND 1048576),
  manifest_json TEXT NOT NULL
    CHECK (length(manifest_json) BETWEEN 2 AND 16384)
    CHECK (json_valid(manifest_json) AND json_type(manifest_json) = 'object'),
  mcp_server_ids_json TEXT NOT NULL DEFAULT '[]'
    CHECK (length(mcp_server_ids_json) BETWEEN 2 AND 4096)
    CHECK (
      json_valid(mcp_server_ids_json)
      AND json_type(mcp_server_ids_json) = 'array'
      AND json_array_length(mcp_server_ids_json) <= 10
    ),
  source_type TEXT NOT NULL CHECK (source_type IN ('browser-files', 'github')),
  source_label TEXT NOT NULL CHECK (length(source_label) BETWEEN 1 AND 128),
  source_json TEXT
    CHECK (
      source_json IS NULL
      OR (
        length(source_json) <= 2048
        AND json_valid(source_json)
        AND json_type(source_json) = 'object'
      )
    ),
  integrity TEXT NOT NULL
    CHECK (length(integrity) = 64)
    CHECK (integrity NOT GLOB '*[^a-f0-9]*'),
  created_at TEXT NOT NULL,
  created_by_user_id TEXT NOT NULL REFERENCES "user" (id) ON DELETE RESTRICT,
  PRIMARY KEY (skill_id, version),
  FOREIGN KEY (skill_id) REFERENCES skill(id) ON DELETE CASCADE,
  CHECK ((source_type = 'github') = (source_json IS NOT NULL))
);

CREATE UNIQUE INDEX skill_version_integrity_uidx
  ON skill_version (skill_id, integrity);

INSERT INTO skill_version (
  skill_id, version, description, instructions, manifest_json,
  mcp_server_ids_json, source_type, source_label, source_json, integrity,
  created_at, created_by_user_id
)
SELECT skill_id, version, description, instructions, manifest_json,
       mcp_server_ids_json, source_type, source_label, NULL, integrity,
       created_at, created_by_user_id
  FROM skill_version_0200;

CREATE TABLE skill_resource (
  skill_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  path TEXT NOT NULL CHECK (length(path) BETWEEN 1 AND 256),
  media_type TEXT NOT NULL CHECK (length(media_type) BETWEEN 1 AND 128),
  -- NULL while the content is in R2 at skill-files/<integrity>.
  content TEXT CHECK (content IS NULL OR length(content) <= 1048576),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 0 AND 1048576),
  integrity TEXT NOT NULL
    CHECK (length(integrity) = 64)
    CHECK (integrity NOT GLOB '*[^a-f0-9]*'),
  PRIMARY KEY (skill_id, version, path),
  FOREIGN KEY (skill_id, version)
    REFERENCES skill_version(skill_id, version) ON DELETE CASCADE
);

INSERT INTO skill_resource (
  skill_id, version, path, media_type, content, size_bytes, integrity
)
SELECT skill_id, version, path, media_type, content, size_bytes, integrity
  FROM skill_resource_0200;

DROP TABLE skill_resource_0200;
DROP TABLE skill_version_0200;
