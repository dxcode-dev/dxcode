import { env } from "cloudflare:test";
import {
  PersistenceUnavailable,
  ProjectRepository,
  ThreadRepository,
  UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { purgeExpiredWorkspaceUsageAudit } from "../../src/settings/usage/retention.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

const owner = Schema.decodeUnknownSync(UserId)("owner-a");
const otherOwner = Schema.decodeUnknownSync(UserId)("owner-b");

describe("D1 migration", () => {
  it("authors product ownership and Better Auth constraints", async () => {
    const schema = await env.DB.prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ type: string; name: string; sql: string }>();
    const names = schema.results.map(({ name }) => name);

    expect(names).toEqual(
      expect.arrayContaining([
        "projects",
        "projects_owner_created_idx",
        "threads",
        "threads_owner_created_idx",
        "threads_owner_project_created_idx",
        "thread_pin_history",
        "thread_pin_history_snapshot_idx",
        "threads_pin_history_after_update",
        "user",
        "session",
        "account",
        "organization",
        "member",
        "invitation",
        "apikey",
        "rateLimit",
        "personal_account",
        "personal_account_after_user_insert",
        "personal_account_username_uidx",
        "personal_agent_instructions",
        "personal_agent_instructions_after_user_insert",
        "account_issuer_accountId_uidx",
        "member_organizationId_userId_uidx",
        "member_userId_uidx",
        "organization_slug_nocase_uidx",
        "workspace_organization_profile_before_insert",
        "workspace_organization_profile_before_update",
        "workspace_invite_link",
        "workspace_invite_link_token_hash_uidx",
        "workspace_mode_profile_override",
        "workspace_member_role_before_insert",
        "workspace_member_role_before_update",
        "workspace_owner_role_immutable_before_update",
        "workspace_admin_coverage_before_update",
        "apikey_key_uidx",
        "apikey_configId_referenceId_idx",
        "environment_variable",
        "environment_variable_target_enabled_idx",
        "environment_variable_target_name_idx",
        "environment_variable_scope_revision",
        "environment_variable_revision_insert",
        "environment_variable_revision_update",
        "environment_variable_revision_delete",
        "environment_variable_audit",
        "environment_variable_audit_target_time_idx",
        "environment_variable_audit_immutable_update",
        "environment_variable_audit_immutable_delete",
        "external_api_application",
        "external_api_application_workspace_created_idx",
        "external_api_application_credential",
        "external_api_application_credential_active_idx",
        "external_api_application_rate_limit",
        "external_api_application_audit",
        "external_api_application_audit_application_created_idx",
        "external_api_application_audit_immutable_update",
        "external_api_application_audit_immutable_delete",
        "workspace_usage_audit",
        "workspace_usage_audit_immutable_update",
        "workspace_usage_audit_retained_delete",
        "workspace_usage_audit_retention_gate",
        "mcp_server",
        "mcp_server_target_idx",
        "mcp_server_execution_idx",
        "mcp_tool",
        "mcp_tool_approved_idx",
        "mcp_workspace_policy",
        "skill",
        "skill_target_idx",
        "skill_resolution_idx",
        "skill_version",
        "skill_version_integrity_uidx",
        "skill_resource",
        "skill_workspace_policy",
        "trusted_plugin",
        "trusted_plugin_target_idx",
        "trusted_plugin_resolution_idx",
        "trusted_plugin_version",
        "trusted_plugin_version_integrity_uidx",
        "trusted_plugin_version_no_update",
        "trusted_plugin_version_no_delete",
        "trusted_plugin_file",
        "trusted_plugin_file_no_update",
        "trusted_plugin_file_no_delete",
        "trusted_plugin_workspace_policy",
        "trusted_plugin_invocation_audit",
        "trusted_plugin_audit_plugin_idx",
        "trusted_plugin_invocation_audit_no_update",
        "trusted_plugin_invocation_audit_no_delete",
        "personal_project_defaults",
        "workspace_project_defaults",
        "projects_workspace_created_idx",
        "workspace_policy",
        "workspace_policy_audit_event",
        "workspace_policy_audit_workspace_created_idx",
        "workspace_policy_after_organization_insert",
        "workspace_policy_audit_event_immutable_update",
        "workspace_policy_audit_event_immutable_delete",
        "workspace_policy_strong_authentication_irreversible",
        "personal_experimental_feature_preferences",
        "personal_signing_key",
        "personal_signing_key_active_user_uidx",
        "personal_verification_key",
        "integration_connection",
        "integration_connection_owner_idx",
        "integration_credential",
        "integration_credential_owner_idx",
        "integration_oauth_transaction",
        "integration_oauth_transaction_expiry_idx",
        "integration_repository",
        "integration_repository_selected_idx",
        "integration_resource_binding",
        "integration_resource_binding_impact_idx",
        "github_user_authorization",
        "github_installation",
        "github_owner_grant",
        "github_installation_repository",
        "github_owner_repository_selection",
        "github_setup_transaction",
        "github_webhook_delivery",
        "github_authorization_epoch",
        "plugin_trigger",
        "plugin_trigger_owner_idx",
        "plugin_trigger_active_capability_uidx",
        "plugin_trigger_ingress_idx",
        "plugin_trigger_audit",
        "plugin_trigger_audit_owner_idx",
        "plugin_trigger_audit_no_update",
        "plugin_trigger_audit_no_delete",
        "personal_model_subscription_connection",
        "personal_model_subscription_refresh_idx",
        "personal_model_subscription_authorization",
        "personal_model_subscription_authorization_expiry_idx",
        "thread_changes_state",
        "thread_changes_mutation_lease",
        "thread_changes_mutation_lease_expiry_idx",
        "thread_changes_capture_lease",
        "execution_workspace",
        "execution_workspace_after_thread_insert",
        "execution_workspace_provider_immutable_before_update",
        "execution_workspace_sandbox_immutable_before_update",
        "execution_workspace_transition_before_update",
        "execution_workspace_readiness_immutable_before_update",
      ]),
    );
    const sqlByName = new Map(
      schema.results.map(({ name, sql }) => [name, sql.replace(/\s+/g, " ")]),
    );
    expect(sqlByName.get("projects_owner_created_idx")).toContain(
      "(owner_user_id, created_at DESC, id DESC)",
    );
    expect(sqlByName.get("threads_owner_created_idx")).toContain(
      "(owner_user_id, created_at DESC, id DESC)",
    );
    expect(sqlByName.get("threads_owner_project_created_idx")).toContain(
      "(owner_user_id, project_id, created_at DESC, id DESC)",
    );
    expect(sqlByName.get("threads")).toContain(
      "FOREIGN KEY (project_id) REFERENCES projects(id)",
    );
    expect(sqlByName.get("account_issuer_accountId_uidx")).toContain(
      '("issuer", "accountId")',
    );
    expect(sqlByName.get("member_organizationId_userId_uidx")).toContain(
      '("organizationId", "userId")',
    );
    expect(sqlByName.get("member_userId_uidx")).toContain("(userId)");
    expect(sqlByName.get("organization_slug_nocase_uidx")).toContain(
      "(slug COLLATE NOCASE)",
    );
    expect(sqlByName.get("organization")).toContain(
      "lifecycleState TEXT NOT NULL DEFAULT 'active'",
    );
    expect(sqlByName.get("workspace_invite_link")).toContain(
      "token_hash TEXT NOT NULL",
    );
    expect(sqlByName.get("workspace_invite_link")).not.toContain("max_uses");
    expect(sqlByName.get("workspace_invite_link_token_hash_uidx")).toContain(
      "(token_hash)",
    );
    expect(sqlByName.get("apikey_key_uidx")).toContain('("key")');
    expect(sqlByName.get("apikey_configId_referenceId_idx")).toContain(
      '("configId", "referenceId")',
    );
    expect(sqlByName.get("rateLimit")).toContain('"key" text NOT NULL UNIQUE');
    expect(sqlByName.get("personal_account")).toContain(
      'REFERENCES "user" (id) ON DELETE CASCADE',
    );
    expect(sqlByName.get("personal_account_username_uidx")).toContain(
      "(username COLLATE NOCASE)",
    );
    expect(sqlByName.get("personal_agent_instructions")).toContain(
      'REFERENCES "user" (id) ON DELETE CASCADE',
    );
    expect(sqlByName.get("personal_agent_instructions")).toContain(
      "CHECK (length(content) <= 10000)",
    );
    expect(sqlByName.get("threads")).toContain(
      "agent_instructions TEXT NOT NULL DEFAULT ''",
    );
    expect(sqlByName.get("environment_variable")).toContain(
      "UNIQUE (scope, target_id, name)",
    );
    expect(sqlByName.get("environment_variable")).toContain(
      "CHECK (policy_locked = 0 OR scope = 'workspace')",
    );
    expect(sqlByName.get("environment_variable")).toContain(
      "key_version INTEGER NOT NULL",
    );
    expect(sqlByName.get("environment_variable")).not.toMatch(
      /master_key|data_key|plaintext/,
    );
    expect(sqlByName.get("environment_variable_audit")).not.toMatch(
      /ciphertext|envelope|plaintext|wrapped_key|value_nonce/,
    );
    expect(sqlByName.get("environment_variable_audit")).toContain(
      "id TEXT PRIMARY KEY NOT NULL",
    );
    expect(sqlByName.get("environment_variable_scope_revision")).not.toMatch(
      /name|value|cipher|hash|provider|thread/,
    );
    expect(sqlByName.get("mcp_server")).toContain(
      "CHECK (transport = 'streamable-http')",
    );
    expect(sqlByName.get("mcp_server")).toContain(
      "CHECK (timeout_ms BETWEEN 1000 AND 30000)",
    );
    expect(sqlByName.get("mcp_tool")).toContain(
      "PRIMARY KEY (server_id, name)",
    );
    expect(sqlByName.get("mcp_tool")).not.toMatch(/token|credential|secret/);
    expect(sqlByName.get("skill_version")).toContain(
      "PRIMARY KEY (skill_id, version)",
    );
    expect(sqlByName.get("skill_version")).not.toMatch(
      /entrypoint|executable|credential|secret/,
    );
    expect(sqlByName.get("skill_resource")).toContain(
      "CHECK (size_bytes BETWEEN 0 AND 65536)",
    );
    expect(sqlByName.get("threads")).toContain(
      "skill_snapshot_json TEXT NOT NULL DEFAULT '[]'",
    );
    expect(sqlByName.get("trusted_plugin_version")).toContain(
      "PRIMARY KEY (plugin_id, version)",
    );
    expect(sqlByName.get("trusted_plugin_version")).toContain(
      "CHECK (trusted = 1)",
    );
    expect(sqlByName.get("trusted_plugin_file")).toContain(
      "CHECK (size_bytes BETWEEN 0 AND 65536)",
    );
    expect(sqlByName.get("trusted_plugin_invocation_audit")).not.toMatch(
      /payload|input|output|secret|credential/,
    );
    expect(sqlByName.get("plugin_trigger")).toContain(
      "capability_hash TEXT NOT NULL",
    );
    expect(sqlByName.get("plugin_trigger")).not.toMatch(
      /capability TEXT|hmac_secret|plaintext/,
    );
    expect(sqlByName.get("plugin_trigger_audit")).not.toMatch(
      /payload|input|output|secret|credential|capability_hash/,
    );
    expect(sqlByName.get("threads")).toContain(
      "plugin_snapshot_json TEXT NOT NULL DEFAULT '[]'",
    );
    expect(sqlByName.get("model_connection")).toContain("'subscription'");
    expect(sqlByName.get("personal_model_subscription_connection")).toContain(
      "UNIQUE (owner_user_id, provider)",
    );
    expect(sqlByName.get("personal_model_subscription_connection")).not.toMatch(
      /access_token|refresh_token|plaintext/,
    );
    expect(
      sqlByName.get("personal_model_subscription_authorization"),
    ).not.toMatch(/device_code|access_token|refresh_token|plaintext/);
    expect(sqlByName.get("thread_changes_state")).toContain(
      "REFERENCES threads(id) ON DELETE CASCADE",
    );
    expect(sqlByName.get("thread_changes_state")).toContain(
      "latest_capture_generation <= mutation_generation",
    );
    expect(sqlByName.get("thread_changes_state")).toContain(
      "shadow_refresh_token TEXT",
    );
    expect(sqlByName.get("thread_changes_mutation_lease")).toContain(
      "REFERENCES thread_changes_state(thread_id) ON DELETE CASCADE",
    );
    expect(sqlByName.get("thread_changes_capture_lease")).toContain(
      "REFERENCES thread_changes_state(thread_id) ON DELETE CASCADE",
    );
    expect(sqlByName.get("execution_workspace")).toContain(
      "REFERENCES threads(id) ON DELETE CASCADE",
    );
    expect(sqlByName.get("execution_workspace")).toContain(
      "provider_sandbox_id TEXT",
    );
    expect(sqlByName.get("execution_workspace")).toContain("ready_at TEXT");
    expect(sqlByName.get("execution_workspace")).toContain(
      "preparation_status TEXT",
    );
    expect(sqlByName.get("execution_workspace")).not.toMatch(
      /credential|secret|token/,
    );
    expect(sqlByName.get("projects")).toContain(
      "runner_profile_id TEXT NOT NULL DEFAULT 'e2b-default'",
    );
    expect(sqlByName.get("projects")).toContain(
      "public_code_enabled INTEGER NOT NULL DEFAULT 0",
    );
    expect(sqlByName.get("personal_project_defaults")).toContain(
      'REFERENCES "user"(id) ON DELETE CASCADE',
    );
    expect(sqlByName.get("workspace_project_defaults")).toContain(
      "allow_public_code_access INTEGER NOT NULL DEFAULT 0",
    );
    expect(sqlByName.get("workspace_policy")).toContain(
      "allow_workspace_thread_visibility INTEGER NOT NULL DEFAULT 1",
    );
    expect(sqlByName.get("workspace_policy")).toContain(
      "allowed_runner_profile_ids TEXT",
    );
    expect(sqlByName.get("workspace_policy")).toContain(
      "allow_experimental_features INTEGER NOT NULL DEFAULT 1",
    );
    expect(
      sqlByName.get("personal_experimental_feature_preferences"),
    ).toContain('REFERENCES "user"(id) ON DELETE CASCADE');
    expect(
      sqlByName.get("personal_experimental_feature_preferences"),
    ).toContain("json_valid(preferences)");
    expect(sqlByName.get("threads")).toContain(
      "workspace_policy_migration_state TEXT NOT NULL DEFAULT 'grandfathered'",
    );
    expect(sqlByName.get("personal_signing_key")).toContain(
      "status = 'revoked' AND envelope_version IS NULL",
    );
    expect(sqlByName.get("personal_signing_key")).not.toMatch(
      /private_key|plaintext|master_key|data_key/,
    );
    expect(sqlByName.get("personal_verification_key")).toContain(
      "algorithm TEXT NOT NULL CHECK (algorithm = 'ssh-ed25519')",
    );
    expect(sqlByName.get("integration_oauth_transaction")).toContain(
      "state_hash TEXT NOT NULL UNIQUE CHECK",
    );
    expect(sqlByName.get("integration_oauth_transaction")).not.toContain(
      "state TEXT",
    );
    expect(sqlByName.get("integration_credential")).toContain(
      "purpose TEXT NOT NULL CHECK",
    );
    expect(sqlByName.get("integration_credential")).not.toMatch(
      /access_token|refresh_token|plaintext|master_key|data_key/,
    );
    expect(sqlByName.get("integration_resource_binding")).toContain(
      "resource_kind TEXT NOT NULL CHECK (resource_kind IN ('project', 'job', 'preview'))",
    );
    expect(sqlByName.get("external_api_application_credential")).toContain(
      "secret_hash TEXT NOT NULL UNIQUE",
    );
    expect(sqlByName.get("external_api_application_credential")).not.toMatch(
      /plaintext|client_secret/,
    );
    expect(sqlByName.get("external_api_application_audit")).toContain(
      "actor_id TEXT NOT NULL",
    );
    expect(names).not.toEqual(
      expect.arrayContaining(["conversation", "message", "event", "sandbox"]),
    );
  });

  it("advances content-free environment scope revisions for every mutation", async () => {
    const id = "migration-environment-revision";
    const target = "migration-environment-target";
    await env.DB.prepare(
      `INSERT INTO environment_variable (
         id, scope, target_id, name, kind, enabled, policy_locked,
         envelope_version, key_version, value_nonce, ciphertext,
         wrapped_key_nonce, wrapped_key, created_at, updated_at, rotated_at
       ) VALUES (?, 'personal', ?, 'REVISION_TEST', 'variable', 1, 0,
         1, 1, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        id,
        target,
        "a".repeat(16),
        "b".repeat(24),
        "c".repeat(16),
        "d".repeat(64),
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      )
      .run();
    const revision = async () =>
      env.DB.prepare(
        `SELECT revision FROM environment_variable_scope_revision
         WHERE scope = 'personal' AND target_id = ?`,
      )
        .bind(target)
        .first<number>("revision");
    await expect(revision()).resolves.toBe(1);
    await env.DB.prepare(
      "UPDATE environment_variable SET enabled = 0 WHERE id = ?",
    )
      .bind(id)
      .run();
    await expect(revision()).resolves.toBe(2);
    await env.DB.prepare("DELETE FROM environment_variable WHERE id = ?")
      .bind(id)
      .run();
    await expect(revision()).resolves.toBe(3);
  });

  it("rejects an audit event when its guarded value mutation changes no row", async () => {
    const before = await env.DB.prepare(
      "SELECT count(*) AS count FROM environment_variable_audit",
    ).first<number>("count");
    await expect(
      env.DB.batch([
        env.DB.prepare(
          "UPDATE environment_variable SET enabled = 0 WHERE id = ?",
        ).bind("missing-environment-variable"),
        env.DB.prepare(
          `INSERT INTO environment_variable_audit (
             id, scope, target_id, variable_id, name, kind, action,
             actor_user_id, request_id, occurred_at
           ) VALUES (
             CASE WHEN changes() = 1 THEN ? ELSE NULL END,
             'personal', 'audit-target', 'missing-environment-variable',
             'MISSING_VALUE', 'secret', 'update', 'audit-actor',
             'audit-request', '2026-08-25T00:00:00.000Z'
           )`,
        ).bind("audit-without-mutation"),
      ]),
    ).rejects.toBeDefined();
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS count FROM environment_variable_audit",
      ).first<number>("count"),
    ).toBe(before);
  });

  it("creates policy for future workspaces and enforces policy persistence constraints", async () => {
    await env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    )
      .bind("policy-future-workspace", "Policy Future", "policy-future", 1)
      .run();
    await expect(
      env.DB.prepare(
        `SELECT
           thread_default_visibility,
           allow_workspace_thread_visibility,
           allow_experimental_features,
           revision
         FROM workspace_policy
         WHERE workspace_id = ?`,
      )
        .bind("policy-future-workspace")
        .first(),
    ).resolves.toMatchObject({
      thread_default_visibility: "private",
      allow_workspace_thread_visibility: 1,
      allow_experimental_features: 1,
      revision: 0,
    });

    await expect(
      env.DB.prepare(
        "UPDATE workspace_policy SET allowed_runner_profile_ids = ? WHERE workspace_id = ?",
      )
        .bind('{"not":"an array"}', "policy-future-workspace")
        .run(),
    ).rejects.toBeDefined();

    await env.DB.prepare(
      `INSERT INTO workspace_policy_audit_event (
         id, workspace_id, actor_user_id, request_id, outcome, reason,
         previous_revision, next_revision, changed_fields, created_at
       ) VALUES (?, ?, ?, ?, 'rejected', ?, 0, NULL, '[]', ?)`,
    )
      .bind(
        "policy-audit-event",
        "policy-future-workspace",
        "policy-actor",
        "policy-request",
        "permission",
        "2026-08-23T00:00:00.000Z",
      )
      .run();
    await expect(
      env.DB.prepare(
        "UPDATE workspace_policy_audit_event SET reason = 'changed' WHERE id = ?",
      )
        .bind("policy-audit-event")
        .run(),
    ).rejects.toBeDefined();
    await expect(
      env.DB.prepare("DELETE FROM workspace_policy_audit_event WHERE id = ?")
        .bind("policy-audit-event")
        .run(),
    ).rejects.toBeDefined();

    await env.DB.prepare(
      "UPDATE workspace_policy SET require_strong_authentication = 1 WHERE workspace_id = ?",
    )
      .bind("policy-future-workspace")
      .run();
    await expect(
      env.DB.prepare(
        "UPDATE workspace_policy SET require_strong_authentication = 0 WHERE workspace_id = ?",
      )
        .bind("policy-future-workspace")
        .run(),
    ).rejects.toBeDefined();
  });

  it("enforces normalized profiles and zero-or-one membership at D1", async () => {
    const userId = "single-workspace-user";
    await env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    )
      .bind(userId, "Workspace User", "workspace-user@example.com", 1, 1)
      .run();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
      ).bind("workspace-one", "Workspace One", "workspace-one", 1),
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
      ).bind("workspace-two", "Workspace Two", "workspace-two", 1),
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
      ).bind("membership-one", "workspace-one", userId, "owner", 1),
    ]);

    await expect(
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
      )
        .bind("membership-two", "workspace-two", userId, "member", 1)
        .run(),
    ).rejects.toBeDefined();
    await expect(
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
      )
        .bind("workspace-case", "Workspace Case", "WORKSPACE-CASE", 1)
        .run(),
    ).rejects.toBeDefined();
    await expect(
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
      )
        .bind("workspace-duplicate", "Duplicate", "WORKSPACE-ONE", 1)
        .run(),
    ).rejects.toBeDefined();

    await expect(
      env.DB.prepare("SELECT lifecycleState FROM organization WHERE id = ?")
        .bind("workspace-one")
        .first("lifecycleState"),
    ).resolves.toBe("active");
  });

  it("enforces supported roles, immutable ownership, and admin coverage", async () => {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
      ).bind("role-user", "Role User", "role@example.com", 1, 1),
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
      ).bind("role-workspace", "Role Workspace", "role-workspace", 1),
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
      ).bind("role-owner", "role-workspace", "role-user", "owner", 1),
    ]);

    await expect(
      env.DB.prepare("UPDATE member SET role = 'member' WHERE id = ?")
        .bind("role-owner")
        .run(),
    ).rejects.toBeDefined();
    await expect(
      env.DB.prepare("UPDATE member SET role = 'auditor' WHERE id = ?")
        .bind("role-owner")
        .run(),
    ).rejects.toBeDefined();
    await expect(
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
      )
        .bind("invalid-role", "role-workspace", "role-user", "billing", 1)
        .run(),
    ).rejects.toBeDefined();

    await env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    )
      .bind("role-auditor", "Role Auditor", "role-auditor@example.com", 1, 1)
      .run();
    await expect(
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(
          "role-auditor-membership",
          "role-workspace",
          "role-auditor",
          "auditor",
          2,
        )
        .run(),
    ).resolves.toBeDefined();
  });

  it("keeps workspace inspection audit immutable until deterministic retention", async () => {
    const auditId = "migration-audit-event";
    const expiresAt = "2030-01-02T00:00:00.000Z";
    await env.DB.prepare(
      `INSERT INTO workspace_usage_audit (
         id, workspace_id, actor_user_id, reason, target_thread_id,
         occurred_at, expires_at, result
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        auditId,
        "migration-audit-workspace",
        "migration-audit-actor",
        "Investigating an approved operational incident",
        "thr_00000000-0000-4000-8000-000000000042",
        "2030-01-01T00:00:00.000Z",
        expiresAt,
        "success",
      )
      .run();

    await expect(
      env.DB.prepare("UPDATE workspace_usage_audit SET reason = ? WHERE id = ?")
        .bind("Changed", auditId)
        .run(),
    ).rejects.toBeDefined();
    await expect(
      env.DB.prepare("DELETE FROM workspace_usage_audit WHERE id = ?")
        .bind(auditId)
        .run(),
    ).rejects.toBeDefined();

    await expect(
      purgeExpiredWorkspaceUsageAudit(env.DB, "2030-01-01T23:59:59.999Z"),
    ).resolves.toMatchObject({ meta: { changes: 0 } });
    await expect(
      purgeExpiredWorkspaceUsageAudit(env.DB, expiresAt),
    ).resolves.toMatchObject({ meta: { changes: 1 } });
    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM workspace_usage_audit_retention_gate",
      ).first("count"),
    ).resolves.toBe(0);
  });

  it("creates a constrained personal profile for every auth user", async () => {
    await env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    )
      .bind(
        "migration-profile-user",
        "  Profile User  ",
        "profile@example.com",
        1,
        1,
      )
      .run();

    const profile = await env.DB.prepare(
      "SELECT user_id, display_name, username FROM personal_account WHERE user_id = ?",
    )
      .bind("migration-profile-user")
      .first<{
        user_id: string;
        display_name: string;
        username: string;
      }>();
    expect(profile).toMatchObject({
      user_id: "migration-profile-user",
      display_name: "Profile User",
      username: expect.stringMatching(/^user-[a-f0-9]{24}$/),
    });

    await expect(
      env.DB.prepare(
        "UPDATE personal_account SET username = ? WHERE user_id = ?",
      )
        .bind("Not Normalized", "migration-profile-user")
        .run(),
    ).rejects.toBeDefined();

    for (const terminalTheme of [
      "github",
      "gruvbox",
      "catppuccin",
      "solarized",
      "tokyo-night",
      "rose-pine",
      "one-half",
      "material",
    ]) {
      await expect(
        env.DB.prepare(
          "UPDATE personal_account SET terminal_theme = ? WHERE user_id = ?",
        )
          .bind(terminalTheme, "migration-profile-user")
          .run(),
      ).resolves.toMatchObject({ meta: { changes: 1 } });
    }
    await expect(
      env.DB.prepare(
        "UPDATE personal_account SET terminal_theme = ? WHERE user_id = ?",
      )
        .bind("unknown", "migration-profile-user")
        .run(),
    ).rejects.toBeDefined();
  });

  it("creates default personal instructions and preserves old Thread behavior", async () => {
    const userId = "migration-instructions-user";
    await env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    )
      .bind(userId, "Instructions User", "instructions@example.com", 1, 1)
      .run();
    await expect(
      env.DB.prepare(
        "SELECT content, revision, version FROM personal_agent_instructions WHERE user_id = ?",
      )
        .bind(userId)
        .first(),
    ).resolves.toEqual({ content: "", revision: 0, version: 1 });

    const projectId = "prj_00000000-0000-4000-8000-000000000051";
    const threadId = "thr_00000000-0000-4000-8000-000000000052";
    const timestamp = "2026-08-20T12:00:00.000Z";
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(projectId, userId, "Existing", timestamp, timestamp),
      env.DB.prepare(
        "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(threadId, projectId, userId, timestamp, timestamp),
    ]);
    await expect(
      env.DB.prepare(
        "SELECT agent_instructions, agent_instructions_revision, agent_instructions_version FROM threads WHERE id = ?",
      )
        .bind(threadId)
        .first(),
    ).resolves.toEqual({
      agent_instructions: "",
      agent_instructions_revision: 0,
      agent_instructions_version: 1,
    });
    await expect(
      env.DB.prepare("SELECT skill_snapshot_json FROM threads WHERE id = ?")
        .bind(threadId)
        .first("skill_snapshot_json"),
    ).resolves.toBe("[]");
    await expect(
      env.DB.prepare("SELECT plugin_snapshot_json FROM threads WHERE id = ?")
        .bind(threadId)
        .first("plugin_snapshot_json"),
    ).resolves.toBe("[]");
    await expect(
      env.DB.prepare(
        `SELECT ship_action, commit_author_preference, commit_author_name,
          commit_author_email, signing_preference, runner_profile_id,
          public_code_enabled
        FROM projects WHERE id = ?`,
      )
        .bind(projectId)
        .first(),
    ).resolves.toEqual({
      ship_action: "ship",
      commit_author_preference: "dx",
      commit_author_name: "dx",
      commit_author_email: "noreply@dx.local",
      signing_preference: "disabled",
      runner_profile_id: "e2b-default",
      public_code_enabled: 0,
    });
  });

  it("repairs initial Thread activity without treating old metadata updates as conversation activity", async () => {
    const userId = "migration-thread-activity-user";
    const projectId = "prj_00000000-0000-4000-8000-000000000061";
    const threadId = "thr_00000000-0000-4000-8000-000000000062";
    const createdAt = "2026-08-20T12:00:00.000Z";
    const updatedAt = "2026-08-21T12:00:00.000Z";
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
      ).bind(userId, "Activity User", "activity@example.com", 1, 1),
      env.DB.prepare(
        "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(projectId, userId, "Activity", createdAt, updatedAt),
      env.DB.prepare(
        "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(threadId, projectId, userId, createdAt, updatedAt),
    ]);
    expect(
      await env.DB.prepare("SELECT title FROM threads WHERE id = ?")
        .bind(threadId)
        .first<{ title: string }>(),
    ).toEqual({ title: "Untitled thread" });

    // Reproduce the projection left by the originally deployed 0026 backfill.
    await env.DB.prepare(
      "UPDATE threads SET last_activity_at = updated_at WHERE id = ?",
    )
      .bind(threadId)
      .run();
    const repair = env.TEST_MIGRATIONS.find((migration) =>
      migration.name.startsWith("0027_"),
    );
    if (repair === undefined) {
      expect(env.TEST_MIGRATIONS.map(({ name }) => name)).toEqual([
        expect.stringMatching(/^0000_baseline_/),
      ]);
      return;
    }
    expect(repair).toBeDefined();
    await env.DB.batch(
      (repair?.queries ?? []).map((query) => env.DB.prepare(query)),
    );

    const user = Schema.decodeUnknownSync(UserId)(userId);
    await runRepositories(
      Effect.gen(function* () {
        const repository = yield* ThreadRepository;
        const detail = yield* repository.findOwnedById(threadId, user);
        const list = yield* repository.listOwned(user, undefined, {});
        expect(detail.lastActivityAt).toEqual(list.items[0]?.lastActivityAt);
        expect(
          Schema.encodeSync(Schema.DateTimeUtcFromString)(
            detail.lastActivityAt,
          ),
        ).toBe(createdAt);
      }),
    );
    await expect(
      env.DB.prepare(
        "SELECT kind, occurred_at FROM thread_activity WHERE thread_id = ? ORDER BY sequence",
      )
        .bind(threadId)
        .all(),
    ).resolves.toMatchObject({
      results: [{ kind: "created", occurred_at: createdAt }],
    });
  });

  it("uses composite range seeks for cursor pagination", async () => {
    const explain = async (query: D1PreparedStatement) => {
      const plan = await query.all<{ detail: string }>();
      return plan.results.map(({ detail }) => detail).join("\n");
    };
    const cursorTime = "2026-08-20T12:00:00.000Z";
    const cursorId = "prj_00000000-0000-4000-8000-000000000001";

    const projectPlan = await explain(
      env.DB.prepare(`
        EXPLAIN QUERY PLAN
        SELECT id, owner_user_id, name, created_at, updated_at
        FROM projects
        WHERE owner_user_id = ? AND (created_at, id) < (?, ?)
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).bind(owner, cursorTime, cursorId, 21),
    );
    expect(projectPlan).toContain(
      "projects_owner_created_idx (owner_user_id=? AND (created_at,id)<(?,?))",
    );

    const threadPlan = await explain(
      env.DB.prepare(`
        EXPLAIN QUERY PLAN
        SELECT id, project_id, owner_user_id, created_at, updated_at
        FROM threads
        WHERE owner_user_id = ? AND (created_at, id) < (?, ?)
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).bind(owner, cursorTime, cursorId, 21),
    );
    expect(threadPlan).toContain(
      "threads_owner_created_idx (owner_user_id=? AND (created_at,id)<(?,?))",
    );

    const projectThreadPlan = await explain(
      env.DB.prepare(`
        EXPLAIN QUERY PLAN
        SELECT id, project_id, owner_user_id, created_at, updated_at
        FROM threads
        WHERE owner_user_id = ?
          AND project_id = ?
          AND (created_at, id) < (?, ?)
        ORDER BY created_at DESC, id DESC
        LIMIT ?
      `).bind(owner, cursorId, cursorTime, cursorId, 21),
    );
    expect(projectThreadPlan).toContain(
      "threads_owner_project_created_idx (owner_user_id=? AND project_id=? AND (created_at,id)<(?,?))",
    );
  });

  it("enforces Project foreign keys by default", async () => {
    const entity = project(
      "prj_00000000-0000-4000-8000-000000000031",
      owner,
      "Owned",
    );
    // A workspace member's Thread may reference another member's Project, so
    // the database enforces the Project reference and repositories enforce
    // access.
    const orphan = thread(
      "thr_00000000-0000-4000-8000-000000000032",
      "prj_00000000-0000-4000-8000-000000000039" as typeof entity.id,
      otherOwner,
    );

    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const threads = yield* ThreadRepository;
        yield* projects.insert(entity);
        const error = yield* Effect.flip(threads.insert(orphan));
        expect(error).toBeInstanceOf(PersistenceUnavailable);
        expect(error._tag).toBe("PersistenceUnavailable");
      }),
    );

    const foreignKeys = await env.DB.prepare("PRAGMA foreign_keys").first<{
      foreign_keys: number;
    }>();
    expect(foreignKeys?.foreign_keys).toBe(1);
  });

  it("contains raw D1 failures at the repository boundary", async () => {
    const entity = project(
      "prj_00000000-0000-4000-8000-000000000041",
      owner,
      "Duplicate",
    );

    const error = await runRepositories(
      Effect.gen(function* () {
        const repository = yield* ProjectRepository;
        yield* repository.insert(entity);
        return yield* Effect.flip(repository.insert(entity));
      }),
    );

    expect(error).toBeInstanceOf(PersistenceUnavailable);
    expect(
      JSON.stringify(Schema.encodeSync(PersistenceUnavailable)(error)),
    ).not.toMatch(/unique|constraint|bound value|driver stack/i);
  });

  it("adds bounded Thread list Changes summaries", async () => {
    const columns = await env.DB.prepare(
      "SELECT name FROM pragma_table_info('thread_changes_state') WHERE name LIKE 'summary_%' ORDER BY name",
    ).all<{ name: string }>();
    expect(columns.results.map(({ name }) => name)).toEqual([
      "summary_additions",
      "summary_deletions",
      "summary_files",
    ]);
  });
});
