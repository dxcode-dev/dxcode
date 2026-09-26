import { env } from "cloudflare:test";
import { Effect, Redacted } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { listGitHubGrants } from "../../src/source-control/github/control-plane.js";
import { GitHubProviderError } from "../../src/source-control/github/provider-http.js";
import {
  GITHUB_WEBHOOK_MAX_BYTES,
  GitHubWebhookInvalid,
  GitHubWebhookUnavailable,
  processGitHubWebhook,
} from "../../src/source-control/github/webhooks.js";

const secret = "webhook-test-secret";
const config = {
  appId: "12345",
  webhookSecret: Redacted.make(secret),
} as never;
const encoder = new TextEncoder();

const signature = async (body: Uint8Array) => {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, Uint8Array.from(body)),
  );
  return `sha256=${[...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
};

let delivery = 0;
const send = async (
  event: string,
  payload: unknown,
  deliveryId = `delivery-${++delivery}`,
  reconcileInstallation: (installationId: string) => Promise<unknown> = async (
    installationId,
  ) => {
    await env.DB.prepare(`
      UPDATE github_installation
         SET status = 'active', suspended_at = NULL, updated_at = ?
       WHERE installation_id = ?
    `)
      .bind(new Date().toISOString(), installationId)
      .run();
    if (event === "installation_repositories") {
      // This fixture's authoritative provider confirms the added repositories.
      for (const repository of (
        payload as { repositories_added?: { id: number }[] }
      ).repositories_added ?? []) {
        await env.DB.prepare(`
          UPDATE github_installation_repository SET entitled = 1
           WHERE installation_id = ? AND provider_repository_id = ?
        `)
          .bind(installationId, String(repository.id))
          .run();
      }
    }
  },
) => {
  const body = encoder.encode(JSON.stringify(payload));
  return Effect.runPromise(
    processGitHubWebhook({
      db: env.DB,
      config,
      deliveryId,
      event,
      signature: await signature(body),
      body,
      reconcileInstallation,
    }),
  );
};

const insertUser = (id: string) =>
  env.DB.prepare(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
    VALUES (?, ?, ?, 1, ?, ?)
  `)
    .bind(id, id, `${id}@example.test`, Date.now(), Date.now())
    .run();

