-- How many of a model call's cache-write tokens were written with Anthropic's
-- 1-hour TTL (#1760). Anthropic bills them at 2x input instead of the 5-minute
-- rate, so the cost snapshot prices them apart. NULL when the provider reports
-- no split, as for every event recorded before this column.
ALTER TABLE usage_event ADD COLUMN cache_write_1h_tokens INTEGER
  CHECK (cache_write_1h_tokens IS NULL OR cache_write_1h_tokens >= 0);
