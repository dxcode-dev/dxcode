import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { buildZip } from "../../src/settings/plugins/bundles/zip-fixture.js";
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

/** An Agent Plugins ZIP whose code handles trigger.received. */
const pluginZip = () =>
  buildZip([
    {
      name: "plugin.json",
      content: JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
        name: "com.example.build-notifier",
        displayName: "Build notifier",
        version: "1.0.0",
        extensions: {
          "dev.dxcode": {
            apiVersion: 1,
            entry: "dev.dxcode/index.js",
            permissions: { events: ["trigger.received"] },
          },
        },
      }),
    },
    {
      name: "dev.dxcode/index.js",
      content: "export default (dx) => dx.on('trigger.received', () => {});",
    },
  ]);

const zipCall = (cookie: string, path: string, zip: Uint8Array) =>
  app.request(
    path,
    {
      method: "POST",
      headers: { cookie, origin, "content-type": "application/zip" },
      body: zip.slice(),
    },
    bindings,
  );

describe("personal plugin triggers with deliveries", () => {
  it("lists a trigger and changes its state after a webhook arrives", async () => {
    const cookie = await signUp();
    const call = settings(cookie);
    const zip = await pluginZip();
    const preview = await zipCall(
      cookie,
      "/v1/settings/personal/plugin-bundles/preview?name=n.zip",
      zip,
    );
    expect(preview.status).toBe(200);
    const { data: reviewed } = await preview.json<{
      data: { integrity: string };
    }>();
    const installed = await zipCall(
      cookie,
      `/v1/settings/personal/plugin-bundles?name=n.zip&integrity=${reviewed.integrity}`,
      zip,
    );
    expect(installed.status).toBe(201);
    const { data: plugin } = await installed.json<{ data: { id: string } }>();
    const pluginId = plugin.id;
    // Settings → Triggers offers the plugin's webhook with dx's version.
    const offered = (
      (await call("/v1/settings/personal/triggers")).body.data
        .availableCapabilities as Array<{
        pluginId: string;
        version: string;
        capabilityName: string;
      }>
    ).find((capability) => capability.pluginId === pluginId);
    expect(offered?.capabilityName).toBe("webhook");

    const created = await call("/v1/settings/personal/triggers", {
      method: "POST",
      body: {
        pluginId,
        pluginVersion: offered?.version,
        capabilityName: "webhook",
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
        body: JSON.stringify({ event: "trigger.received", data: { build: 7 } }),
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