beforeEach(async () => {
  delivery = 0;
  await Promise.all([
    insertUser("webhook-user-a"),
    insertUser("webhook-user-b"),
  ]);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO github_installation (
        installation_id, app_id, provider_account_id, provider_account_type,
        provider_account_login, repository_selection, status,
        permissions_version, created_at, updated_at
      ) VALUES ('9001', '12345', '501', 'organization', 'display-only',
                'selected', 'active', 1, ?, ?)
    `).bind(now, now),
    env.DB.prepare(`
      INSERT INTO github_owner_grant (
        id, owner_scope, owner_id, installation_id, status,
        created_by_user_id, created_at, updated_at
      ) VALUES ('grant-a', 'personal', 'webhook-user-a', '9001', 'active',
                'webhook-user-a', ?, ?)
    `).bind(now, now),
    env.DB.prepare(`
      INSERT INTO github_owner_grant (
        id, owner_scope, owner_id, installation_id, status,
        created_by_user_id, created_at, updated_at
      ) VALUES ('grant-b', 'personal', 'webhook-user-b', '9001', 'active',
                'webhook-user-b', ?, ?)
    `).bind(now, now),
  ]);
});

describe("GitHub webhook lifecycle persistence", () => {
  it("authenticates, durably deduplicates, and rejects spoofed or conflicting deliveries", async () => {
    const first = await send("ping", { zen: "ignored" }, "same-delivery");
    const replay = await send("ping", { zen: "ignored" }, "same-delivery");
    expect(first).toEqual({ duplicate: false });
    expect(replay).toEqual({ duplicate: true });
    await env.DB.prepare(`
      UPDATE github_webhook_delivery
         SET state = 'processing', processed_at = NULL,
             updated_at = '2000-01-01T00:00:00.000Z'
       WHERE delivery_id = 'same-delivery'
    `).run();
    expect(await send("ping", { zen: "ignored" }, "same-delivery")).toEqual({
      duplicate: false,
    });
    expect(
      await env.DB.prepare(
        "SELECT attempts FROM github_webhook_delivery WHERE delivery_id = 'same-delivery'",
      ).first(),
    ).toEqual({ attempts: 2 });
    await expect(
      send("ping", { zen: "changed" }, "same-delivery"),
    ).rejects.toBeInstanceOf(GitHubWebhookInvalid);

    const body = encoder.encode("{}");
    await expect(
      Effect.runPromise(
        processGitHubWebhook({
          db: env.DB,
          config,
          deliveryId: "unsigned",
          event: "ping",
          signature: `sha256=${"0".repeat(64)}`,
          body,
        }),
      ),
    ).rejects.toBeInstanceOf(GitHubWebhookInvalid);
    await expect(
      Effect.runPromise(
        processGitHubWebhook({
          db: env.DB,
          config,
          deliveryId: "oversize",
          event: "ping",
          signature: `sha256=${"0".repeat(64)}`,
          body: new Uint8Array(GITHUB_WEBHOOK_MAX_BYTES + 1),
        }),
      ),
    ).rejects.toBeInstanceOf(GitHubWebhookInvalid);
    await expect(send("push", {})).rejects.toBeInstanceOf(GitHubWebhookInvalid);
  });

  it("fails closed on suspend and authoritatively reconciles unsuspend while advancing every owner epoch", async () => {
    const installation = { id: 9001, repository_selection: "selected" };
    await send("installation", { action: "suspend", installation });
    expect(
      await env.DB.prepare(
        "SELECT status FROM github_installation WHERE installation_id = '9001'",
      ).first(),
    ).toEqual({ status: "suspended" });
    expect(
      await env.DB.prepare(
        "SELECT id, status FROM github_owner_grant ORDER BY id",
      ).all(),
    ).toMatchObject({
      results: [
        { id: "grant-a", status: "active" },
        { id: "grant-b", status: "active" },
      ],
    });
    await send("installation", { action: "unsuspend", installation });
    expect(
      await env.DB.prepare(
        "SELECT status FROM github_installation WHERE installation_id = '9001'",
      ).first(),
    ).toEqual({ status: "active" });
    expect(
      await env.DB.prepare(
        "SELECT id, status FROM github_owner_grant ORDER BY id",
      ).all(),
    ).toMatchObject({
      results: [
        { id: "grant-a", status: "active" },
        { id: "grant-b", status: "active" },
      ],
    });
    expect(
      await env.DB.prepare(`
        SELECT subject_kind, subject_id, epoch FROM github_authorization_epoch
         ORDER BY subject_kind, subject_id
      `).all(),
    ).toMatchObject({
      results: [
        { subject_kind: "installation", subject_id: "9001", epoch: 3 },
        { subject_kind: "owner-grant", subject_id: "grant-a", epoch: 3 },
        { subject_kind: "owner-grant", subject_id: "grant-b", epoch: 3 },
      ],
    });
  });

  it("reconciles additions and actual all-to-selected transitions against out-of-order delivery", async () => {
    const repository = {
      id: 7003,
      full_name: "display/stale",
      html_url: "https://github.com/display/stale",
      visibility: "private",
    };
    let reconciliations = 0;
    await send(
      "installation_repositories",
      {
        action: "added",
        installation: { id: 9001, repository_selection: "selected" },
        repositories_added: [repository],
      },
      undefined,
      async () => {
        reconciliations += 1;
        await env.DB.prepare(`
          UPDATE github_installation_repository SET entitled = 0
           WHERE installation_id = '9001' AND provider_repository_id = '7003'
        `).run();
      },
    );
    expect(reconciliations).toBe(1);
    expect(
      await env.DB.prepare(`
        SELECT entitled FROM github_installation_repository
         WHERE installation_id = '9001' AND provider_repository_id = '7003'
      `).first(),
    ).toEqual({ entitled: 0 });

    await env.DB.prepare(
      "UPDATE github_installation SET repository_selection = 'all' WHERE installation_id = '9001'",
    ).run();
    await send(
      "installation_repositories",
      {
        action: "removed",
        installation: { id: 9001, repository_selection: "selected" },
        repositories_removed: [],
      },
      undefined,
      async () => {
        reconciliations += 1;
        await env.DB.prepare(
          "UPDATE github_installation SET status = 'active' WHERE installation_id = '9001'",
        ).run();
      },
    );
    expect(reconciliations).toBe(2);
    expect(
      await env.DB.prepare(`
        SELECT repository_selection, status FROM github_installation
         WHERE installation_id = '9001'
      `).first(),
    ).toEqual({ repository_selection: "selected", status: "active" });
  });

  it("restores entitlement after a delayed removal disagrees with the provider", async () => {
    const now = new Date().toISOString();
    const repository = {
      id: 7004,
      full_name: "display/current",
      html_url: "https://github.com/display/current",
      visibility: "private",
    };
    await env.DB.prepare(`
      INSERT INTO github_installation_repository (
        installation_id, provider_repository_id, full_name, web_url,
        visibility, entitled, last_reconciled_at
      ) VALUES ('9001', '7004', 'display/current',
                'https://github.com/display/current', 'private', 1, ?)
    `)
      .bind(now)
      .run();
    let reconciliations = 0;

    await send(
      "installation_repositories",
      {
        action: "removed",
        installation: { id: 9001, repository_selection: "selected" },
        repositories_removed: [repository],
      },
      "delayed-removal",
      async () => {
        reconciliations += 1;
        await env.DB.prepare(`
          UPDATE github_installation_repository SET entitled = 1
           WHERE installation_id = '9001' AND provider_repository_id = '7004'
        `).run();
      },
    );

    expect(reconciliations).toBe(1);
    expect(
      await env.DB.prepare(`
        SELECT entitled FROM github_installation_repository
         WHERE installation_id = '9001' AND provider_repository_id = '7004'
      `).first(),
    ).toEqual({ entitled: 1 });
  });

  it("settles repository removals delivered after installation deletion", async () => {
    const payload = {
      action: "removed",
      installation: { id: 9001, repository_selection: "selected" },
      repositories_removed: [],
    };
    await send("installation", {
      action: "deleted",
      installation: payload.installation,
    });
    let reconciliations = 0;

    await expect(
      send(
        "installation_repositories",
        payload,
        "removal-after-deletion",
        async () => {
          reconciliations += 1;
          throw new GitHubProviderError({ category: "not-found" });
        },
      ),
    ).resolves.toEqual({ duplicate: false });
    expect(reconciliations).toBe(0);

    await env.DB.prepare(
      "UPDATE github_installation SET status = 'active' WHERE installation_id = '9001'",
    ).run();
    await expect(
      send(
        "installation_repositories",
        payload,
        "deletion-races-removal",
        async () => {
          reconciliations += 1;
          await env.DB.prepare(
            "UPDATE github_installation SET status = 'removed' WHERE installation_id = '9001'",
          ).run();
          throw new GitHubProviderError({ category: "not-found" });
        },
      ),
    ).resolves.toEqual({ duplicate: false });
    expect(reconciliations).toBe(1);
  });

  it("adds entitlement without selecting, then removes it for all owners before success", async () => {
    const repository = {
      id: 7001,
      full_name: "display/repository",
      html_url: "https://github.com/display/repository",
      visibility: "private",
    };
    const installation = { id: 9001, repository_selection: "selected" };
    await send("installation_repositories", {
      action: "added",
      installation,
      repositories_added: [repository],
    });
    expect(
      await env.DB.prepare(
        "SELECT entitled FROM github_installation_repository WHERE installation_id = '9001' AND provider_repository_id = '7001'",
      ).first(),
    ).toEqual({ entitled: 1 });
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS count FROM github_owner_repository_selection",
      ).first<number>("count"),
    ).toBe(0);
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO github_owner_repository_selection (
          owner_grant_id, installation_id, provider_repository_id,
          selected_at, selected_by_user_id
        ) VALUES ('grant-a', '9001', '7001', ?, 'webhook-user-a')
      `).bind(now),
      env.DB.prepare(`
        INSERT INTO github_owner_repository_selection (
          owner_grant_id, installation_id, provider_repository_id,
          selected_at, selected_by_user_id
        ) VALUES ('grant-b', '9001', '7001', ?, 'webhook-user-b')
      `).bind(now),
    ]);
    await send("installation_repositories", {
      action: "removed",
      installation,
      repositories_removed: [repository],
    });
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS count FROM github_owner_repository_selection",
      ).first<number>("count"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT entitled FROM github_installation_repository WHERE installation_id = '9001' AND provider_repository_id = '7001'",
      ).first(),
    ).toEqual({ entitled: 0 });
  });

  it("does not publish added entitlement before authoritative reconciliation succeeds", async () => {
    const payload = {
      action: "added",
      installation: { id: 9001, repository_selection: "selected" },
      repositories_added: [
        {
          id: 7999,
          full_name: "display/stale",
          html_url: "https://github.com/display/stale",
          visibility: "private",
        },
      ],
    };
    await expect(
      send(
        "installation_repositories",
        payload,
        "failed-addition",
        async () => {
          throw new Error("provider unavailable");
        },
      ),
    ).rejects.toThrow("provider unavailable");
    expect(
      await env.DB.prepare(`
        SELECT count(*) AS count FROM github_installation_repository
         WHERE installation_id = '9001' AND provider_repository_id = '7999'
           AND entitled = 1
      `).first<number>("count"),
    ).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT state, attempts FROM github_webhook_delivery WHERE delivery_id = 'failed-addition'",
      ).first(),
    ).toEqual({ state: "failed", attempts: 1 });

    await expect(
      send(
        "installation_repositories",
        payload,
        "failed-addition",
        async () => {
          await env.DB.prepare(`
            UPDATE github_installation_repository SET entitled = 1
             WHERE installation_id = '9001' AND provider_repository_id = '7999'
          `).run();
        },
      ),
    ).resolves.toEqual({ duplicate: false });
    expect(
      await env.DB.prepare(
        "SELECT state, attempts FROM github_webhook_delivery WHERE delivery_id = 'failed-addition'",
      ).first(),
    ).toEqual({ state: "processed", attempts: 2 });
  });

  it("retries after transient acknowledgment persistence failure", async () => {
    await env.DB.prepare(`
      CREATE TRIGGER reject_webhook_ack
      BEFORE UPDATE OF state ON github_webhook_delivery
      WHEN NEW.delivery_id = 'persistence-retry' AND NEW.state = 'processed'
      BEGIN
        SELECT RAISE(ABORT, 'forced acknowledgment failure');
      END
    `).run();
    await expect(
      send("ping", { zen: "persistence" }, "persistence-retry"),
    ).rejects.toThrow();
    expect(
      await env.DB.prepare(
        "SELECT state, attempts FROM github_webhook_delivery WHERE delivery_id = 'persistence-retry'",
      ).first(),
    ).toEqual({ state: "failed", attempts: 1 });

    await env.DB.prepare("DROP TRIGGER reject_webhook_ack").run();
    await expect(
      send("ping", { zen: "persistence" }, "persistence-retry"),
    ).resolves.toEqual({ duplicate: false });
    expect(
      await env.DB.prepare(
        "SELECT state, attempts FROM github_webhook_delivery WHERE delivery_id = 'persistence-retry'",
      ).first(),
    ).toEqual({ state: "processed", attempts: 2 });
  });

  it("keeps installation authority active when one user's App authorization is revoked", async () => {
    const now = new Date().toISOString();
    await env.DB.prepare(`
      INSERT INTO github_user_authorization (
        id, user_id, provider_account_id, provider_account_login, status,
        created_at, updated_at
      ) VALUES ('auth-a', 'webhook-user-a', '777', 'display-user', 'active', ?, ?)
    `)
      .bind(now, now)
      .run();
    await send("github_app_authorization", {
      action: "revoked",
      sender: { id: 777 },
    });
    expect(
      await env.DB.prepare(
        "SELECT status FROM github_user_authorization WHERE id = 'auth-a'",
      ).first(),
    ).toEqual({ status: "revoked" });
    expect(
      await env.DB.prepare(
        "SELECT status FROM github_installation WHERE installation_id = '9001'",
      ).first(),
    ).toEqual({ status: "active" });
    expect(
      await env.DB.prepare(
        "SELECT id, status FROM github_owner_grant ORDER BY id",
      ).all(),
    ).toMatchObject({
      results: [
        { id: "grant-a", status: "reauthorization-required" },
        { id: "grant-b", status: "active" },
      ],
    });
  });

  it("handles installation, target, permission, and repository lifecycle actions idempotently", async () => {
    await send("installation", {
      action: "created",
      installation: {
        id: 9002,
        account: { id: 502, login: "new-display", type: "Organization" },
        repository_selection: "selected",
      },
    });
    expect(
      await env.DB.prepare(
        "SELECT status FROM github_installation WHERE installation_id = '9002'",
      ).first(),
    ).toEqual({ status: "permissions-pending" });

    await send("installation_target", {
      action: "renamed",
      installation: {
        id: 9001,
        account: { id: 501, login: "renamed-display" },
      },
    });
    expect(
      await env.DB.prepare(
        "SELECT provider_account_login FROM github_installation WHERE installation_id = '9001'",
      ).first(),
    ).toEqual({ provider_account_login: "renamed-display" });

    const repository = {
      id: 7002,
      full_name: "display/original",
      html_url: "https://github.com/display/original",
      visibility: "private",
    };
    await send("installation_repositories", {
      action: "added",
      installation: { id: 9001, repository_selection: "selected" },
      repositories_added: [repository],
    });
    await send("repository", {
      action: "transferred",
      installation: { id: 9001 },
      repository: {
        ...repository,
        full_name: "destination/renamed",
        html_url: "https://github.com/destination/renamed",
      },
    });
    expect(
      await env.DB.prepare(
        "SELECT full_name FROM github_installation_repository WHERE installation_id = '9001' AND provider_repository_id = '7002'",
      ).first(),
    ).toEqual({ full_name: "destination/renamed" });
    await send("repository", {
      action: "deleted",
      installation: { id: 9001 },
      repository: {
        ...repository,
        full_name: "destination/renamed",
        html_url: "https://github.com/destination/renamed",
      },
    });
    expect(
      await env.DB.prepare(
        "SELECT entitled FROM github_installation_repository WHERE installation_id = '9001' AND provider_repository_id = '7002'",
      ).first(),
    ).toEqual({ entitled: 0 });

    await send("installation", {
      action: "new_permissions_accepted",
      installation: { id: 9001 },
    });
    expect(
      await env.DB.prepare(
        "SELECT status, permissions_version FROM github_installation WHERE installation_id = '9001'",
      ).first(),
    ).toEqual({ status: "active", permissions_version: 2 });

    await send("installation", {
      action: "deleted",
      installation: { id: 9001 },
    });
    expect(
      await env.DB.prepare(
        "SELECT id, status FROM github_owner_grant ORDER BY id",
      ).all(),
    ).toMatchObject({
      results: [
        { id: "grant-a", status: "disconnected" },
        { id: "grant-b", status: "disconnected" },
      ],
    });
    expect(
      await env.DB.prepare(
        "SELECT status FROM github_installation WHERE installation_id = '9001'",
      ).first(),
    ).toEqual({ status: "removed" });
  });

  it("disconnects every active grant when an installation is uninstalled via webhook, hides grants from listing, admits orphan cleanup, and stays idempotent across redelivery", async () => {
    const installation = { id: 9001, repository_selection: "selected" };
    await send("installation", { action: "deleted", installation });
    expect(
      await env.DB.prepare(
        "SELECT status FROM github_installation WHERE installation_id = '9001'",
      ).first(),
    ).toEqual({ status: "removed" });
    expect(
      await env.DB.prepare(
        "SELECT id, status FROM github_owner_grant ORDER BY id",
      ).all(),
    ).toMatchObject({
      results: [
        { id: "grant-a", status: "disconnected" },
        { id: "grant-b", status: "disconnected" },
      ],
    });
    expect(
      await listGitHubGrants(env.DB, {
        scope: "personal",
        id: "webhook-user-a",
      }),
    ).toEqual([]);
    expect(
      await listGitHubGrants(env.DB, {
        scope: "personal",
        id: "webhook-user-b",
      }),
    ).toEqual([]);
    expect(
      await env.DB.prepare(`
        SELECT DISTINCT stale.installation_id
          FROM github_owner_grant AS stale
         WHERE stale.owner_scope = 'personal' AND stale.owner_id = 'webhook-user-a'
           AND stale.status = 'disconnected'
           AND NOT EXISTS (
             SELECT 1 FROM github_owner_grant AS current
              WHERE current.installation_id = stale.installation_id
                AND current.status != 'disconnected'
           )
      `).all(),
    ).toMatchObject({ results: [{ installation_id: "9001" }] });
    expect(
      await env.DB.prepare(`
        SELECT subject_kind, subject_id, epoch FROM github_authorization_epoch
         ORDER BY subject_kind, subject_id
      `).all(),
    ).toMatchObject({
      results: [
        { subject_kind: "installation", subject_id: "9001", epoch: 2 },
        { subject_kind: "owner-grant", subject_id: "grant-a", epoch: 2 },
        { subject_kind: "owner-grant", subject_id: "grant-b", epoch: 2 },
      ],
    });
    await send("installation", { action: "deleted", installation });
    expect(
      await env.DB.prepare(
        "SELECT id, status FROM github_owner_grant ORDER BY id",
      ).all(),
    ).toMatchObject({
      results: [
        { id: "grant-a", status: "disconnected" },
        { id: "grant-b", status: "disconnected" },
      ],
    });
  });

  it("does not acknowledge a concurrent delivery until processing has succeeded", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const payload = { action: "unsuspend", installation: { id: 9001 } };
    const first = send(
      "installation",
      payload,
      "concurrent-delivery",
      async () => {
        started.resolve();
        await release.promise;
      },
    );
    await started.promise;
    try {
      await expect(
        send("installation", payload, "concurrent-delivery"),
      ).rejects.toBeInstanceOf(GitHubWebhookUnavailable);
    } finally {
      release.resolve();
      await first;
    }
    expect(await send("installation", payload, "concurrent-delivery")).toEqual({
      duplicate: true,
    });
    expect(
      await env.DB.prepare(
        "SELECT attempts FROM github_webhook_delivery WHERE delivery_id = 'concurrent-delivery'",
      ).first<number>("attempts"),
    ).toBe(1);
  });

  it("does not let a superseded attempt settle a recovered claim", async () => {
    const payload = { action: "unsuspend", installation: { id: 9001 } };
    const firstStarted = Promise.withResolvers<void>();
    const firstRelease = Promise.withResolvers<void>();
    const first = send(
      "installation",
      payload,
      "recovered-delivery",
      async () => {
        firstStarted.resolve();
        await firstRelease.promise;
        throw new Error("stale attempt failed");
      },
    );
    await firstStarted.promise;
    await env.DB.prepare(`
      UPDATE github_webhook_delivery
         SET updated_at = '2000-01-01T00:00:00.000Z'
       WHERE delivery_id = 'recovered-delivery'
    `).run();
    const secondStarted = Promise.withResolvers<void>();
    const secondRelease = Promise.withResolvers<void>();
    const second = send(
      "installation",
      payload,
      "recovered-delivery",
      async () => {
        secondStarted.resolve();
        await secondRelease.promise;
      },
    );
    await secondStarted.promise;

    firstRelease.resolve();
    await expect(first).rejects.toThrow("stale attempt failed");
    expect(
      await env.DB.prepare(`
        SELECT state, attempts FROM github_webhook_delivery
         WHERE delivery_id = 'recovered-delivery'
      `).first(),
    ).toEqual({ state: "processing", attempts: 2 });
    await expect(
      send("installation", payload, "recovered-delivery"),
    ).rejects.toBeInstanceOf(GitHubWebhookUnavailable);

    secondRelease.resolve();
    await expect(second).resolves.toEqual({ duplicate: false });
    expect(
      await env.DB.prepare(`
        SELECT state, attempts FROM github_webhook_delivery
         WHERE delivery_id = 'recovered-delivery'
      `).first(),
    ).toEqual({ state: "processed", attempts: 2 });
  });
});
