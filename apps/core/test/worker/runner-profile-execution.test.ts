import { env } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ExecutionRunnerProfileUnavailable,
  resolveExecutionRunnerProfile,
} from "../../src/execution/runner-profiles/execution.js";

const owner = "runner-profile-owner";
const projectId = "prj_00000000-0000-4000-8000-000000000071";
const threadId = "thr_00000000-0000-4000-8000-000000000072";
const timestamp = "2026-08-23T00:00:00.000Z";
const requiredCapabilities = [
  "git",
  "environment-variables",
  "internet-access",
  "persistent-workspace",
  "pause-resume",
] as const;
const catalog = JSON.stringify({
  version: 1,
  defaultProfileId: "e2b-standard",
  profiles: [
    {
      id: "e2b-standard",
      label: "Standard workspace",
      adapter: "e2b",
      template: "standard-template",
      resources: { cpuCores: 2, memoryMb: 4096, diskGb: 20 },
      isolation: "sandbox",
      availability: "available",
      capabilities: requiredCapabilities,
    },
    {
      id: "e2b-selected",
      label: "Selected workspace",
      adapter: "e2b",
      template: "selected-template",
      resources: { cpuCores: 4, memoryMb: 8192, diskGb: 40 },
      isolation: "sandbox",
      availability: "available",
      capabilities: requiredCapabilities,
    },
    {
      id: "e2b-maintenance",
      label: "Maintenance workspace",
      adapter: "e2b",
      template: "maintenance-template",
      resources: { cpuCores: 4, memoryMb: 8192, diskGb: 40 },
      isolation: "sandbox",
      availability: "maintenance",
      capabilities: requiredCapabilities,
    },
  ],
});

beforeEach(async () => {
  await env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
  )
    .bind(owner, "Runner Owner", "runner-owner@example.com", 1, 1)
    .run();
});

const insertThreadWithProfile = async (
  projectRunnerProfileId: string,
  threadRunnerProfileId?: string,
) => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO projects (
        id, owner_user_id, name, runner_profile_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      projectId,
      owner,
      "Runner project",
      projectRunnerProfileId,
      timestamp,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO threads (
        id, project_id, owner_user_id, runner_profile_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      threadId,
      projectId,
      owner,
      threadRunnerProfileId ?? null,
      timestamp,
      timestamp,
    ),
  ]);
};

describe("execution runner profile resolution", () => {
  it("resolves the project snapshot instead of the catalog default", async () => {
    await insertThreadWithProfile("e2b-selected");

    const selected = await Effect.runPromise(
      resolveExecutionRunnerProfile(
        { DB: env.DB, DX_RUNNER_PROFILE_CATALOG: catalog },
        threadId,
      ),
    );

    expect(selected).toMatchObject({
      id: "e2b-selected",
      adapter: "e2b",
      template: "selected-template",
      availability: "available",
      capabilities: expect.arrayContaining(["environment-variables"]),
    });
  });

  it("prefers the Thread runner override to the project snapshot", async () => {
    await insertThreadWithProfile("e2b-standard", "e2b-selected");

    const selected = await Effect.runPromise(
      resolveExecutionRunnerProfile(
        { DB: env.DB, DX_RUNNER_PROFILE_CATALOG: catalog },
        threadId,
      ),
    );

    expect(selected.id).toBe("e2b-selected");
  });

  it("fails closed when a snapshotted profile is no longer available", async () => {
    await insertThreadWithProfile("e2b-maintenance");

    await expect(
      Effect.runPromise(
        resolveExecutionRunnerProfile(
          { DB: env.DB, DX_RUNNER_PROFILE_CATALOG: catalog },
          threadId,
        ),
      ),
    ).rejects.toBeInstanceOf(ExecutionRunnerProfileUnavailable);
  });
});
