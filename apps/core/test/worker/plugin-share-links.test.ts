import { env } from "cloudflare:test";
import type { UserId } from "@dx/domain";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import {
  buildZip,
  type FixtureEntry,
} from "../../src/settings/plugins/bundles/zip-fixture.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

/**
 * Share links for plugins (plugin plan M5). What can go wrong:
 *
 * - a link reveals or installs a plugin for someone without the link, or
 *   after the sharer stops sharing;
 * - someone who can't change an install creates a link for it;
 * - a recipient never hears of the sharer's new version, or gets wider
 *   permissions without reviewing them.
 */

const origin = "http://dx.test";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "plugin-share-route-secret-0000000000",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
} as Bindings;
const endpoint = "/v1/settings/personal/plugin-bundles";

let signups = 160;
const signup = async (email: string) => {
  signups += 1;
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `203.0.113.${signups}`,
      },
      body: JSON.stringify({
        name: "Update Owner",
        email,
        password: "plugin-update-password-123",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Expected session cookie.");
  const { user } = await response.json<{ user: { id: string } }>();
  return { cookie, userId: user.id as UserId };
};

const call = (
  path: string,
  cookie: string,
  init: { method?: string; json?: unknown; zip?: Uint8Array } = {},
) =>
  app.request(
    path,
    {
      method: init.method ?? ((init.json ?? init.zip) ? "POST" : "GET"),
      headers: {
        cookie,
        origin,
        ...(init.json === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(init.zip === undefined
          ? {}
          : { "content-type": "application/zip" }),
      },
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
      ...(init.zip === undefined ? {} : { body: init.zip.slice() }),
    },
    bindings,
  );

const codePlugin = (
  permissions: Record<string, unknown>,
  options: {
    readonly prefix?: string;
    readonly version?: string;
    readonly settings?: ReadonlyArray<unknown>;
    readonly tool?: string;
  } = {},
): ReadonlyArray<FixtureEntry> => [
  {
    name: `${options.prefix ?? ""}plugin.json`,
    content: JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.1.0/plugin.schema.json",
      name: "com.acme.updater",
      displayName: "Updater",
      version: options.version ?? "1.0.0",
      description: "A plugin that changes between versions.",
      extensions: {
        "dev.dxcode": {
          apiVersion: 1,
          entry: "dev.dxcode/index.js",
          permissions,
          ...(options.settings === undefined
            ? {}
            : { settings: options.settings }),
        },
      },
    }),
  },
  {
    name: `${options.prefix ?? ""}dev.dxcode/index.js`,
    content: `export default (dx) => dx.registerTool({ name: "which_version", description: "Says its version.", execute: () => ${JSON.stringify(options.tool ?? options.version ?? "1.0.0")} });`,
  },
];

const installZip = async (cookie: string, archive: Uint8Array) => {
  const preview = await call(`${endpoint}/preview?name=u.zip`, cookie, {
    zip: archive,
  });
  expect(preview.status).toBe(200);
  const reviewed = await preview.json<{ data: { integrity: string } }>();
  const installed = await call(
    `${endpoint}?name=u.zip&integrity=${reviewed.data.integrity}`,
    cookie,
    { zip: archive },
  );
  expect(installed.status).toBe(201);
  return (await installed.json<{ data: { id: string } }>()).data.id;
};

const preview = async (cookie: string, share: string) =>
  call(`${endpoint}/preview`, cookie, { json: { share } });

