import { describe, expect, it } from "vitest";
import { type ExecutionRunnerRow, pinnedCredential } from "./execution.js";

const configuredAt = "2026-10-04T00:00:00.000Z";

const row = (overrides: Partial<ExecutionRunnerRow> = {}): ExecutionRunnerRow =>
  ({
    thread_runner_profile_id: null,
    project_runner_profile_id: "a1.medium",
    owner_user_id: "user-1",
    project_workspace_id: null,
    pin_provider: "e2b",
    pin_runner_profile_id: "a1.medium",
    account_scope: "personal",
    account_owner_id: "user-1",
    provider_account: "team-a",
    provider_template: "dx-orb-x-a1-medium",
    key_provider_id: "e2b",
    key_version: 1,
    value_nonce: "nonce",
    ciphertext: "ciphertext",
    wrapped_key_nonce: "wrapped-nonce",
    wrapped_key: "wrapped",
    key_configured_at: configuredAt,
    key_account: "team-a",
    key_template_configured_at: configuredAt,
    allow_personal_plugin_overrides: null,
    allow_personal_execution_overrides: null,
    owner_is_member: null,
    ...overrides,
  }) as ExecutionRunnerRow;

const deployed = { localRuntime: false };

describe("pinned Orb credential", () => {
  it("uses the deployment key for unpinned and deployment-pinned Threads", () => {
    expect(pinnedCredential(row({ account_scope: null }), deployed)).toEqual({
      scope: "deployment",
    });
    expect(
      pinnedCredential(row({ account_scope: "deployment" }), deployed),
    ).toEqual({ scope: "deployment" });
  });

  it("uses the pinned owner's key while it resolves to the pinned account", () => {
    const resolved = pinnedCredential(row(), deployed);
    expect(resolved).toMatchObject({
      scope: "personal",
      ownerId: "user-1",
      account: "team-a",
    });
  });

  it("uses a key rotated within the same account", () => {
    // A new key for team-a re-verified the templates: new configuration,
    // same account.
    const rotated = "2026-10-05T00:00:00.000Z";
    expect(
      pinnedCredential(
        row({
          key_configured_at: rotated,
          key_template_configured_at: rotated,
          ciphertext: "rotated",
        }),
        deployed,
      ),
    ).toMatchObject({ scope: "personal", account: "team-a" });
  });

  it.each([
    [
      "the key was removed",
      { key_provider_id: null, ciphertext: null },
      "removed",
    ],
    [
      "the key now belongs to another account",
      { key_account: "team-b" },
      "account-changed",
    ],
    [
      "the new key's account is not verified yet",
      { key_account: null },
      "account-changed",
    ],
    [
      "the template record is from an earlier key",
      { key_template_configured_at: "2026-10-01T00:00:00.000Z" },
      "account-changed",
    ],
    [
      "a personal key on a workspace project without the opt-in",
      {
        project_workspace_id: "ws",
        allow_personal_plugin_overrides: 1,
        allow_personal_execution_overrides: 0,
      },
      "policy-denied",
    ],
    [
      "a personal key on a workspace project with only the Orb opt-in",
      {
        project_workspace_id: "ws",
        allow_personal_plugin_overrides: 0,
        allow_personal_execution_overrides: 1,
      },
      "policy-denied",
    ],
    [
      "a workspace key whose owner left the workspace",
      {
        account_scope: "workspace",
        account_owner_id: "ws",
        owner_is_member: 0,
      },
      "not-a-member",
    ],
  ] as const)("fails closed when %s", (_case, overrides, reason) => {
    expect(
      pinnedCredential(row(overrides as Partial<ExecutionRunnerRow>), deployed),
    ).toEqual({ scope: "unavailable", reason });
  });

  it("honors a personal key on a workspace project after the opt-in", () => {
    expect(
      pinnedCredential(
        row({
          project_workspace_id: "ws",
          allow_personal_plugin_overrides: 1,
          allow_personal_execution_overrides: 1,
        }),
        deployed,
      ),
    ).toMatchObject({ scope: "personal" });
  });

  it("never uses a person's or workspace's key in the local runtime", () => {
    expect(pinnedCredential(row(), { localRuntime: true })).toEqual({
      scope: "unavailable",
      reason: "local-runtime",
    });
  });
});
