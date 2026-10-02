import * as Redacted from "effect/Redacted";
import { describe, expect, it, vi } from "vitest";
import { reconcileHeldSecret } from "./alchemy-resources.ts";
import {
  cloudflareRequestAuth,
  preflightCloudflareDeployment,
} from "./cloudflare-auth.mjs";
import { validateSelfhostConfig } from "./config.mjs";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadDxdRelease,
  loadDxdRelease,
  verifyDxdBytes,
} from "./dxd-release.mjs";
import { hashE2BRecipe, reconcileE2BProfiles } from "./e2b.mjs";

describe("exportable self-host configuration", () => {
  it("rejects secrets and private policy in the nonsecret file", () => {
    for (const input of [
      { name: "mine", adminEmail: "me@example.com", adminPassword: "secret" },
      { name: "mine", adminEmail: "me@example.com", accountId: "private" },
      { name: "mine", adminEmail: "me@example.com", reviewerEmail: "private" },
    ])
      expect(() => validateSelfhostConfig(input)).toThrow(
        "unsupported or secret keys",
      );
  });

  it("requires a custom domain and zone as one bounded pair", () => {
    expect(() =>
      validateSelfhostConfig({
        name: "mine",
        adminEmail: "me@example.com",
        domain: "dx.example.com",
      }),
    ).toThrow("domain and zone");
    expect(() =>
      validateSelfhostConfig({
        name: "mine",
        adminEmail: "me@example.com",
        domain: "dx.attacker.test",
        zone: "example.com",
      }),
    ).toThrow("inside zone");
  });

  it("accepts its normalized versioned output on repeat deploy", () => {
    const first = validateSelfhostConfig({
      name: "mine",
      cloudflareAccountId: "a".repeat(32),
      adminEmail: "me@example.com",
    });
    expect(validateSelfhostConfig(first)).toEqual(first);
    expect(() =>
      validateSelfhostConfig({
        name: "mine",
        cloudflareAccountId: "wrong",
        adminEmail: "me@example.com",
      }),
    ).toThrow("32-character account ID");
  });

  it("enables generic hosted authentication only with a sender in the deployment zone", () => {
    const hosted = validateSelfhostConfig({
      name: "hosted",
      domain: "app.example.com",
      zone: "example.com",
      authEmailFrom: "SIGN-IN@example.com",
      adminEmail: "OWNER@example.com",
    });
    expect(hosted).toMatchObject({
      authEmailFrom: "sign-in@example.com",
      adminEmail: "owner@example.com",
    });
    expect(
      validateSelfhostConfig({
        ...hosted,
        authEmailFrom: "SIGN-IN@auth.example.com",
      }).authEmailFrom,
    ).toBe("sign-in@auth.example.com");
    expect(() =>
      validateSelfhostConfig({
        ...hosted,
        authEmailFrom: "sign-in@other.example",
      }),
    ).toThrow("inside the deployment zone");
  });
});

describe("held deployment secrets", () => {
  it("retains an encrypted prior value when an upgrade omits it", () => {
    const prior = { value: Redacted.make("existing") };
    expect(reconcileHeldSecret({ output: prior })).toBe(prior);
    const rotated = Redacted.make("rotated");
    expect(reconcileHeldSecret({ output: prior, value: rotated })).toEqual({
      value: rotated,
    });
  });

  it("rejects an omitted first-deploy secret", () => {
    expect(() => reconcileHeldSecret({})).toThrow(
      "missing on its first deployment",
    );
  });
});

