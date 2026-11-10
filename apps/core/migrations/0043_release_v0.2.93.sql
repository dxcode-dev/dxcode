-- Spaces. A Space is a root Thread (`kind = 'space'`) whose agent coordinates
-- work for a goal: people chat with it, and it starts one child Thread per
-- piece of work. Its name is the Thread's title, its Project the Thread's
-- Project, its color the Thread's color. `space` holds what a Thread lacks;
-- `space_member` lists who created or joined it, for the sidebar.
ALTER TABLE threads ADD COLUMN kind TEXT NOT NULL DEFAULT 'thread'
  CHECK (kind IN ('thread', 'space'));

CREATE TABLE space (
  thread_id TEXT PRIMARY KEY REFERENCES threads (id) ON DELETE CASCADE,
  goal TEXT CHECK (goal IS NULL OR length(goal) <= 2000),
  created_at INTEGER NOT NULL
);

CREATE TABLE space_member (
  space_thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (space_thread_id, user_id)
);

CREATE INDEX space_member_user_idx ON space_member (user_id, space_thread_id);

-- The person whose message made a Space's agent start this Thread.
ALTER TABLE threads ADD COLUMN requested_by_user_id TEXT;
-- Epoch milliseconds: when the Thread was last archived, cleared on restore.
ALTER TABLE threads ADD COLUMN archived_at INTEGER;
-- Epoch milliseconds: when the Thread's work shipped, and how.
ALTER TABLE threads ADD COLUMN shipped_at INTEGER;
ALTER TABLE threads ADD COLUMN ship_reason TEXT
  CHECK (ship_reason IS NULL
    OR ship_reason IN ('default_branch', 'pull_request_merged', 'ship_archived'));
-- One line on what the Thread is doing now, for a Space's thread cards.
ALTER TABLE threads ADD COLUMN status_line TEXT
  CHECK (status_line IS NULL OR length(status_line) <= 120);

-- A Space lists its children newest first, and its progress by day.
CREATE INDEX threads_parent_created_idx ON threads (parent_thread_id, created_at)
  WHERE parent_thread_id IS NOT NULL;

CREATE INDEX threads_space_idx ON threads (shared_workspace_id, last_activity_at DESC)
  WHERE kind = 'space';

-- Comments on a Space's messages. People discuss a message beside the main
-- chat; the agent never reads a comment unless it mentions @dx, which sends
-- the comment to the agent in the main chat. `message_id` is the Flue
-- message's id. The commented message's text, author, and time are kept as
-- the first commenter saw them (`message_*`), so the Space's Comments list
-- and the panel quote it without loading the transcript. Mentions are read
-- from `body` (`@[Name](user:ID)`, `@[dx](agent)`), as artifact comments do.
CREATE TABLE space_comment (
  id TEXT PRIMARY KEY CHECK (length(id) = 36 AND substr(id, 1, 4) = 'mcm_'),
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 160),
  message_excerpt TEXT NOT NULL CHECK (length(message_excerpt) <= 1000),
  -- Null for the agent's message, or when the author's account is gone.
  message_author_user_id TEXT,
  message_sent_at INTEGER,
  author_user_id TEXT,
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 8000),
  created_at INTEGER NOT NULL
);

CREATE INDEX space_comment_message_idx
  ON space_comment (thread_id, message_id, created_at);

CREATE INDEX space_comment_author_idx
  ON space_comment (author_user_id)
  WHERE author_user_id IS NOT NULL;

-- Deleting an account forgets it as a comment's author and as the author of
-- a commented message; the comments stay with the Space.
CREATE TRIGGER space_comment_account_deleted
AFTER DELETE ON "user"
BEGIN
  UPDATE space_comment SET author_user_id = NULL
   WHERE author_user_id = OLD.id;
  UPDATE space_comment SET message_author_user_id = NULL
   WHERE message_author_user_id = OLD.id;
END;

