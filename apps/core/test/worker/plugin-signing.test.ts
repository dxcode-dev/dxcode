import { env } from "cloudflare:test";
import type { UserId } from "@dx/domain";
import { Effect } from "effect";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { readZipArchive } from "../../src/settings/plugins/bundles/zip.js";
import {
  buildZip,
  type FixtureEntry,
} from "../../src/settings/plugins/bundles/zip-fixture.js";
import {
  TEST_CONFIG_ENCRYPTION_KEYS,
  TEST_RUNNER_PROFILE_CATALOG,
} from "../../src/testing/bindings.js";
import { network } from "./network-boundary.js";

/**
 * Plugin signing (plugin plan M5). A plugin may carry `plugin.sig`: an SSH
 * signature (`ssh-keygen -Y sign -n dx-plugin`) over a sha256sum listing of
 * its other files. What can go wrong:
 *
 * - a signature from stock ssh-keygen doesn't verify, or one over other
 *   files does;
 * - a tampered plugin installs as signed, or quietly as unsigned;
 * - a plugin looks like it comes from a publisher whose DNS doesn't list
 *   the signer's key, or from the person when the key isn't theirs;
 * - dx's own export can't be signed with the person's managed key, or that
 *   signature doesn't verify on import.
 *
 * The fixture's signature was made with OpenSSH's ssh-keygen over these
 * exact files; its key is fixed below.
 */

const files: Record<string, string> = {
  "plugin.json":
    '{"$schema":"https://agent-plugins.org/schemas/1.1.0/plugin.schema.json","name":"com.acme.signed","displayName":"Signed","version":"1.0.0","description":"A signed plugin.","extensions":{"dev.dxcode":{"apiVersion":1,"entry":"dev.dxcode/index.js","permissions":{"events":["agent.end"]}}}}\n',
  "dev.dxcode/index.js": "export default () => {};\n",
  "skills/notes/SKILL.md":
    "---\nname: notes\ndescription: Use to take notes.\n---\n\nTake notes.\n",
};
const signature =
  "-----BEGIN SSH SIGNATURE-----\nU1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAg3lLU3HiyAPpBJTfZhXbFWGOjfR\nDoEw95uGnuEs0HyZEAAAAJZHgtcGx1Z2luAAAAAAAAAAZzaGE1MTIAAABTAAAAC3NzaC1l\nZDI1NTE5AAAAQMbgszd8J9iMkcInNhdys7DowbEidqVYhGAioheeI8hCnPx9V5KTrTSTLb\n/maCIQh/GeaT8CdMX5cIWPDX3ILQ8=\n-----END SSH SIGNATURE-----\n";
const publicKey =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIN5S1Nx4sgD6QSU32YV2xVhjo30Q6BMPebhp7hLNB8mR";
const fingerprint = "SHA256:9wmXe/075eN/BLBm95MuE0dI3/usDPjqnvGd1PfESjI";
const otherKey =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMUUaJ0fn0p6xiyEVrKKSHM2wkMeJZkf3k8IQZMzCBBo";

const plugin = (
  overrides: Record<string, string> = {},
  signed = true,
): ReadonlyArray<FixtureEntry> => [
  ...Object.entries({ ...files, ...overrides }).map(([name, content]) => ({
    name,
    content,
  })),
  ...(signed ? [{ name: "plugin.sig", content: signature }] : []),
];

const origin = "http://dx.test";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "plugin-sign-route-secret-0000000000",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_MANAGED_SSH_SIGNING_ENABLED: "true",
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
} as Bindings;
const endpoint = "/v1/settings/personal/plugin-bundles";

let signups = 200;
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

interface SignedPreview {
  readonly data: {
    readonly integrity: string;
    readonly conflicts: ReadonlyArray<string>;
    readonly signature?: {
      readonly fingerprint: string;
      readonly publicKey: string;
      readonly signer: { readonly kind: string; readonly domain?: string };
    };
  };
}

const previewZip = async (
  cookie: string,
  entries: ReadonlyArray<FixtureEntry>,
) => {
  const response = await call(`${endpoint}/preview?name=s.zip`, cookie, {
    zip: await buildZip(entries),
  });
  expect(response.status).toBe(200);
  return (await response.json<SignedPreview>()).data;
};

/** `_dx-plugins.acme.com` lists `keys` as dx-key records. */
const publisherDns = (keys: ReadonlyArray<string>) =>
  network.use(
    http.get("https://cloudflare-dns.com/dns-query", ({ request }) =>
      HttpResponse.json(
        new URL(request.url).searchParams.get("name") === "_dx-plugins.acme.com"
          ? {
              Answer: keys.map((key) => ({
                type: 16,
                data: `"dx-key=${key}"`,
              })),
            }
          : {},
      ),
    ),
  );