describe("shared Cloudflare authentication", () => {
  it.each([
    [
      { type: "oauth", accountId: "a", accessToken: Redacted.make("oauth") },
      "alchemy-oauth",
      { Authorization: "Bearer oauth" },
    ],
    [
      { type: "apiToken", accountId: "a", apiToken: Redacted.make("token") },
      "api-token",
      { Authorization: "Bearer token" },
    ],
  ])(
    "uses one resolved credential for preflight (%s)",
    (input, method, headers) => {
      expect(cloudflareRequestAuth(input)).toEqual({
        accountId: "a",
        method,
        headers,
      });
    },
  );

  it("checks the matching Alchemy store and Email Sending domain", async () => {
    const results = new Map([
      [
        "/accounts/account/workers/scripts/alchemy-state-store/script-settings",
        {},
      ],
      [
        "/accounts/account/secrets_store/stores?per_page=100",
        [{ id: "unrelated" }, { id: "alchemy" }],
      ],
      [
        "/accounts/account/secrets_store/stores/unrelated/secrets?per_page=100",
        [{ name: "OtherSecret", status: "active" }],
      ],
      [
        "/accounts/account/secrets_store/stores/alchemy/secrets?per_page=100",
        [
          { name: "AlchemyStateStoreToken", status: "active" },
          { name: "AlchemyStateStoreEncryptionKey", status: "active" },
        ],
      ],
      [
        "/zones?account.id=account&name=example.com&status=active",
        [{ id: "zone" }],
      ],
      [
        "/zones/zone/email/sending/subdomains",
        [{ name: "mail.example.com", enabled: true }],
      ],
      ["/accounts/account/d1/database?per_page=1", []],
      ["/accounts/account/r2/buckets?per_page=1", []],
      ["/accounts/account/challenges/widgets?per_page=1", []],
      ["/zones/zone/workers/routes", []],
    ]);
    const fetch = vi.fn(async (url) => {
      const parsed = new URL(url);
      const path = parsed.pathname.replace("/client/v4", "") + parsed.search;
      return new Response(
        JSON.stringify({
          success: true,
          result: results.get(path),
        }),
        { status: 200 },
      );
    });

    await expect(
      preflightCloudflareDeployment({
        auth: {
          accountId: "account",
          headers: { Authorization: "Bearer x" },
          method: "api-token",
        },
        zone: "example.com",
        authEmailFrom: "NO-REPLY@mail.example.com",
        fetch,
      }),
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(10);
    expect(fetch).not.toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/account",
      expect.anything(),
    );
  });

  it("rejects Alchemy OAuth for hosted resources before provider credentials", async () => {
    const fetch = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/script-settings"))
        return new Response(null, { status: 404 });
      if (path.endsWith("/stores"))
        return Response.json({ success: true, result: [] });
      if (path === "/client/v4/zones")
        return Response.json({ success: true, result: [{ id: "zone" }] });
      throw new Error(`Unexpected Cloudflare request: ${url}`);
    });

    await expect(
      preflightCloudflareDeployment({
        auth: {
          accountId: "account",
          headers: { Authorization: "Bearer x" },
          method: "alchemy-oauth",
        },
        zone: "example.com",
        authEmailFrom: "no-reply@example.com",
        fetch,
      }),
    ).rejects.toThrow("requires a Cloudflare API token");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("identifies the Cloudflare product whose token permission is missing", async () => {
    const fetch = vi.fn(async (url) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/script-settings"))
        return new Response(null, { status: 404 });
      if (parsed.pathname.endsWith("/stores"))
        return Response.json({ success: true, result: [] });
      if (parsed.pathname === "/client/v4/zones")
        return Response.json({ success: true, result: [{ id: "zone" }] });
      if (parsed.pathname.endsWith("/challenges/widgets"))
        return Response.json({ success: false }, { status: 403 });
      return Response.json({ success: true, result: [] });
    });

    await expect(
      preflightCloudflareDeployment({
        auth: {
          accountId: "account",
          headers: { Authorization: "Bearer x" },
          method: "api-token",
        },
        zone: "example.com",
        authEmailFrom: "no-reply@example.com",
        fetch,
      }),
    ).rejects.toThrow("Turnstile permission read failed (403)");
  });

  it("rejects incomplete Alchemy state before credential collection", async () => {
    const fetch = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      const result = path.endsWith("/script-settings")
        ? {}
        : path.endsWith("/stores")
          ? [{ id: "incomplete" }]
          : path.endsWith("/secrets")
            ? [{ name: "OtherSecret", status: "active" }]
            : { id: "account" };
      return new Response(JSON.stringify({ success: true, result }), {
        status: 200,
      });
    });

    await expect(
      preflightCloudflareDeployment({
        auth: { accountId: "account", headers: {} },
        fetch,
      }),
    ).rejects.toThrow("state store exists without its active token");
  });
});

describe("E2B profile reconciliation", () => {
  const ready = (name, buildID) => ({
    names: [name],
    buildStatus: "ready",
    buildID,
  });

  it("changes the recipe identity for every immutable build input", () => {
    const input = {
      workspaceRecipe: "workspace-v1",
      orbRecipe: "orb-v1",
      profileCatalog: [{ id: "a1.small", cpu: 2 }],
    };
    const hash = hashE2BRecipe(input);
    expect(
      hashE2BRecipe({ ...input, workspaceRecipe: "workspace-v2" }),
    ).not.toBe(hash);
    expect(hashE2BRecipe({ ...input, orbRecipe: "orb-v2" })).not.toBe(hash);
    expect(
      hashE2BRecipe({
        ...input,
        profileCatalog: [{ id: "a1.small", cpu: 4 }],
      }),
    ).not.toBe(hash);
  });

  it("builds zero templates when the recipe and all profile aliases exist", async () => {
    const prefix = "dx-mine-0123456789abcdef";
    const listTemplates = vi.fn(async () => [
      ready(`${prefix}-base`, "base-build"),
      ready(`${prefix}-a1-tiny`, "tiny-build"),
      ready(`${prefix}-a1-small`, "small-build"),
      ready(`${prefix}-a1-medium`, "medium-build"),
    ]);
    const buildTemplate = vi.fn();
    const result = await reconcileE2BProfiles({
      deploymentName: "mine",
      apiKey: "redacted",
      listTemplates,
      buildTemplate,
      recipeHash: "0123456789abcdef".padEnd(64, "0"),
    });
    expect(buildTemplate).not.toHaveBeenCalled();
    expect(
      result.profiles.map(({ template, buildId }) => `${template}:${buildId}`),
    ).toEqual([
      `${prefix}-a1-tiny:tiny-build`,
      `${prefix}-a1-small:small-build`,
      `${prefix}-a1-medium:medium-build`,
    ]);
  });

  it("reports the exact rejected E2B profile size", async () => {
    const prefix = "dx-mine-0123456789abcdef";
    await expect(
      reconcileE2BProfiles({
        deploymentName: "mine",
        apiKey: "redacted",
        recipeHash: "0123456789abcdef".padEnd(64, "0"),
        listTemplates: async () => [ready(`${prefix}-base`, "base-build")],
        buildTemplate: vi.fn(async () => {
          throw new Error("plan limit");
        }),
      }),
    ).rejects.toThrow("a1.tiny (1 vCPU, 2048 MB)");
  });

  it("reports the exact rejected E2B base size", async () => {
    await expect(
      reconcileE2BProfiles({
        deploymentName: "mine",
        apiKey: "redacted",
        recipeHash: "0123456789abcdef".padEnd(64, "0"),
        listTemplates: async () => [],
        buildTemplate: vi.fn(async () => {
          throw new Error("plan limit");
        }),
      }),
    ).rejects.toThrow("base template (2 vCPU, 4096 MB)");
  });
});