-- Space thread cards and the catch-up card.
--
-- An artifact of a Thread that holds an open ask: an unchecked checklist item
-- that mentions a person. Each save of the artifact writes or clears its
-- row, so a Space's card shows Needs You without reading artifact bodies.
CREATE TABLE thread_open_ask (
  artifact_id TEXT PRIMARY KEY REFERENCES thread_artifact (id) ON DELETE CASCADE,
  thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

CREATE INDEX thread_open_ask_thread_idx ON thread_open_ask (thread_id);

-- When each person last had a Space open, in epoch milliseconds, and the
-- "Since you've been gone" card written for their latest return: what it
-- covers (from `catch_up_since` to `catch_up_until`), its Markdown, and
-- whether they dismissed it.
CREATE TABLE space_visit (
  space_thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  catch_up_since INTEGER,
  catch_up_until INTEGER,
  catch_up_body TEXT
    CHECK (catch_up_body IS NULL OR length(catch_up_body) <= 4000),
  catch_up_dismissed INTEGER NOT NULL DEFAULT 0
    CHECK (catch_up_dismissed IN (0, 1)),
  PRIMARY KEY (space_thread_id, user_id)
) WITHOUT ROWID;

-- A deleted account has no visits to catch up on.
CREATE TRIGGER space_visit_account_deleted
AFTER DELETE ON "user"
BEGIN
  DELETE FROM space_visit WHERE user_id = OLD.id;
END;

-- Epoch milliseconds: when the Thread was last restored from the archive, so
-- a Space's catch-up card counts a restore as a change.
ALTER TABLE threads ADD COLUMN restored_at INTEGER;

-- A Space's posts: what people see in its chat. A person's message in a
-- Space is a post, and the Space's agent publishes its own with the `post`
-- tool; its text replies and tool calls are never shown. `request_key`
-- makes creation idempotent: a person's delivery key, or the agent's tool
-- call. `submission_id` is the agent submission a person's post reached,
-- so dx can clear its `eyes` when that turn ends.
CREATE TABLE space_post (
  id TEXT PRIMARY KEY CHECK (length(id) = 30 AND substr(id, 1, 4) = 'pst_'),
  space_thread_id TEXT NOT NULL REFERENCES threads (id) ON DELETE CASCADE,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'agent')),
  -- Null for the agent's posts, or once the author's account is gone.
  author_user_id TEXT,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 20000),
  request_key TEXT NOT NULL CHECK (length(request_key) BETWEEN 1 AND 256),
  flue_message_id TEXT,
  submission_id TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER
);

CREATE UNIQUE INDEX space_post_request_idx
  ON space_post (space_thread_id, request_key);

CREATE INDEX space_post_space_idx
  ON space_post (space_thread_id, created_at, id);

CREATE INDEX space_post_submission_idx
  ON space_post (space_thread_id, submission_id)
  WHERE submission_id IS NOT NULL;

CREATE INDEX space_post_author_idx
  ON space_post (author_user_id)
  WHERE author_user_id IS NOT NULL;

-- Earlier versions of an edited post, oldest first: revision 1 is the text
-- as first posted. The current text stays on `space_post`.
CREATE TABLE space_post_revision (
  post_id TEXT NOT NULL REFERENCES space_post (id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  text TEXT NOT NULL CHECK (length(text) <= 20000),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (post_id, revision)
) WITHOUT ROWID;

-- Reactions on posts, one per reactor and reaction. The agent's `eyes`
-- shows while it works on a person's post.
CREATE TABLE space_post_reaction (
  post_id TEXT NOT NULL REFERENCES space_post (id) ON DELETE CASCADE,
  reactor_kind TEXT NOT NULL CHECK (reactor_kind IN ('user', 'agent')),
  user_id TEXT,
  reaction TEXT NOT NULL
    CHECK (reaction IN ('thumbs_up', 'heart', 'joy', 'eyes', 'wave')),
  created_at INTEGER NOT NULL,
  CHECK ((reactor_kind = 'user') = (user_id IS NOT NULL))
);

CREATE UNIQUE INDEX space_post_reaction_reactor_idx
  ON space_post_reaction (post_id, reactor_kind, ifnull(user_id, ''), reaction);

CREATE INDEX space_post_reaction_user_idx
  ON space_post_reaction (user_id)
  WHERE user_id IS NOT NULL;

-- Deleting an account forgets it as a post's author and drops its
-- reactions; the posts stay with the Space.
CREATE TRIGGER space_post_account_deleted
AFTER DELETE ON "user"
BEGIN
  UPDATE space_post SET author_user_id = NULL
   WHERE author_user_id = OLD.id;
  DELETE FROM space_post_reaction WHERE user_id = OLD.id;
END;

-- The Space's own status (`set_thread_status`) is its Thread's
-- `status_line`; this says whether it ends waiting on a person.
ALTER TABLE space ADD COLUMN waiting_on_input INTEGER NOT NULL DEFAULT 0
  CHECK (waiting_on_input IN (0, 1));

-- The Space post that asked for a Space's child (`create_thread`'s
-- `request_post_id`).
ALTER TABLE threads ADD COLUMN request_post_id TEXT;

