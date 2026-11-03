-- Usage rollups (#1489). The usage page summed every usage_event row in its
-- range five times. These two tables hold the same sums per hour (per owner)
-- and per UTC day (per owner and Thread), so the page reads one row per
-- bucket and reads raw events only for the edges a bucket cannot answer.
--
-- Triggers keep both tables exact: an AFTER INSERT trigger adds each event
-- that is actually inserted (INSERT OR IGNORE duplicates fire nothing), and
-- an AFTER DELETE trigger takes back each event retention deletes.
-- usage_event is immutable (usage_event_immutable_update); a migration that
-- updates its rows must rebuild these tables.
--
-- Keys hold '' or -1 where the event column is NULL: usage_event's CHECKs
-- allow no -1 in those columns, and price columns are '' unless the event is
-- 'fresh', where no usage_price row can match ''. runner_profile_id holds
-- json_quote() of the event's value so NULL and '' stay apart. Buckets are
-- the occurred_at string's hour or day prefix, so they split events exactly
-- where the raw queries' string comparisons do.
--
-- Also drops four indexes no query uses (#1491).

CREATE TABLE usage_hourly (
  owner_user_id TEXT NOT NULL,
  -- The UTC hour's start, 'YYYY-MM-DDTHH:00:00.000Z'.
  hour TEXT NOT NULL,
  kind TEXT NOT NULL,
  -- COALESCE(observed_*, *): what every usage filter compares.
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
  PRIMARY KEY (
    owner_user_id, hour, kind, provider_id, model_id,
    price_source, price_source_version, price_fresh_until,
    runner_provider, runner_profile_id, runner_profile_version, runner_template,
    runner_cpu_cores, runner_memory_mb, runner_disk_gb
  )
) WITHOUT ROWID;

CREATE TABLE usage_thread_daily (
  owner_user_id TEXT NOT NULL,
  -- The UTC day's start, 'YYYY-MM-DDT00:00:00.000Z'.
  day TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  model_profile_id TEXT NOT NULL,
  model_profile_version INTEGER NOT NULL,
  events INTEGER NOT NULL,
  error_events INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  unknown_token_events INTEGER NOT NULL,
  estimated_cost_micros INTEGER NOT NULL,
  known_cost_events INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  duration_events INTEGER NOT NULL,
  PRIMARY KEY (
    owner_user_id, day, thread_id, project_id, kind, provider_id, model_id,
    model_profile_id, model_profile_version
  )
) WITHOUT ROWID;

-- Events already stored are added by the Worker's cron in rowid chunks
-- (apps/core/src/settings/usage/rollup-d1.ts), not here: one migration is one
-- D1 query, which must finish in 30 seconds, and a large usage_event would
-- not. Until the backfill reaches end_rowid, the usage page reads raw events.
-- An event is in the rollups exactly when its rowid is above end_rowid or at
-- most through_rowid; both triggers and each backfill chunk keep that true.
CREATE TABLE usage_rollup_backfill (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  through_rowid INTEGER NOT NULL,
  end_rowid INTEGER NOT NULL
);

INSERT INTO usage_rollup_backfill (singleton, through_rowid, end_rowid)
VALUES (1, 0, COALESCE((SELECT MAX(rowid) FROM usage_event), 0));

CREATE TRIGGER usage_event_rollup_insert
AFTER INSERT ON usage_event
WHEN NEW.rowid > (SELECT end_rowid FROM usage_rollup_backfill)
  OR NEW.rowid <= (SELECT through_rowid FROM usage_rollup_backfill)
BEGIN
  INSERT INTO usage_hourly VALUES (
    NEW.owner_user_id,
    substr(NEW.occurred_at, 1, 13) || ':00:00.000Z',
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
    NEW.duration_ms IS NOT NULL
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
    duration_events = duration_events + excluded.duration_events;
  INSERT INTO usage_thread_daily VALUES (
    NEW.owner_user_id,
    substr(NEW.occurred_at, 1, 10) || 'T00:00:00.000Z',
    NEW.thread_id,
    NEW.project_id,
    NEW.kind,
    COALESCE(NEW.observed_provider_id, NEW.provider_id),
    COALESCE(NEW.observed_model_id, NEW.model_id),
    NEW.model_profile_id,
    NEW.model_profile_version,
    1,
    NEW.outcome = 'error',
    COALESCE(NEW.total_tokens, 0),
    NEW.total_tokens IS NULL,
    COALESCE(NEW.estimated_cost_micros_snapshot, 0),
    NEW.estimated_cost_micros_snapshot IS NOT NULL,
    COALESCE(NEW.duration_ms, 0),
    NEW.duration_ms IS NOT NULL
  )
  ON CONFLICT DO UPDATE SET
    events = events + excluded.events,
    error_events = error_events + excluded.error_events,
    total_tokens = total_tokens + excluded.total_tokens,
    unknown_token_events = unknown_token_events + excluded.unknown_token_events,
    estimated_cost_micros = estimated_cost_micros + excluded.estimated_cost_micros,
    known_cost_events = known_cost_events + excluded.known_cost_events,
    duration_ms = duration_ms + excluded.duration_ms,
    duration_events = duration_events + excluded.duration_events;
END;

CREATE TRIGGER usage_event_rollup_delete
AFTER DELETE ON usage_event
WHEN OLD.rowid > (SELECT end_rowid FROM usage_rollup_backfill)
  OR OLD.rowid <= (SELECT through_rowid FROM usage_rollup_backfill)
BEGIN
  UPDATE usage_hourly SET
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
  WHERE owner_user_id = OLD.owner_user_id
    AND hour = substr(OLD.occurred_at, 1, 13) || ':00:00.000Z'
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
  DELETE FROM usage_hourly
  WHERE owner_user_id = OLD.owner_user_id
    AND hour = substr(OLD.occurred_at, 1, 13) || ':00:00.000Z'
    AND kind = OLD.kind
    AND provider_id = COALESCE(OLD.observed_provider_id, OLD.provider_id)
    AND model_id = COALESCE(OLD.observed_model_id, OLD.model_id)
    AND events = 0;
  UPDATE usage_thread_daily SET
    events = events - 1,
    error_events = error_events - (OLD.outcome = 'error'),
    total_tokens = total_tokens - COALESCE(OLD.total_tokens, 0),
    unknown_token_events = unknown_token_events - (OLD.total_tokens IS NULL),
    estimated_cost_micros = estimated_cost_micros - COALESCE(OLD.estimated_cost_micros_snapshot, 0),
    known_cost_events = known_cost_events - (OLD.estimated_cost_micros_snapshot IS NOT NULL),
    duration_ms = duration_ms - COALESCE(OLD.duration_ms, 0),
    duration_events = duration_events - (OLD.duration_ms IS NOT NULL)
  WHERE owner_user_id = OLD.owner_user_id
    AND day = substr(OLD.occurred_at, 1, 10) || 'T00:00:00.000Z'
    AND thread_id = OLD.thread_id
    AND project_id = OLD.project_id
    AND kind = OLD.kind
    AND provider_id = COALESCE(OLD.observed_provider_id, OLD.provider_id)
    AND model_id = COALESCE(OLD.observed_model_id, OLD.model_id)
    AND model_profile_id = OLD.model_profile_id
    AND model_profile_version = OLD.model_profile_version;
  DELETE FROM usage_thread_daily
  WHERE owner_user_id = OLD.owner_user_id
    AND day = substr(OLD.occurred_at, 1, 10) || 'T00:00:00.000Z'
    AND thread_id = OLD.thread_id
    AND events = 0;
END;

DROP INDEX usage_event_owner_model_time_idx;
DROP INDEX threads_owner_project_created_idx;
DROP INDEX member_organizationId_idx;
DROP INDEX member_userId_idx;

-- A new Thread's first message, held until its agent admits it (#1590).
-- `POST /v1/threads` writes this row in the same batch as the Thread and
-- answers; the agent's Durable Object starts after the response. Delivery
-- deletes the row once Flue admits the message under the key `initial`,
-- which makes any retry admit it once. A refused message stays as `failed`
-- so the Thread can say why it did not start.
CREATE TABLE thread_initial_dispatch (
  thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
  -- Flue's dispatch request, as the route built it.
  request_json TEXT NOT NULL,
  -- The first message's files, linked to the Thread once it is admitted.
  attachment_ids_json TEXT NOT NULL DEFAULT '[]',
  sender_user_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'failed')),
  failure_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  attempted_at INTEGER
);

CREATE INDEX thread_initial_dispatch_pending_idx
  ON thread_initial_dispatch (state, created_at);

-- A Project's Thread list orders pinned Threads first, then by activity
-- (#1487). With the pin in the index, the list's first page walks it in
-- order and stops at the page's limit instead of sorting every Thread in
-- the Project. The new index keeps the old one's (owner_user_id, project_id)
-- prefix, so the old index's other readers keep seeking.
DROP INDEX threads_owner_project_activity_idx;

CREATE INDEX threads_owner_project_pinned_activity_idx
  ON threads(owner_user_id, project_id, pinned_at DESC, last_activity_at DESC, id DESC);
