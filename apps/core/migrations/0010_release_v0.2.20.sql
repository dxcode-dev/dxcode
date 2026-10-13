-- A Claude Pro/Max connection's plan state: whether dx lets Claude Code keep
-- working on the plan's paid extra usage, and the latest plan limits that
-- Anthropic reported to a Claude Code run or title call. `usage` is the
-- domain's `ClaudePlanUsage` JSON.
CREATE TABLE claude_code_plan (
  connection_id TEXT NOT NULL PRIMARY KEY REFERENCES model_connection (id) ON DELETE CASCADE,
  allow_extra_usage INTEGER NOT NULL DEFAULT 0 CHECK (allow_extra_usage IN (0, 1)),
  usage TEXT CHECK (usage IS NULL OR (json_valid(usage) AND length(usage) <= 4096)),
  updated_at TEXT NOT NULL
);