-- Comments attach to posts from now on: each message commented before
-- posts existed becomes a post, as its first commenter saw it, and its
-- comments move onto that post.
CREATE TABLE space_comment_post_map (
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  post_id TEXT NOT NULL,
  PRIMARY KEY (thread_id, message_id)
) WITHOUT ROWID;

INSERT INTO space_comment_post_map (thread_id, message_id, post_id)
SELECT thread_id, message_id, 'pst_' || lower(hex(randomblob(13)))
  FROM space_comment
 WHERE substr(message_id, 1, 4) != 'pst_'
 GROUP BY thread_id, message_id;

INSERT INTO space_post
  (id, space_thread_id, author_kind, author_user_id, text, request_key,
   created_at)
SELECT map.post_id, map.thread_id,
       CASE WHEN first.message_author_user_id IS NULL THEN 'agent' ELSE 'user' END ,
       first.message_author_user_id,
       CASE WHEN length(first.message_excerpt) = 0 THEN '…'
            ELSE first.message_excerpt END ,
       'legacy-comment:' || map.message_id,
       coalesce(first.message_sent_at, first.created_at)
  FROM space_comment_post_map AS map
  JOIN space_comment AS first ON first.id = (
    SELECT id FROM space_comment AS comment
     WHERE comment.thread_id = map.thread_id
       AND comment.message_id = map.message_id
     ORDER BY comment.created_at, comment.id
     LIMIT 1);

UPDATE space_comment
   SET message_id = (
     SELECT post_id FROM space_comment_post_map AS map
      WHERE map.thread_id = space_comment.thread_id
        AND map.message_id = space_comment.message_id)
 WHERE substr(message_id, 1, 4) != 'pst_';

DROP TABLE space_comment_post_map;

-- Who a notification is from when no person sent it: dx's agent, such as a
-- Space's agent tagging a member in a post. The Mentions inbox shows it as
-- dx instead of an unknown person. Null for a person's notification
-- (`actor_user_id`) or one with no sender.
ALTER TABLE notification ADD COLUMN actor_kind TEXT
  CHECK (actor_kind IS NULL OR actor_kind = 'agent');

-- Where a Thread's agent runs (wiki/runtime-architecture.md#execution-modes).
-- `orb`: the Thread has its Orb, as every Thread did before. `executor`: no
-- Orb; the dx agent runs in its Durable Object only, and Claude Code runs in
-- the Thread's executor container. The server sets it when the Thread is
-- created and it never changes. A Space's main Thread is the first to use
-- `executor`.
ALTER TABLE threads ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'orb'
  CHECK (execution_mode IN ('orb', 'executor'));

UPDATE threads SET execution_mode = 'executor' WHERE kind = 'space';

-- The model a person's new Spaces run their main Thread on, from Settings →
-- Mode Dial → Space. No row means Auto: Claude Opus 5.5 at medium effort.
-- When a Space is created dx picks its route once: Claude Code on the
-- person's Claude Pro/Max plan, in the Space's executor, when the model is
-- one Claude Code serves and a plan is connected; otherwise the model through
-- Model Routing, on dx's own agent. The Space keeps that route.
CREATE TABLE space_agent_model (
  user_id TEXT NOT NULL PRIMARY KEY,
  model TEXT NOT NULL,
  thinking TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TRIGGER space_agent_model_account_deleted
AFTER DELETE ON "user"
BEGIN
  DELETE FROM space_agent_model WHERE user_id = OLD.id;
END;

-- A Thread's Cost & Usage (the Thread menu's cost row and its dialog). The
-- dialog must not read the Thread's raw usage: it reads one row per model
-- route from usage_thread_model, one row from thread_orb_usage, and one from
-- thread_context_window, all by primary key (apps/core/src/thread-usage/).
--
-- usage_thread_model holds migration 0151's model sums keyed by Thread first,
-- with the connection that served each turn, so Model Routing and By Model
-- read the Thread's rows alone. Triggers keep it exact as 0125's and 0151's
-- do: AFTER INSERT adds each model event actually inserted, AFTER DELETE
-- takes back each one retention deletes. Events stored before this migration
-- are added by the Worker's cron in rowid chunks (usage_thread_rollup_backfill,
-- as 0125); until then the dialog sums the Thread's raw model events.

