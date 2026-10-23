import { describe, expect, it } from "vitest";
import { type ExecutionRunnerRow, pinnedCredential } from "./execution.js";

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
    connection_provider_id: "e2b",
    key_version: 1,
    value_nonce: "nonce",
    ciphertext: "ciphertext",
    wrapped_key_nonce: "wrapped-nonce",
    wrapped_key: "wrapped",
    connection_account: "team-a",
    allow_personal_plugin_overrides: null,
    allow_personal_execution_overrides: null,
    owner_is_member: null,
    ...overrides,
  }) as ExecutionRunnerRow;

const deployed = { localRuntime: false };

describe("pinned Orb credential", () => {
  it.each([
    [
      "the new key's account is not verified yet",
      { connection_account: null },
      "account-changed",
    ],
    [
      "the connection now belongs to another account",
      { connection_account: "team-b" },
      "account-changed",
    ],
    [
      "the connection is for another provider",
      { connection_provider_id: "cloudflare" },
      "removed",
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
  ] as const)("fails closed when %s", (_case, overrides, reason) => {
    expect(
      pinnedCredential(row(overrides as Partial<ExecutionRunnerRow>), deployed),
    ).toEqual({ scope: "unavailable", reason });
  });
});
