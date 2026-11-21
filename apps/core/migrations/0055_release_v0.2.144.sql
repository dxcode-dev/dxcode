-- When a person last deleted a message the agent had read: the conversation
-- went back to just before it and nothing was sent in its place. The next
-- message the agent receives carries rewound="true" in its author tag, so the
-- agent knows work it no longer remembers may have changed files, and Claude
-- Code forks its session at the last turn it keeps. Cleared once that message
-- is admitted.
ALTER TABLE threads ADD COLUMN history_rewound_at INTEGER;