CREATE TABLE usage_thread_model (
  thread_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  -- COALESCE(observed_*, *): what answered, as every usage page shows it.
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  requests INTEGER NOT NULL,
  -- Successful turns that compacted the conversation.
  compactions INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  estimated_cost_micros INTEGER NOT NULL,
  known_cost_events INTEGER NOT NULL,
  PRIMARY KEY (thread_id, connection_id, provider_id, model_id)
) WITHOUT ROWID;

-- A Thread's model requests for one model, newest first: the dialog's
-- expanded By Model row reads one page, and the summary's raw fallback reads
-- the Thread's model events, without visiting its tool or submission events.
-- Model events always have observed_provider_id and observed_model_id.
CREATE INDEX usage_event_thread_model_idx
  ON usage_event (
    thread_id, observed_provider_id, observed_model_id, occurred_at DESC, id DESC
  )
  WHERE kind = 'model';

CREATE TABLE usage_thread_rollup_backfill (
  singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
  through_rowid INTEGER NOT NULL,
  end_rowid INTEGER NOT NULL
);

INSERT INTO usage_thread_rollup_backfill (singleton, through_rowid, end_rowid)
VALUES (1, 0, COALESCE((SELECT MAX(rowid) FROM usage_event), 0));

CREATE TRIGGER usage_event_thread_rollup_insert
AFTER INSERT ON usage_event
WHEN NEW.kind = 'model'
  AND (NEW.rowid > (SELECT end_rowid FROM usage_thread_rollup_backfill)
    OR NEW.rowid <= (SELECT through_rowid FROM usage_thread_rollup_backfill))
BEGIN
  INSERT INTO usage_thread_model VALUES (
    NEW.thread_id,
    NEW.connection_id,
    COALESCE(NEW.observed_provider_id, NEW.provider_id),
    COALESCE(NEW.observed_model_id, NEW.model_id),
    1,
    NEW.turn_purpose = 'compaction' AND NEW.outcome = 'success',
    COALESCE(NEW.input_tokens, 0),
    COALESCE(NEW.output_tokens, 0),
    COALESCE(NEW.cache_read_tokens, 0),
    COALESCE(NEW.cache_write_tokens, 0),
    COALESCE(NEW.estimated_cost_micros_snapshot, 0),
    NEW.estimated_cost_micros_snapshot IS NOT NULL
  )
  ON CONFLICT DO UPDATE SET
    requests = requests + 1,
    compactions = compactions + excluded.compactions,
    input_tokens = input_tokens + excluded.input_tokens,
    output_tokens = output_tokens + excluded.output_tokens,
    cache_read_tokens = cache_read_tokens + excluded.cache_read_tokens,
    cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
    estimated_cost_micros = estimated_cost_micros + excluded.estimated_cost_micros,
    known_cost_events = known_cost_events + excluded.known_cost_events;
END;

CREATE TRIGGER usage_event_thread_rollup_delete
AFTER DELETE ON usage_event
WHEN OLD.kind = 'model'
  AND (OLD.rowid > (SELECT end_rowid FROM usage_thread_rollup_backfill)
    OR OLD.rowid <= (SELECT through_rowid FROM usage_thread_rollup_backfill))
BEGIN
  UPDATE usage_thread_model SET
    requests = requests - 1,
    compactions = compactions
      - (OLD.turn_purpose = 'compaction' AND OLD.outcome = 'success'),
    input_tokens = input_tokens - COALESCE(OLD.input_tokens, 0),
    output_tokens = output_tokens - COALESCE(OLD.output_tokens, 0),
    cache_read_tokens = cache_read_tokens - COALESCE(OLD.cache_read_tokens, 0),
    cache_write_tokens = cache_write_tokens - COALESCE(OLD.cache_write_tokens, 0),
    estimated_cost_micros = estimated_cost_micros
      - COALESCE(OLD.estimated_cost_micros_snapshot, 0),
    known_cost_events = known_cost_events
      - (OLD.estimated_cost_micros_snapshot IS NOT NULL)
  WHERE thread_id = OLD.thread_id
    AND connection_id = OLD.connection_id
    AND provider_id = COALESCE(OLD.observed_provider_id, OLD.provider_id)
    AND model_id = COALESCE(OLD.observed_model_id, OLD.model_id);
  DELETE FROM usage_thread_model
  WHERE thread_id = OLD.thread_id
    AND connection_id = OLD.connection_id
    AND provider_id = COALESCE(OLD.observed_provider_id, OLD.provider_id)
    AND model_id = COALESCE(OLD.observed_model_id, OLD.model_id)
    AND requests = 0;