describe("dxd release integrity", () => {
  it("refuses a recorded dxd older than the revision's dxd", () => {
    const root = mkdtempSync(join(tmpdir(), "dxd-release-"));
    mkdirSync(join(root, "deploy"));
    mkdirSync(join(root, "apps/dxd"), { recursive: true });
    const record = (dxd) =>
      writeFileSync(
        join(root, "deploy/RELEASE.json"),
        JSON.stringify({
          version: 1,
          release: "v0.1.2",
          dxd,
          platform: "linux-x64",
          asset: "dxd-linux-x64",
          url: "https://github.com/o/r/releases/download/v0.1.2/dxd-linux-x64",
          sha256: "a".repeat(64),
        }),
      );
    writeFileSync(
      join(root, "apps/dxd/Cargo.toml"),
      '[package]\nname = "dxd"\nversion = "0.8.0"\n',
    );
    record(undefined);
    expect(() => loadDxdRelease(root)).toThrow(
      "does not describe one exact Linux x64 dxd asset",
    );
    record("0.7.6");
    expect(() => loadDxdRelease(root)).toThrow(
      "names dxd 0.7.6, but this revision is dxd 0.8.0",
    );
    record("0.8.0");
    expect(loadDxdRelease(root)).toMatchObject({
      release: "v0.1.2",
      dxd: "0.8.0",
    });
  });

  it("downloads public assets anonymously", async () => {
    const fetcher = vi.fn(async () => new Response("public-dxd"));
    await expect(
      downloadDxdRelease(
        {
          release: "v0.1.0",
          asset: "dxd-linux-x64",
          url: "https://releases.example/dxd-linux-x64",
        },
        { fetcher },
      ),
    ).resolves.toEqual(Buffer.from("public-dxd"));
    expect(fetcher).toHaveBeenCalledWith(
      "https://releases.example/dxd-linux-x64",
      { redirect: "follow" },
    );
  });

  it("resolves a private GitHub asset without exposing its bearer token", async () => {
    const token = "private-token-fixture";
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          assets: [
            {
              name: "dxd-linux-x64",
              url: "https://api.github.com/repos/example/dxcode/releases/assets/7",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response("private-dxd"));
    await expect(
      downloadDxdRelease(
        {
          release: "v0.1.0-rc.1",
          asset: "dxd-linux-x64",
          url: "https://github.com/example/dxcode/releases/download/v0.1.0-rc.1/dxd-linux-x64",
        },
        { fetcher, githubToken: token },
      ),
    ).resolves.toEqual(Buffer.from("private-dxd"));
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/example/dxcode/releases/tags/v0.1.0-rc.1",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: `Bearer ${token}` }),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      "https://api.github.com/repos/example/dxcode/releases/assets/7",
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: "application/octet-stream",
          Authorization: `Bearer ${token}`,
        }),
      }),
    );
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain(`?token=${token}`);
  });

  it("does not include a private GitHub token in download errors", async () => {
    const token = "private-error-token-fixture";
    await expect(
      downloadDxdRelease(
        {
          release: "v0.1.0-rc.1",
          asset: "dxd-linux-x64",
          url: "https://github.com/example/dxcode/releases/download/v0.1.0-rc.1/dxd-linux-x64",
        },
        {
          fetcher: vi.fn(async () => new Response(null, { status: 404 })),
          githubToken: token,
        },
      ),
    ).rejects.not.toThrow(token);
  });

  it("fails before mutation on checksum drift", () => {
    expect(() =>
      verifyDxdBytes(Buffer.from("wrong"), {
        sha256: "0".repeat(64),
      }),
    ).toThrow("No deployment changes were made");
  });
});
