import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProfileStore, ProfileStoreLive } from "alchemy/Auth/Profile";
import { PlatformServices } from "alchemy/Util/PlatformServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { describe, expect, it, vi } from "vitest";
import { readOrbContainers, reconcileHeldSecret } from "./alchemy-resources.ts";
import {
  alchemyCloudflareConnected,
  loadAlchemyCloudflareAuth,
  preflightCloudflareDeployment,
} from "./cloudflare-auth.mjs";
import { validateSelfhostConfig } from "./config.mjs";
import {
  downloadDxdRelease,
  loadDxdRelease,
  verifyDxdBytes,
} from "./dxd-release.mjs";
import { hashE2BRecipe, reconcileE2BProfiles } from "./e2b.mjs";
import {
  listPortalZoneCandidates,
  missingPortalOAuthScopes,
  PORTAL_OAUTH_SCOPES,
  preflightPortalZone,
} from "./portals.mjs";

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

  it("serves Portals only from a bare domain separate from the app", () => {
    const base = {
      name: "mine",
      adminEmail: "me@example.com",
      domain: "dx.example.com",
      zone: "example.com",
    };
    const config = validateSelfhostConfig({
      ...base,
      portalDomain: "Example-Portals.dev",
    });
    expect(config.portalDomain).toBe("example-portals.dev");
    expect(validateSelfhostConfig(config)).toEqual(config);
    expect(validateSelfhostConfig(base).portalDomain).toBeUndefined();
    // A workers.dev app takes any separate Portal zone.
    expect(
      validateSelfhostConfig({
        name: "mine",
        adminEmail: "me@example.com",
        portalDomain: "example-portals.dev",
      }).portalDomain,
    ).toBe("example-portals.dev");
    for (const portalDomain of [
      "https://example-portals.dev",
      "*.example-portals.dev",
      "localhost",
      "",
    ])
      expect(() => validateSelfhostConfig({ ...base, portalDomain })).toThrow(
        "portalDomain",
      );
  });

  it("refuses a Portal domain on the app's registrable domain", () => {
    const config = (domain, zone, portalDomain) => () =>
      validateSelfhostConfig({
        name: "mine",
        adminEmail: "me@example.com",
        domain,
        zone,
        portalDomain,
      });
    // The app's host, its parent, its child, or a sibling: one site, so guest
    // pages could set cookies for the app's site.
    for (const portalDomain of [
      "dx.example.com",
      "example.com",
      "portals.dx.example.com",
      "portals.example.com",
      "example-portals.example.com",
    ])
      expect(config("dx.example.com", "example.com", portalDomain)).toThrow(
        "portalDomain must be its own registrable domain, not on the app's site example.com",
      );
    // Multi-label public suffixes: the registrable domain is example.co.uk.
    for (const portalDomain of ["example.co.uk", "portals.example.co.uk"])
      expect(config("dx.example.co.uk", "example.co.uk", portalDomain)).toThrow(
        "not on the app's site example.co.uk",
      );
    expect(
      config("dx.example.co.uk", "example.co.uk", "other.co.uk")().portalDomain,
    ).toBe("other.co.uk");
    expect(
      config("dx.example.com", "example.com", "example-portals.dev")()
        .portalDomain,
    ).toBe("example-portals.dev");
    // workers.dev gives a script one hostname and no wildcard route.
    for (const portalDomain of ["workers.dev", "portals.acct.workers.dev"])
      expect(config("dx.example.com", "example.com", portalDomain)).toThrow(
        "portalDomain cannot be on workers.dev",
      );
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

  it("records the installed Orb providers, E2B for configs written before Containers", () => {
    const base = { name: "mine", adminEmail: "me@example.com" };
    expect(validateSelfhostConfig(base).orbProviders).toEqual(["e2b"]);
    expect(
      validateSelfhostConfig({ ...base, orbProviders: ["e2b", "cloudflare"] })
        .orbProviders,
    ).toEqual(["cloudflare", "e2b"]);
    expect(
      validateSelfhostConfig({ ...base, orbProviders: ["cloudflare"] })
        .orbProviders,
    ).toEqual(["cloudflare"]);
    // None: people and workspaces connect their own accounts.
    expect(
      validateSelfhostConfig({ ...base, orbProviders: [] }).orbProviders,
    ).toEqual([]);
    for (const orbProviders of [["other"], ["e2b", "e2b"], "e2b"])
      expect(() => validateSelfhostConfig({ ...base, orbProviders })).toThrow(
        "orbProviders",
      );
  });

  it("records how the deployment signs in to Cloudflare", () => {
    const base = {
      name: "mine",
      adminEmail: "me@example.com",
      domain: "dx.example.com",
      zone: "example.com",
      authEmailFrom: "dx@example.com",
      signIn: { providers: ["email-password"], admission: "invite" },
    };
    // Configs written before the field existed record nothing.
    expect(validateSelfhostConfig(base).cloudflareAuth).toBeUndefined();
    expect(
      validateSelfhostConfig({ ...base, cloudflareAuth: "alchemy-oauth" })
        .cloudflareAuth,
    ).toBe("alchemy-oauth");
    expect(
      validateSelfhostConfig({ ...base, cloudflareAuth: "api-token" })
        .cloudflareAuth,
    ).toBe("api-token");
    expect(() =>
      validateSelfhostConfig({ ...base, cloudflareAuth: "password" }),
    ).toThrow("cloudflareAuth");
    // Magic link needs a Turnstile widget, which only a token can create.
    expect(() =>
      validateSelfhostConfig({
        ...base,
        cloudflareAuth: "alchemy-oauth",
        signIn: { providers: ["magic-link"], admission: "invite" },
      }),
    ).toThrow("Magic-link sign-in needs a Cloudflare API token");
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
      // The bucket-scoped attachment signing token needs token management.
      ["/accounts/account/tokens?per_page=1", []],
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
    expect(fetch).toHaveBeenCalledTimes(11);
    expect(fetch).not.toHaveBeenCalledWith(
      "https://api.cloudflare.com/client/v4/accounts/account",
      expect.anything(),
    );
  });

  it("rejects Alchemy OAuth for magic-link sign-in, whose Turnstile it cannot manage", async () => {
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
        magicLink: true,
        fetch,
      }),
    ).rejects.toThrow("Magic-link sign-in needs a Cloudflare API token");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("lets Alchemy OAuth deploy notification email, which needs no Turnstile", async () => {
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
    const log = vi.fn();

    await expect(
      preflightCloudflareDeployment({
        auth: {
          accountId: "account",
          headers: { Authorization: "Bearer x" },
          method: "alchemy-oauth",
        },
        zone: "example.com",
        authEmailFrom: "no-reply@example.com",
        magicLink: false,
        fetch,
        log,
      }),
    ).resolves.toBeUndefined();
    // Neither Turnstile nor Email Sending is asked of a login without them.
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Email Sending"));
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
  it("builds each recipe its own templates, so a branch recipe never replaces staging's", async () => {
    const built = async (recipeHash) => {
      const names = [];
      await reconcileE2BProfiles({
        deploymentName: "staging",
        apiKey: "redacted",
        listTemplates: async () => [],
        buildTemplate: async (_template, name) => {
          names.push(name);
          return { name, buildId: `${name}-build` };
        },
        recipeHash,
      });
      return names;
    };
    const main = await built("a".repeat(64));
    const branch = await built("b".repeat(64));
    expect(main).toHaveLength(4);
    expect(
      main.every((name) => name.startsWith(`dx-staging-${"a".repeat(16)}-`)),
    ).toBe(true);
    expect(branch.filter((name) => main.includes(name))).toEqual([]);
  });

  it("waits for a build another deployment of the team started instead of building again", async () => {
    const prefix = "dx-staging-0123456789abcdef";
    const listing = (baseStatus) => [
      { ...ready(`${prefix}-base`, "base-build"), buildStatus: baseStatus },
      ready(`${prefix}-a1-tiny`, "tiny-build"),
      ready(`${prefix}-a1-small`, "small-build"),
      ready(`${prefix}-a1-medium`, "medium-build"),
    ];
    const listTemplates = vi
      .fn()
      .mockResolvedValueOnce(listing("building"))
      .mockResolvedValueOnce(listing("waiting"))
      .mockResolvedValue(listing("ready"));
    const buildTemplate = vi.fn();
    const result = await reconcileE2BProfiles({
      deploymentName: "staging",
      apiKey: "redacted",
      listTemplates,
      buildTemplate,
      recipeHash: "0123456789abcdef".padEnd(64, "0"),
      wait: { pollMs: 1, timeoutMs: 60_000 },
    });
    expect(buildTemplate).not.toHaveBeenCalled();
    expect(result.base).toEqual({
      name: `${prefix}-base`,
      buildId: "base-build",
    });
    await expect(
      reconcileE2BProfiles({
        deploymentName: "staging",
        apiKey: "redacted",
        listTemplates: async () => listing("building"),
        buildTemplate,
        recipeHash: "0123456789abcdef".padEnd(64, "0"),
        wait: { pollMs: 1, timeoutMs: 5 },
      }),
    ).rejects.toThrow("still building");
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

describe("Portal zone preflight", () => {
  const accountId = "a".repeat(32);
  const zoneId = "b".repeat(32);
  const portalDomain = "example-portals.dev";
  const zone = {
    id: zoneId,
    name: portalDomain,
    status: "active",
    account: { id: accountId },
  };
  const tokenAuth = {
    accountId,
    headers: { Authorization: "Bearer x" },
    method: "api-token",
  };
  const policy = (groups, resources) => ({
    effect: "allow",
    permission_groups: groups.map((name) => ({ name })),
    resources: resources ?? {
      [`com.cloudflare.api.account.zone.${zoneId}`]: "*",
    },
  });
  const allPermissions = [
    policy(["Zone Read", "DNS Write", "Workers Routes Write"]),
  ];
  // A Cloudflare API whose answers can each be replaced or refused (403).
  const cloudflare = (overrides = {}) => {
    const results = {
      [`/zones?account.id=${accountId}&name=${portalDomain}`]: [zone],
      [`/zones/${zoneId}`]: zone,
      [`/zones/${zoneId}/dns_records?per_page=1`]: [],
      [`/zones/${zoneId}/workers/routes`]: [],
      [`/accounts/${accountId}/tokens/verify`]: { id: "token" },
      [`/accounts/${accountId}/tokens/token`]: { policies: allPermissions },
      ...overrides,
    };
    return vi.fn(async (url, init) => {
      // Every probe is a read.
      expect(init?.method ?? "GET").toBe("GET");
      const parsed = new URL(url);
      const path = parsed.pathname.replace("/client/v4", "") + parsed.search;
      if (!(path in results))
        throw new Error(`Unexpected Cloudflare request: ${path}`);
      const result = results[path];
      return result === 403
        ? Response.json({ success: false }, { status: 403 })
        : Response.json({ success: true, result });
    });
  };

  it("passes with Zone Read, DNS Edit, and Workers Routes Edit on the zone", async () => {
    await expect(
      preflightPortalZone({
        auth: tokenAuth,
        portalDomain,
        fetch: cloudflare(),
      }),
    ).resolves.toEqual({ zoneId, editConfirmed: true });
    // The runner knows the zone ID; an account-wide zone grant counts.
    await expect(
      preflightPortalZone({
        auth: tokenAuth,
        portalDomain,
        zoneId,
        fetch: cloudflare({
          [`/accounts/${accountId}/tokens/token`]: {
            policies: [
              policy(["Zone Read", "DNS Write", "Workers Routes Write"], {
                [`com.cloudflare.api.account.${accountId}`]: {
                  "com.cloudflare.api.account.zone.*": "*",
                },
              }),
            ],
          },
        }),
      }),
    ).resolves.toEqual({ zoneId, editConfirmed: true });
  });

  it("names each missing permission and the zone", async () => {
    const otherZone = { "com.cloudflare.api.account.zone.other": "*" };
    for (const [overrides, message] of [
      [
        { [`/zones?account.id=${accountId}&name=${portalDomain}`]: [] },
        `Zone ${portalDomain} is not visible in Cloudflare account ${accountId}. The Portal domain must be the apex of a zone in this account, and the Cloudflare API token needs Zone Read on it.`,
      ],
      [
        { [`/zones/${zoneId}/dns_records?per_page=1`]: 403 },
        `The Cloudflare API token lacks DNS Edit on the Portal zone ${portalDomain}. Add Zone → DNS → Edit for ${portalDomain} to the token, then rerun.`,
      ],
      [
        { [`/zones/${zoneId}/workers/routes`]: 403 },
        `The Cloudflare API token lacks Workers Routes Edit on the Portal zone ${portalDomain}. Add Zone → Workers Routes → Edit for ${portalDomain} to the token, then rerun.`,
      ],
      // Read access alone: the token's policies grant no Edit.
      [
        {
          [`/accounts/${accountId}/tokens/token`]: {
            policies: [
              policy(["Zone Read", "DNS Read", "Workers Routes Write"]),
            ],
          },
        },
        `The Cloudflare API token lacks DNS Edit on the Portal zone ${portalDomain}.`,
      ],
      [
        {
          [`/accounts/${accountId}/tokens/token`]: {
            policies: [policy(["Zone Read", "DNS Write"])],
          },
        },
        `The Cloudflare API token lacks Workers Routes Edit on the Portal zone ${portalDomain}.`,
      ],
      // A grant on another zone, or one a deny policy cancels, is no grant.
      [
        {
          [`/accounts/${accountId}/tokens/token`]: {
            policies: [
              policy(["Zone Read"]),
              policy(["DNS Write", "Workers Routes Write"], otherZone),
            ],
          },
        },
        `lacks DNS Edit on the Portal zone ${portalDomain}. Add Zone → DNS → Edit for ${portalDomain} to the token, then rerun.\nThe Cloudflare API token lacks Workers Routes Edit`,
      ],
      [
        {
          [`/accounts/${accountId}/tokens/token`]: {
            policies: [
              ...allPermissions,
              { ...policy(["DNS Write"]), effect: "deny" },
            ],
          },
        },
        `The Cloudflare API token lacks DNS Edit on the Portal zone ${portalDomain}.`,
      ],
      [
        {
          [`/zones?account.id=${accountId}&name=${portalDomain}`]: [
            { ...zone, status: "pending" },
          ],
        },
        `Portal zone ${portalDomain} is pending; wait until Cloudflare shows it active, then rerun.`,
      ],
      [
        {
          [`/zones?account.id=${accountId}&name=${portalDomain}`]: [
            { ...zone, account: { id: "f".repeat(32) } },
          ],
        },
        `Portal domain ${portalDomain} must be the apex of its own zone in this Cloudflare account.`,
      ],
    ])
      await expect(
        preflightPortalZone({
          auth: tokenAuth,
          portalDomain,
          fetch: cloudflare(overrides),
        }),
      ).rejects.toThrow(message);
    // With a zone ID, an unreadable zone is a missing Zone Read.
    await expect(
      preflightPortalZone({
        auth: tokenAuth,
        portalDomain,
        zoneId,
        fetch: cloudflare({ [`/zones/${zoneId}`]: 403 }),
      }),
    ).rejects.toThrow(
      `The Cloudflare API token lacks Zone Read on the Portal zone ${portalDomain} (${zoneId}). Add Zone → Zone → Read`,
    );
    await expect(
      preflightPortalZone({
        auth: tokenAuth,
        portalDomain,
        zoneId,
        fetch: cloudflare({
          [`/zones/${zoneId}`]: { ...zone, name: "other-portals.dev" },
        }),
      }),
    ).rejects.toThrow("must be the apex of its own zone");
  });

  it("falls back to read probes when the token cannot read its policies", async () => {
    await expect(
      preflightPortalZone({
        auth: tokenAuth,
        portalDomain,
        fetch: cloudflare({
          [`/accounts/${accountId}/tokens/verify`]: 403,
          "/user/tokens/verify": { id: "user-token" },
          "/user/tokens/user-token": 403,
        }),
      }),
    ).resolves.toEqual({ zoneId, editConfirmed: false });
    // A user-owned token that can read itself is checked too.
    await expect(
      preflightPortalZone({
        auth: tokenAuth,
        portalDomain,
        fetch: cloudflare({
          [`/accounts/${accountId}/tokens/verify`]: 403,
          "/user/tokens/verify": { id: "user-token" },
          "/user/tokens/user-token": { policies: [policy(["Zone Read"])] },
        }),
      }),
    ).rejects.toThrow("lacks DNS Edit");
  });

  it("asks an Alchemy OAuth login without the Portal scopes to sign in again", async () => {
    const oauth = (scopes) => ({
      accountId,
      headers: { Authorization: "Bearer x" },
      method: "alchemy-oauth",
      scopes,
    });
    const fetch = cloudflare();
    for (const [missing, label] of [
      ["zone.read", "Zone Read"],
      ["dns.write", "DNS Edit"],
      ["workers-routes.write", "Workers Routes Edit"],
    ]) {
      const error = await preflightPortalZone({
        auth: oauth(PORTAL_OAUTH_SCOPES.filter((scope) => scope !== missing)),
        portalDomain,
        fetch,
      }).catch((cause) => cause);
      expect(error.message).toContain(
        `The Alchemy Cloudflare login was not granted ${missing}, needed for ${label} on the Portal zone ${portalDomain}.`,
      );
      expect(error.message).toContain("Sign in again with Portal access");
      expect(error.message.split("\n")).toHaveLength(2);
    }
    expect(fetch).not.toHaveBeenCalled();
    // OAuth grants are scopes, not token policies: no introspection.
    await expect(
      preflightPortalZone({
        auth: oauth([...PORTAL_OAUTH_SCOPES, "workers-scripts.edit"]),
        portalDomain,
        fetch,
      }),
    ).resolves.toEqual({ zoneId, editConfirmed: true });
    expect(fetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/tokens/"),
      expect.anything(),
    );
  });

  // Alchemy itself writes and migrates these profiles, so a change to its
  // layout fails here rather than at an operator's deploy.
  const withAlchemyHome = async (home, use) => {
    const previous = process.env.ALCHEMY_HOME;
    process.env.ALCHEMY_HOME = join(home, ".alchemy");
    try {
      return await Effect.runPromise(
        Effect.flatMap(ProfileStore, use).pipe(
          Effect.provide(
            ProfileStoreLive.pipe(Layer.provide(PlatformServices)),
          ),
        ),
      );
    } finally {
      if (previous === undefined) delete process.env.ALCHEMY_HOME;
      else process.env.ALCHEMY_HOME = previous;
    }
  };

  it("reads the scopes an Alchemy OAuth login was granted", async () => {
    const home = mkdtempSync(join(tmpdir(), "dx-alchemy-home-"));
    expect(alchemyCloudflareConnected({ environment: {}, home })).toBe(false);
    await withAlchemyHome(home, (profiles) =>
      Effect.andThen(
        profiles.createProfile("dx-selfhost"),
        profiles.setProviderConfig("dx-selfhost", "Cloudflare", {
          method: "oauth",
          accountId,
          clientId: "client",
          access: "access",
          refresh: "refresh",
          expires: Date.now() + 3_600_000,
          scopes: ["zone.read", "workers-routes.write", "offline_access"],
        }),
      ),
    );
    expect(alchemyCloudflareConnected({ environment: {}, home })).toBe(true);
    const auth = loadAlchemyCloudflareAuth({ environment: {}, home });
    expect(auth).toMatchObject({
      method: "alchemy-oauth",
      accountId,
      headers: { Authorization: "Bearer access" },
      scopes: ["zone.read", "workers-routes.write", "offline_access"],
    });
    expect(missingPortalOAuthScopes(auth).map(({ scope }) => scope)).toEqual([
      "dns.write",
    ]);
    rmSync(home, { recursive: true, force: true });
  });

  it("asks a login from an older Alchemy to sign in again", async () => {
    const home = mkdtempSync(join(tmpdir(), "dx-alchemy-home-"));
    mkdirSync(join(home, ".alchemy/credentials/dx-selfhost"), {
      recursive: true,
    });
    writeFileSync(
      join(home, ".alchemy/profiles.json"),
      JSON.stringify({
        version: 0,
        profiles: {
          "dx-selfhost": {
            Cloudflare: { method: "oauth", accountId, scopes: ["zone:read"] },
          },
        },
      }),
    );
    writeFileSync(
      join(home, ".alchemy/credentials/dx-selfhost/cf-oauth.json"),
      JSON.stringify({
        type: "oauth",
        access: "old-client-access",
        refresh: "old-client-refresh",
        expires: Date.now() + 3_600_000,
        scopes: ["zone:read"],
      }),
    );
    // Before migration the wizard refreshes the login rather than adding one.
    expect(alchemyCloudflareConnected({ environment: {}, home })).toBe(true);
    expect(() => loadAlchemyCloudflareAuth({ environment: {}, home })).toThrow(
      "has no Cloudflare login",
    );
    await withAlchemyHome(home, (profiles) => profiles.readManifest);
    expect(alchemyCloudflareConnected({ environment: {}, home })).toBe(true);
    expect(() => loadAlchemyCloudflareAuth({ environment: {}, home })).toThrow(
      "must hold a current Cloudflare OAuth login",
    );
    rmSync(home, { recursive: true, force: true });
  });

  it("lists the account's zones that can serve Portals and what each already serves", async () => {
    const results = {
      [`/zones?account.id=${accountId}&status=active&per_page=50&page=1`]: {
        result: [
          { id: "app", name: "example.com" },
          { id: "fresh", name: "example-portals.dev" },
          { id: "busy", name: "busy.dev" },
          { id: "locked", name: "locked.dev" },
        ],
        result_info: { total_pages: 1 },
      },
      "/zones/fresh/dns_records?per_page=1": {
        result: [],
        result_info: { total_count: 0 },
      },
      "/zones/fresh/workers/routes": { result: [] },
      [`/accounts/${accountId}/workers/domains?zone_id=fresh`]: { result: [] },
      "/zones/busy/dns_records?per_page=1": {
        result: [{}],
        result_info: { total_count: 3 },
      },
      "/zones/busy/workers/routes": { result: [{}] },
      [`/accounts/${accountId}/workers/domains?zone_id=busy`]: { result: [] },
      "/zones/locked/dns_records?per_page=1": 403,
      "/zones/locked/workers/routes": { result: [] },
      [`/accounts/${accountId}/workers/domains?zone_id=locked`]: {
        result: [],
      },
    };
    const fetch = vi.fn(async (url) => {
      const parsed = new URL(url);
      const path = parsed.pathname.replace("/client/v4", "") + parsed.search;
      const result = results[path];
      if (result === undefined)
        throw new Error(`Unexpected Cloudflare request: ${path}`);
      return result === 403
        ? Response.json({ success: false }, { status: 403 })
        : Response.json({ success: true, ...result });
    });
    // example.com is the app's own site and never offered.
    await expect(
      listPortalZoneCandidates({
        auth: tokenAuth,
        appDomain: "dx.example.com",
        fetch,
      }),
    ).resolves.toEqual([
      { id: "fresh", name: "example-portals.dev", inUse: false },
      {
        id: "busy",
        name: "busy.dev",
        inUse: { dnsRecords: 3, workerRoutes: 1, customDomains: 0 },
      },
      { id: "locked", name: "locked.dev", inUse: undefined },
    ]);
  });
});

describe("Orb Worker state after an interrupted create", () => {
  const workerName = "dx-orb-test";

  it("passes recorded attributes through without a lookup", async () => {
    const exists = vi.fn();
    const output = { workerName, recipeHash: "f".repeat(64) };
    await expect(
      readOrbContainers({ output, olds: { workerName }, exists }),
    ).resolves.toBe(output);
    expect(exists).not.toHaveBeenCalled();
  });

  it("recovers only the name of an Orb Worker that exists", async () => {
    // No recipe, so a deploy redeploys it and a destroy deletes it.
    await expect(
      readOrbContainers({
        olds: { workerName, recipeHash: "f".repeat(64) },
        exists: async (name) => name === workerName,
      }),
    ).resolves.toEqual({ workerName });
    await expect(
      readOrbContainers({ olds: { workerName }, exists: async () => false }),
    ).resolves.toBeUndefined();
  });

  it("looks nothing up without a recorded name, and surfaces lookup failures", async () => {
    const exists = vi.fn();
    await expect(
      readOrbContainers({ olds: {}, exists }),
    ).resolves.toBeUndefined();
    await expect(readOrbContainers({ exists })).resolves.toBeUndefined();
    expect(exists).not.toHaveBeenCalled();
    await expect(
      readOrbContainers({
        olds: { workerName },
        exists: async () => {
          throw new Error("Cloudflare request failed (500).");
        },
      }),
    ).rejects.toThrow("Cloudflare request failed (500).");
  });
});