END;

-- One Orb run of a Thread, from its daemon's registration to its last
-- heartbeat, written by the Thread's execution object when the run ends.
-- billing: 'credits' when the hosted offer metered it, 'deployment' for this
-- deployment's own Orb account, else the account the provider bills.
-- cost_micros is the credits charged, or the size's list price.
CREATE TABLE thread_orb_session (
  thread_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL CHECK (ended_at >= started_at),
  provider TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 64),
  runner_profile_id TEXT NOT NULL CHECK (length(runner_profile_id) BETWEEN 1 AND 128),
  billing TEXT NOT NULL
    CHECK (billing IN ('credits', 'deployment', 'workspace', 'personal')),
  cost_micros INTEGER NOT NULL CHECK (cost_micros >= 0),
  PRIMARY KEY (thread_id, started_at)
) WITHOUT ROWID;

-- Retention: sessions are kept as long as usage events (180 days).
CREATE INDEX thread_orb_session_ended_idx ON thread_orb_session (ended_at);

-- A Thread's Orb sessions summed, and its latest session's Orb, kept by the
-- triggers below.
CREATE TABLE thread_orb_usage (
  thread_id TEXT NOT NULL PRIMARY KEY,
  sessions INTEGER NOT NULL,
  runtime_ms INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL,
  credits_micros INTEGER NOT NULL,
  last_started_at INTEGER NOT NULL,
  provider TEXT NOT NULL,
  runner_profile_id TEXT NOT NULL,
  billing TEXT NOT NULL
) WITHOUT ROWID;

CREATE TRIGGER thread_orb_session_insert
AFTER INSERT ON thread_orb_session
BEGIN
  INSERT INTO thread_orb_usage VALUES (
    NEW.thread_id,
    1,
    NEW.ended_at - NEW.started_at,
    NEW.cost_micros,
    CASE WHEN NEW.billing = 'credits' THEN NEW.cost_micros ELSE 0 END ,
    NEW.started_at,
    NEW.provider,
    NEW.runner_profile_id,
    NEW.billing
  )
  ON CONFLICT (thread_id) DO UPDATE SET
    sessions = sessions + 1,
    runtime_ms = runtime_ms + excluded.runtime_ms,
    cost_micros = cost_micros + excluded.cost_micros,
    credits_micros = credits_micros + excluded.credits_micros,
    provider = CASE WHEN excluded.last_started_at >= last_started_at
      THEN excluded.provider ELSE provider END ,
    runner_profile_id = CASE WHEN excluded.last_started_at >= last_started_at
      THEN excluded.runner_profile_id ELSE runner_profile_id END ,
    billing = CASE WHEN excluded.last_started_at >= last_started_at
      THEN excluded.billing ELSE billing END ,
    last_started_at = max(last_started_at, excluded.last_started_at);
END;

CREATE TRIGGER thread_orb_session_delete
AFTER DELETE ON thread_orb_session
BEGIN
  UPDATE thread_orb_usage SET
    sessions = sessions - 1,
    runtime_ms = runtime_ms - (OLD.ended_at - OLD.started_at),
    cost_micros = cost_micros - OLD.cost_micros,
    credits_micros = credits_micros
      - CASE WHEN OLD.billing = 'credits' THEN OLD.cost_micros ELSE 0 END
  WHERE thread_id = OLD.thread_id;
  DELETE FROM thread_orb_usage WHERE thread_id = OLD.thread_id AND sessions = 0;
END;

-- What the Thread's last agent request sent, estimated per part, so the
-- dialog shows the context window without loading the conversation. Written
-- beside that request's usage event; read by primary key.
CREATE TABLE thread_context_window (
  thread_id TEXT NOT NULL PRIMARY KEY,
  provider_id TEXT NOT NULL,
  model_id TEXT NOT NULL,
  context_window INTEGER,
  system_prompt_tokens INTEGER NOT NULL,
  builtin_tool_tokens INTEGER NOT NULL,
  -- [{"server": name, "tokens": n}], at most 64.
  mcp_servers TEXT NOT NULL CHECK (json_valid(mcp_servers)),
  message_tokens INTEGER NOT NULL,
  measured_at TEXT NOT NULL
) WITHOUT ROWID;
