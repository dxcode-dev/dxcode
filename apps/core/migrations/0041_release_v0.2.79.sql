-- Workspace usage rollups (#1933). The workspace usage page summed every
-- usage_event row of the workspace in its range about ten times, 0.5-0.9M D1
-- rows per load, and overloaded D1 for the whole app. Migration 0125's
-- rollups are keyed by owner; these two are keyed by workspace, member,
-- Project, and Thread, so the page reads one row per Thread, kind, model,
-- price, and runner per UTC day (or hour), and raw events only for the edges
-- a bucket cannot answer (apps/core/src/settings/usage/workspace-rollup-d1.ts).
--
-- Keys and sums are migration 0125's, with the same NULL encodings; events
-- without a workspace_id belong to no workspace page and are left out.
-- Triggers keep both tables exact as 0125's do: AFTER INSERT adds each event
-- actually inserted, AFTER DELETE takes back each event retention deletes.
-- usage_event is immutable; a migration that updates its rows must rebuild
-- these tables.

CREATE TABLE usage_workspace_daily (
  workspace_id TEXT NOT NULL,
  -- The UTC day's start, 'YYYY-MM-DDT00:00:00.000Z'.
  day TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  price_source TEXT NOT NULL,
  price_source_version TEXT NOT NULL,
  price_fresh_until TEXT NOT NULL,
  runner_provider TEXT NOT NULL,
  runner_profile_id TEXT NOT NULL,
  runner_profile_version INTEGER NOT NULL,
  runner_template TEXT NOT NULL,
  runner_cpu_cores REAL NOT NULL,
  runner_memory_mb INTEGER NOT NULL,
  runner_disk_gb INTEGER NOT NULL,
  events INTEGER NOT NULL,
  success_events INTEGER NOT NULL,
  error_events INTEGER NOT NULL,
  cancelled_events INTEGER NOT NULL,
  unknown_outcome_events INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  reasoning_events INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  unknown_token_events INTEGER NOT NULL,
  estimated_cost_micros INTEGER NOT NULL,
  known_cost_events INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  duration_events INTEGER NOT NULL,
  -- The earliest and latest occurred_at added. Retention leaves them as they
  -- were, so they bound the bucket's events from outside.
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  PRIMARY KEY (
    workspace_id, day, owner_user_id, project_id, thread_id, kind,
    provider_id, model_id, price_source, price_source_version, price_fresh_until,
    runner_provider, runner_profile_id, runner_profile_version, runner_template,
    runner_cpu_cores, runner_memory_mb, runner_disk_gb
  )
) WITHOUT ROWID;

CREATE TABLE usage_workspace_hourly (
  workspace_id TEXT NOT NULL,
  -- The UTC hour's start, 'YYYY-MM-DDTHH:00:00.000Z'.
  hour TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  price_source TEXT NOT NULL,
  price_source_version TEXT NOT NULL,
  price_fresh_until TEXT NOT NULL,
  runner_provider TEXT NOT NULL,
  runner_profile_id TEXT NOT NULL,
  runner_profile_version INTEGER NOT NULL,
  runner_template TEXT NOT NULL,
  runner_cpu_cores REAL NOT NULL,
  runner_memory_mb INTEGER NOT NULL,
  runner_disk_gb INTEGER NOT NULL,
  events INTEGER NOT NULL,
  success_events INTEGER NOT NULL,
  error_events INTEGER NOT NULL,
  cancelled_events INTEGER NOT NULL,
  unknown_outcome_events INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  reasoning_tokens INTEGER NOT NULL,
  reasoning_events INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  unknown_token_events INTEGER NOT NULL,
  estimated_cost_micros INTEGER NOT NULL,
  known_cost_events INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  duration_events INTEGER NOT NULL,
  -- The earliest and latest occurred_at added. Retention leaves them as they
  -- were, so they bound the bucket's events from outside.
  first_at TEXT NOT NULL,
  last_at TEXT NOT NULL,
  PRIMARY KEY (
    workspace_id, hour, owner_user_id, project_id, thread_id, kind,
    provider_id, model_id, price_source, price_source_version, price_fresh_until,
    runner_provider, runner_profile_id, runner_profile_version, runner_template,
    runner_cpu_cores, runner_memory_mb, runner_disk_gb
  )
) WITHOUT ROWID;

-- The listed Threads' hours of model use, for the activity strip. It holds
-- the two sums the strip shows, so a read never visits the table.
CREATE INDEX usage_workspace_hourly_thread_idx
  ON usage_workspace_hourly (
    workspace_id, thread_id, kind, hour, total_tokens, estimated_cost_micros
  );

-- Events already stored are added by the Worker's cron in rowid chunks, as
-- for migration 0125: until the backfill reaches end_rowid, the workspace
-- page reads raw events. An event is in these rollups exactly when its rowid
-- is above end_rowid or at most through_rowid.
CREATE TABLE usage_workspace_rollup_backfill (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  through_rowid INTEGER NOT NULL,
  end_rowid INTEGER NOT NULL
);

INSERT INTO usage_workspace_rollup_backfill (singleton, through_rowid, end_rowid)
VALUES (1, 0, COALESCE((SELECT MAX(rowid) FROM usage_event), 0));

CREATE TRIGGER usage_event_workspace_rollup_insert
AFTER INSERT ON usage_event
WHEN NEW.workspace_id IS NOT NULL
  AND (NEW.rowid > (SELECT end_rowid FROM usage_workspace_rollup_backfill)
    OR NEW.rowid <= (SELECT through_rowid FROM usage_workspace_rollup_backfill))
BEGIN
  INSERT INTO usage_workspace_daily VALUES (
    NEW.workspace_id,
    substr(NEW.occurred_at, 1, 10) || 'T00:00:00.000Z',
    NEW.owner_user_id,
    NEW.project_id,
    NEW.thread_id,
    NEW.kind,
    COALESCE(NEW.observed_provider_id, NEW.provider_id),
    COALESCE(NEW.observed_model_id, NEW.model_id),
    CASE WHEN NEW.price_status = 'fresh' THEN COALESCE(NEW.price_source, '') ELSE '' END ,
    CASE WHEN NEW.price_status = 'fresh' THEN COALESCE(NEW.price_source_version, '') ELSE '' END ,
    CASE WHEN NEW.price_status = 'fresh' THEN COALESCE(NEW.price_fresh_until, '') ELSE '' END ,
    CASE WHEN NEW.kind = 'runner' THEN COALESCE(NEW.runner_provider, '') ELSE '' END ,
    CASE WHEN NEW.kind = 'runner' THEN json_quote(NEW.runner_profile_id) ELSE '' END ,
    CASE WHEN NEW.kind = 'runner' THEN COALESCE(NEW.runner_profile_version, -1) ELSE -1 END ,
    CASE WHEN NEW.kind = 'runner' THEN COALESCE(NEW.runner_template, '') ELSE '' END ,
    CASE WHEN NEW.kind = 'runner' THEN COALESCE(NEW.runner_cpu_cores, -1) ELSE -1 END ,
    CASE WHEN NEW.kind = 'runner' THEN COALESCE(NEW.runner_memory_mb, -1) ELSE -1 END ,
    CASE WHEN NEW.kind = 'runner' THEN COALESCE(NEW.runner_disk_gb, -1) ELSE -1 END ,
    1,
    NEW.outcome = 'success',
    NEW.outcome = 'error',
    NEW.outcome = 'cancelled',
    NEW.outcome = 'unknown',
    COALESCE(NEW.input_tokens, 0),
    COALESCE(NEW.output_tokens, 0),
    COALESCE(NEW.cache_read_tokens, 0),
    COALESCE(NEW.cache_write_tokens, 0),
    COALESCE(NEW.reasoning_tokens, 0),
    NEW.reasoning_tokens IS NOT NULL,
    COALESCE(NEW.total_tokens, 0),
    NEW.total_tokens IS NULL,
    COALESCE(NEW.estimated_cost_micros_snapshot, 0),
    NEW.estimated_cost_micros_snapshot IS NOT NULL,
    COALESCE(NEW.duration_ms, 0),
    NEW.duration_ms IS NOT NULL,
    NEW.occurred_at,
    NEW.occurred_at
  )
  ON CONFLICT DO UPDATE SET
    events = events + excluded.events,
    success_events = success_events + excluded.success_events,
    error_events = error_events + excluded.error_events,
    cancelled_events = cancelled_events + excluded.cancelled_events,
    unknown_outcome_events = unknown_outcome_events + excluded.unknown_outcome_events,
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
    reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
    reasoning_events = reasoning_events + excluded.reasoning_events,
    total_tokens = total_tokens + excluded.total_tokens,
    unknown_token_events = unknown_token_events + excluded.unknown_token_events,
    estimated_cost_micros = estimated_cost_micros + excluded.estimated_cost_micros,
    known_cost_events = known_cost_events + excluded.known_cost_events,
    duration_ms = duration_ms + excluded.duration_ms,
    duration_events = duration_events + excluded.duration_events,
    first_at = min(first_at, excluded.first_at),
    last_at = max(last_at, excluded.last_at);
  INSERT INTO usage_workspace_hourly VALUES (
    NEW.workspace_id,
    substr(NEW.occurred_at, 1, 13) || ':00:00.000Z',
    NEW.owner_user_id,
    NEW.project_id,
    NEW.thread_id,
    NEW.kind,
    COALESCE(NEW.observed_provider_id, NEW.provider_id),
    COALESCE(NEW.observed_model_id, NEW.model_id),
    CASE WHEN NEW.price_status = 'fresh' THEN COALESCE(NEW.price_source, '') ELSE '' END ,
    CASE WHEN NEW.price_status = 'fresh' THEN COALESCE(NEW.price_source_version, '') ELSE '' END ,
    CASE WHEN NEW.price_status = 'fresh' THEN COALESCE(NEW.price_fresh_until, '') ELSE '' END ,
    CASE WHEN NEW.kind = 'runner' THEN COALESCE(NEW.runner_provider, '') ELSE '' END ,
    CASE WHEN NEW.kind = 'runner' THEN json_quote(NEW.runner_profile_id) ELSE '' END ,
    CASE WHEN NEW.kind = 'runner' THEN COALESCE(NEW.runner_profile_version, -1) ELSE -1 END ,
    CASE WHEN NEW.kind = 'runner' THEN COALESCE(NEW.runner_template, '') ELSE '' END ,
    CASE WHEN NEW.kind = 'runner' THEN COALESCE(NEW.runner_cpu_cores, -1) ELSE -1 END ,
    CASE WHEN NEW.kind = 'runner' THEN COALESCE(NEW.runner_memory_mb, -1) ELSE -1 END ,
    CASE WHEN NEW.kind = 'runner' THEN COALESCE(NEW.runner_disk_gb, -1) ELSE -1 END ,
    1,
    NEW.outcome = 'success',
    NEW.outcome = 'error',
    NEW.outcome = 'cancelled',
    NEW.outcome = 'unknown',
    COALESCE(NEW.input_tokens, 0),
    COALESCE(NEW.output_tokens, 0),
    COALESCE(NEW.cache_read_tokens, 0),
    COALESCE(NEW.cache_write_tokens, 0),
    COALESCE(NEW.reasoning_tokens, 0),
    NEW.reasoning_tokens IS NOT NULL,
    COALESCE(NEW.total_tokens, 0),
    NEW.total_tokens IS NULL,
    COALESCE(NEW.estimated_cost_micros_snapshot, 0),
    NEW.estimated_cost_micros_snapshot IS NOT NULL,
    COALESCE(NEW.duration_ms, 0),
    NEW.duration_ms IS NOT NULL,
    NEW.occurred_at,
    NEW.occurred_at
  )
  ON CONFLICT DO UPDATE SET
    events = events + excluded.events,
    success_events = success_events + excluded.success_events,
    error_events = error_events + excluded.error_events,
    cancelled_events = cancelled_events + excluded.cancelled_events,
    unknown_outcome_events = unknown_outcome_events + excluded.unknown_outcome_events,
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
    reasoning_tokens = reasoning_tokens + excluded.reasoning_tokens,
    reasoning_events = reasoning_events + excluded.reasoning_events,
    total_tokens = total_tokens + excluded.total_tokens,
    unknown_token_events = unknown_token_events + excluded.unknown_token_events,
    estimated_cost_micros = estimated_cost_micros + excluded.estimated_cost_micros,
    known_cost_events = known_cost_events + excluded.known_cost_events,
    duration_ms = duration_ms + excluded.duration_ms,
    duration_events = duration_events + excluded.duration_events,
    first_at = min(first_at, excluded.first_at),
    last_at = max(last_at, excluded.last_at);
END;

CREATE TRIGGER usage_event_workspace_rollup_delete
AFTER DELETE ON usage_event
WHEN OLD.workspace_id IS NOT NULL
  AND (OLD.rowid > (SELECT end_rowid FROM usage_workspace_rollup_backfill)
    OR OLD.rowid <= (SELECT through_rowid FROM usage_workspace_rollup_backfill))
BEGIN
  UPDATE usage_workspace_daily SET
    events = events - 1,
    success_events = success_events - (OLD.outcome = 'success'),
    error_events = error_events - (OLD.outcome = 'error'),
    cancelled_events = cancelled_events - (OLD.outcome = 'cancelled'),
    unknown_outcome_events = unknown_outcome_events - (OLD.outcome = 'unknown'),
    input_tokens = input_tokens - COALESCE(OLD.input_tokens, 0),
    output_tokens = output_tokens - COALESCE(OLD.output_tokens, 0),
    cache_read_tokens = cache_read_tokens - COALESCE(OLD.cache_read_tokens, 0),
    cache_write_tokens = cache_write_tokens - COALESCE(OLD.cache_write_tokens, 0),
    reasoning_tokens = reasoning_tokens - COALESCE(OLD.reasoning_tokens, 0),
    reasoning_events = reasoning_events - (OLD.reasoning_tokens IS NOT NULL),
    total_tokens = total_tokens - COALESCE(OLD.total_tokens, 0),
    unknown_token_events = unknown_token_events - (OLD.total_tokens IS NULL),
    estimated_cost_micros = estimated_cost_micros - COALESCE(OLD.estimated_cost_micros_snapshot, 0),
    known_cost_events = known_cost_events - (OLD.estimated_cost_micros_snapshot IS NOT NULL),
    duration_ms = duration_ms - COALESCE(OLD.duration_ms, 0),
    duration_events = duration_events - (OLD.duration_ms IS NOT NULL)
  WHERE workspace_id = OLD.workspace_id
    AND day = substr(OLD.occurred_at, 1, 10) || 'T00:00:00.000Z'
    AND owner_user_id = OLD.owner_user_id
    AND project_id = OLD.project_id
    AND thread_id = OLD.thread_id
    AND kind = OLD.kind
    AND provider_id = COALESCE(OLD.observed_provider_id, OLD.provider_id)
    AND model_id = COALESCE(OLD.observed_model_id, OLD.model_id)
    AND price_source = CASE WHEN OLD.price_status = 'fresh' THEN COALESCE(OLD.price_source, '') ELSE '' END
    AND price_source_version = CASE WHEN OLD.price_status = 'fresh' THEN COALESCE(OLD.price_source_version, '') ELSE '' END
    AND price_fresh_until = CASE WHEN OLD.price_status = 'fresh' THEN COALESCE(OLD.price_fresh_until, '') ELSE '' END
    AND runner_provider = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_provider, '') ELSE '' END
    AND runner_profile_id = CASE WHEN OLD.kind = 'runner' THEN json_quote(OLD.runner_profile_id) ELSE '' END
    AND runner_profile_version = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_profile_version, -1) ELSE -1 END
    AND runner_template = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_template, '') ELSE '' END
    AND runner_cpu_cores = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_cpu_cores, -1) ELSE -1 END
    AND runner_memory_mb = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_memory_mb, -1) ELSE -1 END
    AND runner_disk_gb = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_disk_gb, -1) ELSE -1 END;
  DELETE FROM usage_workspace_daily
  WHERE workspace_id = OLD.workspace_id
    AND day = substr(OLD.occurred_at, 1, 10) || 'T00:00:00.000Z'
    AND owner_user_id = OLD.owner_user_id
    AND project_id = OLD.project_id
    AND thread_id = OLD.thread_id
    AND kind = OLD.kind
    AND provider_id = COALESCE(OLD.observed_provider_id, OLD.provider_id)
    AND model_id = COALESCE(OLD.observed_model_id, OLD.model_id)
    AND price_source = CASE WHEN OLD.price_status = 'fresh' THEN COALESCE(OLD.price_source, '') ELSE '' END
    AND price_source_version = CASE WHEN OLD.price_status = 'fresh' THEN COALESCE(OLD.price_source_version, '') ELSE '' END
    AND price_fresh_until = CASE WHEN OLD.price_status = 'fresh' THEN COALESCE(OLD.price_fresh_until, '') ELSE '' END
    AND runner_provider = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_provider, '') ELSE '' END
    AND runner_profile_id = CASE WHEN OLD.kind = 'runner' THEN json_quote(OLD.runner_profile_id) ELSE '' END
    AND runner_profile_version = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_profile_version, -1) ELSE -1 END
    AND runner_template = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_template, '') ELSE '' END
    AND runner_cpu_cores = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_cpu_cores, -1) ELSE -1 END
    AND runner_memory_mb = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_memory_mb, -1) ELSE -1 END
    AND runner_disk_gb = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_disk_gb, -1) ELSE -1 END
    AND events = 0;
  UPDATE usage_workspace_hourly SET
    events = events - 1,
    success_events = success_events - (OLD.outcome = 'success'),
    error_events = error_events - (OLD.outcome = 'error'),
    cancelled_events = cancelled_events - (OLD.outcome = 'cancelled'),
    unknown_outcome_events = unknown_outcome_events - (OLD.outcome = 'unknown'),
    input_tokens = input_tokens - COALESCE(OLD.input_tokens, 0),
    output_tokens = output_tokens - COALESCE(OLD.output_tokens, 0),
    cache_read_tokens = cache_read_tokens - COALESCE(OLD.cache_read_tokens, 0),
    cache_write_tokens = cache_write_tokens - COALESCE(OLD.cache_write_tokens, 0),
    reasoning_tokens = reasoning_tokens - COALESCE(OLD.reasoning_tokens, 0),
    reasoning_events = reasoning_events - (OLD.reasoning_tokens IS NOT NULL),
    total_tokens = total_tokens - COALESCE(OLD.total_tokens, 0),
    unknown_token_events = unknown_token_events - (OLD.total_tokens IS NULL),
    estimated_cost_micros = estimated_cost_micros - COALESCE(OLD.estimated_cost_micros_snapshot, 0),
    known_cost_events = known_cost_events - (OLD.estimated_cost_micros_snapshot IS NOT NULL),
    duration_ms = duration_ms - COALESCE(OLD.duration_ms, 0),
    duration_events = duration_events - (OLD.duration_ms IS NOT NULL)
  WHERE workspace_id = OLD.workspace_id
    AND hour = substr(OLD.occurred_at, 1, 13) || ':00:00.000Z'
    AND owner_user_id = OLD.owner_user_id
    AND project_id = OLD.project_id
    AND thread_id = OLD.thread_id
    AND kind = OLD.kind
    AND provider_id = COALESCE(OLD.observed_provider_id, OLD.provider_id)
    AND model_id = COALESCE(OLD.observed_model_id, OLD.model_id)
    AND price_source = CASE WHEN OLD.price_status = 'fresh' THEN COALESCE(OLD.price_source, '') ELSE '' END
    AND price_source_version = CASE WHEN OLD.price_status = 'fresh' THEN COALESCE(OLD.price_source_version, '') ELSE '' END
    AND price_fresh_until = CASE WHEN OLD.price_status = 'fresh' THEN COALESCE(OLD.price_fresh_until, '') ELSE '' END
    AND runner_provider = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_provider, '') ELSE '' END
    AND runner_profile_id = CASE WHEN OLD.kind = 'runner' THEN json_quote(OLD.runner_profile_id) ELSE '' END
    AND runner_profile_version = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_profile_version, -1) ELSE -1 END
    AND runner_template = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_template, '') ELSE '' END
    AND runner_cpu_cores = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_cpu_cores, -1) ELSE -1 END
    AND runner_memory_mb = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_memory_mb, -1) ELSE -1 END
    AND runner_disk_gb = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_disk_gb, -1) ELSE -1 END;
  DELETE FROM usage_workspace_hourly
  WHERE workspace_id = OLD.workspace_id
    AND hour = substr(OLD.occurred_at, 1, 13) || ':00:00.000Z'
    AND owner_user_id = OLD.owner_user_id
    AND project_id = OLD.project_id
    AND thread_id = OLD.thread_id
    AND kind = OLD.kind
    AND provider_id = COALESCE(OLD.observed_provider_id, OLD.provider_id)
    AND model_id = COALESCE(OLD.observed_model_id, OLD.model_id)
    AND price_source = CASE WHEN OLD.price_status = 'fresh' THEN COALESCE(OLD.price_source, '') ELSE '' END
    AND price_source_version = CASE WHEN OLD.price_status = 'fresh' THEN COALESCE(OLD.price_source_version, '') ELSE '' END
    AND price_fresh_until = CASE WHEN OLD.price_status = 'fresh' THEN COALESCE(OLD.price_fresh_until, '') ELSE '' END
    AND runner_provider = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_provider, '') ELSE '' END
    AND runner_profile_id = CASE WHEN OLD.kind = 'runner' THEN json_quote(OLD.runner_profile_id) ELSE '' END
    AND runner_profile_version = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_profile_version, -1) ELSE -1 END
    AND runner_template = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_template, '') ELSE '' END
    AND runner_cpu_cores = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_cpu_cores, -1) ELSE -1 END
    AND runner_memory_mb = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_memory_mb, -1) ELSE -1 END
    AND runner_disk_gb = CASE WHEN OLD.kind = 'runner' THEN COALESCE(OLD.runner_disk_gb, -1) ELSE -1 END
    AND events = 0;
END;
