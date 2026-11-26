-- An MCP request may now wait up to 5 minutes (wiki/mcp-deferred-work.md,
-- "Timeout"). timeout_ms keeps its 0011 CHECK (1 to 30 seconds): SQLite
-- changes a CHECK only by rebuilding the table, and dropping mcp_server
-- would cascade-delete every server's tools, tokens, header secrets, and
-- sign-ins. So the full value goes in this column, and timeout_ms holds it
-- capped at 30 seconds for code that still reads it. NULL means the row was
-- saved before this column existed; its timeout_ms is its value.
ALTER TABLE mcp_server ADD COLUMN request_timeout_ms INTEGER
  CHECK (
    request_timeout_ms IS NULL
      OR request_timeout_ms BETWEEN 1000 AND 300000
  );
