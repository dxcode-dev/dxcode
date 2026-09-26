import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

beforeEach(async () => {
  await env.DB.exec(`
    DROP TRIGGER IF EXISTS external_api_application_audit_immutable_update;
    DROP TRIGGER IF EXISTS external_api_application_audit_immutable_delete;
    DROP TRIGGER IF EXISTS environment_variable_audit_immutable_update;
    DROP TRIGGER IF EXISTS environment_variable_audit_immutable_delete;
    DROP TRIGGER IF EXISTS environment_variable_audit_force_failure;
    DROP TRIGGER IF EXISTS workspace_organization_update_force_failure;
  `);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO startup_phase_retention_gate (singleton, delete_before) VALUES (1, '9999-12-31T23:59:59.999Z') ON CONFLICT(singleton) DO UPDATE SET delete_before = excluded.delete_before",
    ),
    env.DB.prepare("DELETE FROM startup_phase_event"),
    env.DB.prepare("DELETE FROM startup_phase_retention_gate"),
    env.DB.prepare("DELETE FROM github_owner_repository_selection"),
    env.DB.prepare("DELETE FROM github_webhook_delivery"),
    env.DB.prepare("DELETE FROM github_oauth_transaction"),
    env.DB.prepare("DELETE FROM github_setup_transaction"),
    env.DB.prepare("DELETE FROM github_authorization_epoch"),
    env.DB.prepare("DELETE FROM github_installation_repository"),
    env.DB.prepare("DELETE FROM github_owner_grant"),
    env.DB.prepare("DELETE FROM github_installation"),
    env.DB.prepare("DELETE FROM github_user_authorization"),
    env.DB.prepare("DELETE FROM external_api_application_audit"),
    env.DB.prepare("DELETE FROM external_api_application_rate_limit"),
    env.DB.prepare("DELETE FROM external_api_application_credential"),
    env.DB.prepare("DELETE FROM external_api_application"),
    env.DB.prepare("DELETE FROM usage_event"),
    env.DB.prepare("DELETE FROM usage_price"),
    env.DB.prepare("DELETE FROM mode_profile_override"),
    env.DB.prepare("DELETE FROM model_connection_model"),
    env.DB.prepare("DELETE FROM model_connection_header"),
    env.DB.prepare("DELETE FROM model_credential"),
    env.DB.prepare("DELETE FROM personal_model_subscription_authorization"),
    env.DB.prepare("DELETE FROM model_connection"),
    env.DB.prepare("DROP TRIGGER IF EXISTS plugin_trigger_audit_no_delete"),
    env.DB.prepare("DELETE FROM plugin_trigger_audit"),
    env.DB.prepare(`
      CREATE TRIGGER plugin_trigger_audit_no_delete
      BEFORE DELETE ON plugin_trigger_audit
      BEGIN
        SELECT RAISE(ABORT, 'plugin trigger audit is immutable');
      END
    `),
    env.DB.prepare("DELETE FROM plugin_trigger"),
    env.DB.prepare(
      "DROP TRIGGER IF EXISTS trusted_plugin_invocation_audit_no_delete",
    ),
    env.DB.prepare("DELETE FROM trusted_plugin_invocation_audit"),
    env.DB.prepare(`
      CREATE TRIGGER trusted_plugin_invocation_audit_no_delete
      BEFORE DELETE ON trusted_plugin_invocation_audit
      BEGIN
        SELECT RAISE(ABORT, 'plugin invocation audit is immutable');
      END
    `),
    env.DB.prepare("DROP TRIGGER IF EXISTS trusted_plugin_file_no_delete"),
    env.DB.prepare("DELETE FROM trusted_plugin_file"),
    env.DB.prepare(`
      CREATE TRIGGER trusted_plugin_file_no_delete
      BEFORE DELETE ON trusted_plugin_file
      BEGIN
        SELECT RAISE(ABORT, 'trusted plugin files are immutable');
      END
    `),
    env.DB.prepare("DROP TRIGGER IF EXISTS trusted_plugin_version_no_delete"),
    env.DB.prepare("DELETE FROM trusted_plugin_version"),
    env.DB.prepare(`
      CREATE TRIGGER trusted_plugin_version_no_delete
      BEFORE DELETE ON trusted_plugin_version
      BEGIN
        SELECT RAISE(ABORT, 'trusted plugin versions are immutable');
      END
    `),
    env.DB.prepare("DELETE FROM trusted_plugin"),
    env.DB.prepare("DELETE FROM trusted_plugin_workspace_policy"),
    env.DB.prepare("DELETE FROM skill_resource"),
    env.DB.prepare("DELETE FROM skill_version"),
    env.DB.prepare("DELETE FROM skill"),
    env.DB.prepare("DELETE FROM skill_workspace_policy"),
    env.DB.prepare("DELETE FROM mcp_tool"),
    env.DB.prepare("DELETE FROM mcp_server"),
    env.DB.prepare("DELETE FROM mcp_workspace_policy"),
    env.DB.prepare("DELETE FROM integration_resource_binding"),
    env.DB.prepare("DELETE FROM integration_repository"),
    env.DB.prepare("DELETE FROM integration_connection"),
    env.DB.prepare("DELETE FROM integration_oauth_transaction"),
    env.DB.prepare("DELETE FROM integration_credential"),
    env.DB.prepare("DELETE FROM environment_variable_audit"),
    env.DB.prepare("DELETE FROM environment_variable"),
    env.DB.prepare("DELETE FROM personal_experimental_feature_preferences"),
    env.DB.prepare("DELETE FROM threads"),
    env.DB.prepare("DELETE FROM projects"),
    env.DB.prepare("DELETE FROM personal_account"),
    env.DB.prepare("DELETE FROM apikey"),
    env.DB.prepare("DELETE FROM security_recent_authentication"),
    env.DB.prepare("DELETE FROM invitation"),
    env.DB.prepare("DELETE FROM workspace_invite_capability"),
    env.DB.prepare("DELETE FROM member"),
    env.DB.prepare("DELETE FROM organization"),
    env.DB.prepare("DELETE FROM auth_waitlist"),
    env.DB.prepare("DELETE FROM verification"),
    env.DB.prepare("DELETE FROM account"),
    env.DB.prepare("DELETE FROM session"),
    env.DB.prepare('DELETE FROM "user"'),
  ]);
  await env.DB.batch([
    env.DB.prepare(`
      CREATE TRIGGER external_api_application_audit_immutable_update
      BEFORE UPDATE ON external_api_application_audit
      BEGIN
        SELECT RAISE(ABORT, 'external API application audit is immutable');
      END
    `),
    env.DB.prepare(`
      CREATE TRIGGER external_api_application_audit_immutable_delete
      BEFORE DELETE ON external_api_application_audit
      BEGIN
        SELECT RAISE(ABORT, 'external API application audit is immutable');
      END
    `),
    env.DB.prepare(`
      CREATE TRIGGER environment_variable_audit_immutable_update
      BEFORE UPDATE ON environment_variable_audit
      BEGIN
        SELECT RAISE(ABORT, 'environment variable audit is immutable');
      END
    `),
    env.DB.prepare(`
      CREATE TRIGGER environment_variable_audit_immutable_delete
      BEFORE DELETE ON environment_variable_audit
      BEGIN
        SELECT RAISE(ABORT, 'environment variable audit is immutable');
      END
    `),
  ]);
});
