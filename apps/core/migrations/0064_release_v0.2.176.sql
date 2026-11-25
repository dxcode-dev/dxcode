-- The runtime model catalog (settings/model-routing/live-catalog.ts): models
-- dx learns after its release, on top of the pi catalog pinned in the build.
-- One row per source: `models.dev` (the open catalog, refreshed by the cron)
-- and `discovered:<provider>` (models a provider reported for a connected
-- account, such as GitHub Copilot's /models or Anthropic's /v1/models).
CREATE TABLE IF NOT EXISTS model_catalog_source (
  source TEXT NOT NULL PRIMARY KEY,
  models_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