describe("plugin share links", () => {
  it("installs the sharer's plugin from a link, follows their updates, and stops when they stop sharing", async () => {
    const sharer = await signup("plugin-share-sharer@example.com");
    const recipient = await signup("plugin-share-recipient@example.com");
    const latecomer = await signup("plugin-share-latecomer@example.com");
    const id = await installZip(
      sharer.cookie,
      await buildZip(codePlugin({ events: ["tool.call"] })),
    );

    const created = await call(`${endpoint}/${id}/share`, sharer.cookie, {
      json: {},
    });
    expect(created.status).toBe(201);
    const link = (
      await created.json<{ data: { url: string; token: string } }>()
    ).data;
    expect(link.url).toBe(`${origin}/settings/plugins?share=${link.token}`);
    expect(link.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Only the link's hash is kept.
    const stored = await env.DB.prepare(
      "SELECT token_hash FROM plugin_share_link WHERE plugin_id = ?",
    )
      .bind(id)
      .first<{ token_hash: string }>();
    expect(stored?.token_hash).not.toContain(link.token);

    // Another person can't share the sharer's install.
    expect(
      (await call(`${endpoint}/${id}/share`, recipient.cookie, { json: {} }))
        .status,
    ).toBe(404);
    // A wrong token reveals nothing.
    expect((await preview(recipient.cookie, "x".repeat(43))).status).toBe(404);

    const reviewed = await preview(recipient.cookie, link.token);
    expect(reviewed.status).toBe(200);
    const first = await reviewed.json<{
      data: {
        integrity: string;
        source: { type: string; label: string };
        manifest: { name: string; version?: string };
      };
    }>();
    expect(first.data.source).toMatchObject({
      type: "share",
      label: "Shared by Update Owner",
    });
    expect(first.data.manifest).toMatchObject({
      name: "com.acme.updater",
      version: "1.0.0",
    });
    const installed = await call(endpoint, recipient.cookie, {
      json: { share: link.token, reviewedIntegrity: first.data.integrity },
    });
    expect(installed.status).toBe(201);
    const copy = (await installed.json<{ data: { id: string } }>()).data.id;
    expect(copy).not.toBe(id);

    // Nothing new yet.
    const quiet = await call(`${endpoint}/updates`, recipient.cookie);
    expect(
      (await quiet.json<{ data: { items: unknown } }>()).data.items,
    ).toEqual([{ pluginId: copy, available: false }]);

    // The sharer's 1.1.0 asks for the network: the recipient sees it as an
    // update that needs their acceptance.
    const sharerUpdate = await buildZip(
      codePlugin(
        { events: ["tool.call"], network: ["api.example.com"] },
        { version: "1.1.0" },
      ),
    );
    const sharerPreview = await call(
      `${endpoint}/${id}/update/preview?name=v2.zip`,
      sharer.cookie,
      { zip: sharerUpdate },
    );
    const sharerReviewed = await sharerPreview.json<{
      data: { integrity: string };
    }>();
    expect(
      (
        await call(
          `${endpoint}/${id}/update?name=v2.zip&integrity=${sharerReviewed.data.integrity}&acceptPermissions=1`,
          sharer.cookie,
          { zip: sharerUpdate },
        )
      ).status,
    ).toBe(200);
    const available = await call(`${endpoint}/updates`, recipient.cookie);
    expect(
      (await available.json<{ data: { items: unknown } }>()).data.items,
    ).toEqual([{ pluginId: copy, available: true }]);
    const update = await call(
      `${endpoint}/${copy}/update/preview`,
      recipient.cookie,
      { json: {} },
    );
    expect(update.status).toBe(200);
    const next = await update.json<{
      data: {
        integrity: string;
        source: unknown;
        permissions: { widens: boolean };
      };
    }>();
    expect(next.data.permissions.widens).toBe(true);
    const applied = await call(`${endpoint}/${copy}/update`, recipient.cookie, {
      json: {
        source: next.data.source,
        reviewedIntegrity: next.data.integrity,
        acceptPermissions: true,
      },
    });
    expect(applied.status).toBe(200);
    expect(
      (await applied.json<{ data: { version?: string } }>()).data.version,
    ).toBe("1.1.0");

    // The sharer stops sharing: the link opens nothing and updates stop.
    const stopped = await call(`${endpoint}/${id}/share`, sharer.cookie, {
      method: "DELETE",
    });
    expect(stopped.status).toBe(200);
    expect((await preview(latecomer.cookie, link.token)).status).toBe(404);
    const after = await call(
      `${endpoint}/${copy}/update/preview`,
      recipient.cookie,
      { json: {} },
    );
    expect(after.status).toBe(502);
    expect(
      (await after.json<{ data: { message: string } }>()).data.message,
    ).toMatch(/no longer shared/);
  });
});