describe("plugin signing", () => {
  it("verifies a stock ssh-keygen signature, keeps it with the install, and refuses a tampered plugin", async () => {
    const { cookie } = await signup("plugin-sign-basic@example.com");
    publisherDns([]);
    const signed = await previewZip(cookie, plugin());
    expect(signed.conflicts).toEqual([]);
    expect(signed.signature).toEqual({
      fingerprint,
      publicKey,
      signer: { kind: "key" },
    });

    // One changed byte in a signed file: the signature no longer matches.
    const tampered = await previewZip(
      cookie,
      plugin({ "skills/notes/SKILL.md": `${files["skills/notes/SKILL.md"]} ` }),
    );
    expect(tampered.signature).toBeUndefined();
    expect(tampered.conflicts).toEqual([
      "plugin.sig does not match the plugin's files, so it may have been changed after it was signed.",
    ]);
    const refused = await call(
      `${endpoint}?name=s.zip&integrity=${tampered.integrity}`,
      cookie,
      {
        zip: await buildZip(
          plugin({
            "skills/notes/SKILL.md": `${files["skills/notes/SKILL.md"]} `,
          }),
        ),
      },
    );
    expect(refused.status).toBe(400);

    // An added file is not covered by the signature either.
    const added = await previewZip(cookie, plugin({ "extra.md": "Hi." }));
    expect(added.conflicts).toHaveLength(1);

    // Unsigned plugins install as before, with no signature.
    expect(
      (await previewZip(cookie, plugin({}, false))).signature,
    ).toBeUndefined();

    const installed = await call(
      `${endpoint}?name=s.zip&integrity=${signed.integrity}`,
      cookie,
      { zip: await buildZip(plugin()) },
    );
    expect(installed.status).toBe(201);
    const listed = await call(endpoint, cookie);
    expect(
      (
        await listed.json<{
          data: { items: Array<{ signature?: unknown }> };
        }>()
      ).data.items[0]?.signature,
    ).toEqual({ fingerprint, publicKey, signer: { kind: "key" } });
  });

  it("keeps the verified signature on a shared copy of the signed version", async () => {
    const sharer = await signup("plugin-sign-sharer@example.com");
    const recipient = await signup("plugin-sign-recipient@example.com");
    publisherDns([publicKey]);
    const signed = await previewZip(sharer.cookie, plugin());
    const installed = await call(
      `${endpoint}?name=s.zip&integrity=${signed.integrity}`,
      sharer.cookie,
      { zip: await buildZip(plugin()) },
    );
    const id = (await installed.json<{ data: { id: string } }>()).data.id;
    const link = await call(`${endpoint}/${id}/share`, sharer.cookie, {
      json: {},
    });
    const { token } = (await link.json<{ data: { token: string } }>()).data;
    const shared = await call(`${endpoint}/preview`, recipient.cookie, {
      json: { share: token },
    });
    expect((await shared.json<SignedPreview>()).data.signature).toEqual({
      fingerprint,
      publicKey,
      signer: { kind: "publisher", domain: "acme.com" },
    });
  });

  it("names the publisher only when the domain the plugin's name claims lists the signer's key", async () => {
    const { cookie } = await signup("plugin-sign-publisher@example.com");
    publisherDns([otherKey]);
    expect((await previewZip(cookie, plugin())).signature?.signer).toEqual({
      kind: "key",
    });
    publisherDns([otherKey, publicKey]);
    expect((await previewZip(cookie, plugin())).signature?.signer).toEqual({
      kind: "publisher",
      domain: "acme.com",
    });
  });

  it("calls the person's own Signing Keys key theirs, and signs an export with their managed key", async () => {
    const { cookie } = await signup("plugin-sign-own@example.com");
    publisherDns([]);
    const added = await call(
      "/v1/settings/personal/keys/verification",
      cookie,
      {
        json: { name: "Laptop", publicKey },
      },
    );
    expect(added.status).toBe(201);
    expect((await previewZip(cookie, plugin())).signature?.signer).toEqual({
      kind: "you",
    });

    // dx signs an export with the managed key from Signing Keys.
    const managed = await call("/v1/settings/personal/keys/managed", cookie, {
      json: {},
    });
    expect(managed.status).toBe(201);
    const managedKey = (
      await managed.json<{
        data: { key: { publicKey: string; fingerprint: string } };
      }>()
    ).data.key;
    const reviewed = await previewZip(cookie, plugin({}, false));
    const installed = await call(
      `${endpoint}?name=s.zip&integrity=${reviewed.integrity}`,
      cookie,
      { zip: await buildZip(plugin({}, false)) },
    );
    const id = (await installed.json<{ data: { id: string } }>()).data.id;
    const plainExport = await call(`${endpoint}/${id}/export`, cookie);
    const plainEntries = await Effect.runPromise(
      readZipArchive(new Uint8Array(await plainExport.arrayBuffer()), {
        maxArchiveBytes: 16 * 1024 * 1024,
        maxEntries: 1_000,
      }),
    );
    expect(plainEntries.entries.map(({ path }) => path)).not.toContain(
      "plugin.sig",
    );
    const signedExport = await call(`${endpoint}/${id}/export?sign=1`, cookie);
    expect(signedExport.status).toBe(200);
    const bytes = new Uint8Array(await signedExport.arrayBuffer());
    const reimported = await call(`${endpoint}/preview?name=e.zip`, cookie, {
      zip: bytes,
    });
    const signatureOfExport = (await reimported.json<SignedPreview>()).data
      .signature;
    expect(signatureOfExport).toEqual({
      fingerprint: managedKey.fingerprint,
      publicKey: managedKey.publicKey,
      signer: { kind: "you" },
    });

    // Another person sees the same export as signed by an unknown key.
    const other = await signup("plugin-sign-other@example.com");
    const elsewhere = await call(
      `${endpoint}/preview?name=e.zip`,
      other.cookie,
      {
        zip: bytes,
      },
    );
    expect(
      (await elsewhere.json<SignedPreview>()).data.signature?.signer,
    ).toEqual({ kind: "key" });
  });
});
