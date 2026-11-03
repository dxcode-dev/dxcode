import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

// A person's Triggers settings, through the same HTTP calls the page and a
// webhook sender make: once a trigger has a delivery, listing it and
// changing its state still answer 200 with that delivery.
const origin = "http://dx.test";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  BETTER_AUTH_SECRET: "plugin-trigger-list-secret-000000000",
  PLUGIN_TRIGGER_DELIVERY: env.PLUGIN_TRIGGER_DELIVERY,
};

const signUp = async () => {
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": "203.0.113.71",
      },
      body: JSON.stringify({
        name: "Trigger Owner",
        email: `trigger-list-${crypto.randomUUID()}@example.test`,
        password: "trigger-list-password-123",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
};

const settings =
  (cookie: string) =>
  async (
    path: string,
    init: { readonly method?: string; readonly body?: unknown } = {},
  ) => {
    const response = await app.request(
      path,
      {
        method: init.method ?? "GET",
        headers: { cookie, origin, "content-type": "application/json" },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      },
      bindings,
    );
    return {
      status: response.status,
      body: (await response.json()) as { data: Record<string, unknown> },
    };
  };

const manifest = {
  schemaVersion: 1,
  name: "trigger-list-proof",
  displayName: "Build notifier",
  description: "Receives a build webhook.",
  version: "1.0.0",
  entrypoint: "main.mjs",
  tools: [],
  commands: [],
  lifecycle: [],
  triggers: [
    {
      name: "build-finished",
      description: "Receive a finished build.",
      source: "webhook",
      event: "build.completed",
      action: "build-finished",
      idempotent: true,
    },
  ],
  uiSurfaces: [],
  permissions: {
    tools: [],
    commands: [],
    lifecycle: [],
    triggers: ["build-finished"],
    uiSurfaces: [],
    networkDestinations: [],
    secretNames: [],
    filesystem: [],
    mcpServerIds: [],
    agentCapabilities: [],
  },
};

const bundle = {
  source: { type: "browser-files", label: "Trigger list test" },
  files: [
    {
      path: "plugin.json",
      kind: "file",
      mediaType: "application/json",
      encoding: "utf-8",
      content: JSON.stringify(manifest),
    },
    {
      path: "main.mjs",
      kind: "file",
      mediaType: "text/javascript",
      encoding: "utf-8",
      content:
        "export const triggers = { 'build-finished': async ({ input }) => input };",
    },
  ],
};

describe("personal plugin triggers with deliveries", () => {
  it("lists a trigger and changes its state after a webhook arrives", async () => {
    const call = settings(await signUp());

    const preview = await call("/v1/settings/personal/plugins/preview", {
      method: "POST",
      body: bundle,
    });
    expect(preview.status).toBe(200);
    const trusted = await call("/v1/settings/personal/plugins", {
      method: "POST",
      body: {
        bundle,
        reviewedIntegrity: preview.body.data.integrity,
        grants: {
          tools: [],
          commands: [],
          lifecycle: [],
          uiSurfaces: [],
          networkDestinations: [],
          secretReferences: [],
          filesystem: [],
          mcpServerIds: [],
          agentCapabilities: [],
          triggers: ["build-finished"],
        },
      },
    });
    expect(trusted.status).toBe(201);
    const pluginId = trusted.body.data.id as string;
    expect(
      (
        await call(`/v1/settings/personal/plugins/${pluginId}`, {
          method: "PATCH",
          body: { enabled: true },
        })
      ).status,
    ).toBe(200);

    const created = await call("/v1/settings/personal/triggers", {
      method: "POST",
      body: {
        pluginId,
        pluginVersion: "1.0.0",
        capabilityName: "build-finished",
      },
    });
    expect(created.status).toBe(201);
    const { trigger, capability } = created.body.data as {
      trigger: { id: string };
      capability: { capabilityUrl: string };
    };

    const eventId = `evt-${crypto.randomUUID()}`;
    const webhook = await app.request(
      new URL(capability.capabilityUrl).pathname,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dx-timestamp": String(Date.now()),
          "x-dx-event-id": eventId,
          "x-dx-idempotency-key": eventId,
        },
        body: JSON.stringify({ event: "build.completed", data: { build: 7 } }),
      },
      bindings,
    );
    expect(webhook.status).toBe(202);

    const listed = await call("/v1/settings/personal/triggers");
    expect(listed.status).toBe(200);
    const items = listed.body.data.items as Array<{
      id: string;
      deliveries: Array<{ eventId: string; createdAt: string }>;
    }>;
    const delivery = items
      .find(({ id }) => id === trigger.id)
      ?.deliveries.find((item) => item.eventId === eventId);
    expect(delivery).toBeDefined();
    expect(Number.isNaN(Date.parse(delivery?.createdAt ?? ""))).toBe(false);

    const paused = await call(`/v1/settings/personal/triggers/${trigger.id}`, {
      method: "PATCH",
      body: { status: "paused" },
    });
    expect(paused.status).toBe(200);
    expect(paused.body.data.status).toBe("paused");
  });
});
