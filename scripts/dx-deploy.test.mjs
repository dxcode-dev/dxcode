import { describe, expect, it, vi } from "vitest";
import { validateSelfhostConfig } from "../deploy/selfhost/config.mjs";
import {
  assertInstallerDefaults,
  BROWSER_LOGIN_SWITCH_PROMPT,
  CLOUDFLARE_ORB_PROMPT,
  chooseCloudflareAuth,
  collectDeploymentConfig,
  collectOperatorR2Credentials,
  collectOrbProviders,
  collectPluginChoices,
  collectPortalDomain,
  collectSenderUpgrade,
  E2B_ORB_PROMPT,
  EMAIL_SENDING_PROMPT,
  NO_DEPLOYMENT_ORB_NOTICE,
  PASSWORD_PROMPT,
  PORTAL_SKIP_PROMPT,
  SENDER_EMAIL_PROMPT,
  WORKER_TRACES_PROMPT,
} from "./dx-deploy.mjs";

describe("common deployment installer", () => {
  it("keeps private wrapper defaults fixed on rerun", () => {
    const defaults = {
      name: "hosted",
      domain: "app.example.com",
      zone: "example.com",
      authEmailFrom: "sign-in@example.com",
    };
    expect(() => assertInstallerDefaults(defaults, defaults)).not.toThrow();
    expect(() =>
      assertInstallerDefaults(
        { ...defaults, domain: "other.example.com" },
        defaults,
      ),
    ).toThrow("installer default for domain");
  });

  it("collects hosted configuration without a password or required integrations", async () => {
    const environment = {};
    const answer = vi.fn(async (label) => {
      if (label === "First administrator email") return "owner@example.com";
      if (label === SENDER_EMAIL_PROMPT) return "sign-in@auth.example.com";
      if (label.startsWith("Allowed email domains")) return "";
      throw new Error(`Unexpected answer prompt: ${label}`);
    });
    const yes = vi.fn(async (label, fallback = false) =>
      label === "Enable Workers AI" || label === E2B_ORB_PROMPT
        ? fallback
        : false,
    );
    const secret = vi.fn(async (label) => {
      if (label === "E2B API key") return "fixture-e2b-key";
      throw new Error(`Unexpected secret prompt: ${label}`);
    });

    await expect(
      collectDeploymentConfig({
        answer,
        yes,
        secret,
        environment,
        defaults: {
          name: "hosted",
          cloudflareAccountId: "a".repeat(32),
          domain: "app.example.com",
          zone: "example.com",
          hostedAuthentication: true,
        },
      }),
    ).resolves.toMatchObject({
      name: "hosted",
      authEmailFrom: "sign-in@auth.example.com",
      adminEmail: "owner@example.com",
      integrations: [],
      workersAi: true,
      workerTraces: false,
      allowSignup: false,
      signIn: {
        providers: ["magic-link"],
        admission: "waitlist",
        allowedEmailDomains: [],
      },
    });
    expect(yes).toHaveBeenCalledWith(WORKER_TRACES_PROMPT, false);
    // No Orb provider by default: people connect their own accounts.
    expect(environment).toEqual({});
    expect(answer).not.toHaveBeenCalledWith(
      "Deployment name",
      expect.anything(),
    );
    expect(yes).not.toHaveBeenCalledWith("Use a custom domain");
    expect(yes).not.toHaveBeenCalledWith("Allow public account creation");
    expect(yes).not.toHaveBeenCalledWith(PASSWORD_PROMPT, expect.anything());
  });

  it("installs Search at deploy time with an optional deployment Exa key", async () => {
    const run = async (withKey) => {
      const environment = {};
      const config = await collectDeploymentConfig({
        answer: async (label) => {
          if (label === "First administrator email") return "owner@example.com";
          if (label === SENDER_EMAIL_PROMPT) return "sign-in@auth.example.com";
          if (label.startsWith("Allowed email domains")) return "";
          throw new Error(`Unexpected answer prompt: ${label}`);
        },
        yes: async (label, fallback = false) =>
          label.startsWith("Install the Web search plugin")
            ? true
            : label.startsWith("Configure a deployment Exa API key")
              ? withKey
              : fallback,
        secret: async (label) =>
          label === "Exa API key" ? "fixture-exa-key" : "fixture-e2b-key",
        environment,
        defaults: {
          name: "hosted",
          cloudflareAccountId: "a".repeat(32),
          domain: "app.example.com",
          zone: "example.com",
          hostedAuthentication: true,
        },
      });
      return { config, environment };
    };
    const keyed = await run(true);
    expect(keyed.config).toMatchObject({
      plugins: ["search"],
      offeredPlugins: ["search", "speech"],
      integrations: ["exa"],
    });
    expect(keyed.environment.EXA_API_KEY).toBe("fixture-exa-key");
    const keyless = await run(false);
    expect(keyless.config).toMatchObject({
      plugins: ["search"],
      integrations: [],
    });
    expect(keyless.environment).not.toHaveProperty("EXA_API_KEY");
  });

  it("asks an existing deployment once about plugins it was never offered", async () => {
    const yes = vi.fn(async (label) =>
      label.startsWith("Install the Speech plugin"),
    );
    const choices = await collectPluginChoices({
      yes,
      secret: vi.fn(),
      environment: {},
      integrations: ["exa"],
      plugins: ["search"],
      offered: ["search"],
    });
    expect(choices).toEqual({
      plugins: ["search", "speech"],
      offeredPlugins: ["search", "speech"],
      integrations: ["exa"],
    });
    expect(yes.mock.calls.map(([label]) => label)).toEqual([
      "Install the Speech plugin (composer dictation)",
      "Configure a deployment Sarvam API key for Speech (people and workspaces can also add their own)",
    ]);
    const answered = await collectPluginChoices({
      yes,
      secret: vi.fn(),
      environment: {},
      integrations: [],
      offered: ["search", "speech"],
    });
    expect(answered.offeredPlugins).toEqual(["search", "speech"]);
    expect(yes).toHaveBeenCalledTimes(2);
  });

  it("keeps a pre-plugin Sarvam deployment's dictation as the Speech plugin", () => {
    const base = { name: "selfhost", adminEmail: "owner@example.com" };
    // Phase-1 config: asked about Search, had the standalone Sarvam question.
    expect(
      validateSelfhostConfig({
        ...base,
        integrations: ["sarvam", "exa"],
        plugins: ["search"],
      }),
    ).toMatchObject({
      plugins: ["search", "speech"],
      offeredPlugins: ["search", "speech"],
      integrations: ["exa", "sarvam"],
    });
    // Pre-plugin config: only Speech counts as asked; Search is still asked.
    expect(
      validateSelfhostConfig({ ...base, integrations: ["sarvam"] }),
    ).toMatchObject({ plugins: ["speech"], offeredPlugins: ["speech"] });
    // A phase-1 config without Sarvam is asked about Speech once.
    expect(
      validateSelfhostConfig({ ...base, plugins: ["search"] }),
    ).toMatchObject({ plugins: ["search"], offeredPlugins: ["search"] });
    // Declining Speech while keeping a Sarvam key is not a valid config.
    expect(() =>
      validateSelfhostConfig({
        ...base,
        integrations: ["sarvam"],
        plugins: [],
        offeredPlugins: ["search", "speech"],
      }),
    ).toThrow("The sarvam integration requires the speech plugin.");
  });

  it("rejects unknown plugins and a provider key without its plugin", () => {
    const base = { name: "selfhost", adminEmail: "owner@example.com" };
    expect(validateSelfhostConfig(base)).not.toHaveProperty("plugins");
    expect(validateSelfhostConfig({ ...base, plugins: [] })).toMatchObject({
      plugins: [],
    });
    expect(() =>
      validateSelfhostConfig({ ...base, plugins: ["voice"] }),
    ).toThrow("plugins may contain search, speech");
    expect(() =>
      validateSelfhostConfig({ ...base, offeredPlugins: ["voice"] }),
    ).toThrow("offeredPlugins may contain search, speech");
    expect(() =>
      validateSelfhostConfig({ ...base, integrations: ["exa"] }),
    ).toThrow("requires the search plugin");
  });
});

describe("Orb provider choice", () => {
  it("offers E2B and Cloudflare Containers on the deployment's account, keys only E2B, and requires neither", async () => {
    const run = async (answers) => {
      const environment = {};
      const log = vi.fn();
      const asked = [];
      const providers = await collectOrbProviders({
        yes: async (label, fallback) => {
          asked.push([label, fallback]);
          return answers.shift() ?? false;
        },
        secret: async (label) =>
          label === "E2B API key" ? "fixture-e2b-key" : "unexpected",
        environment,
        log,
      });
      return { providers, environment, asked, log };
    };
    const e2bOnly = await run([true, false]);
    expect(e2bOnly.providers).toEqual(["e2b"]);
    expect(e2bOnly.environment).toEqual({ E2B_API_KEY: "fixture-e2b-key" });
    // The deployment pays for either, so both are explicit choices.
    expect(e2bOnly.asked).toEqual([
      [E2B_ORB_PROMPT, false],
      [CLOUDFLARE_ORB_PROMPT, false],
    ]);
    expect(CLOUDFLARE_ORB_PROMPT).toContain("Workers Paid");
    const containersOnly = await run([false, true]);
    expect(containersOnly.providers).toEqual(["cloudflare"]);
    expect(containersOnly.environment).toEqual({});
    const both = await run([true, true]);
    expect(both.providers).toEqual(["e2b", "cloudflare"]);
    // None: people connect their own, and the installer says where.
    const none = await run([]);
    expect(none.providers).toEqual([]);
    expect(none.environment).toEqual({});
    expect(none.log).toHaveBeenCalledWith(NO_DEPLOYMENT_ORB_NOTICE);
  });

  it("offers a sender once to a deployment without one, for notification email", async () => {
    const base = validateSelfhostConfig({
      name: "self",
      adminEmail: "owner@example.com",
      domain: "dx.example.com",
      zone: "example.com",
      signIn: { providers: ["email-password"], admission: "invite" },
    });
    const run = async (options) => {
      // `existing: undefined` means a new install, not the default.
      const existing = "existing" in options ? options.existing : base;
      const { defaults = {}, argv = [], answer = true } = options;
      const asked = [];
      const log = vi.fn();
      const result = await collectSenderUpgrade({
        existing,
        defaults,
        flags: new Set(argv),
        yes: async (label, fallback) => {
          asked.push([label, fallback]);
          return answer;
        },
        log,
      });
      return { ...result, asked, log };
    };

    // A new install answers the sender question in the main wizard.
    expect(await run({ existing: undefined })).toMatchObject({
      offered: false,
      addSender: false,
      asked: [],
    });
    // A deployment with a sender, or the hosted wrapper, is never asked.
    expect(
      await run({ existing: { ...base, authEmailFrom: "dx@example.com" } }),
    ).toMatchObject({ offered: false, asked: [] });
    expect(
      await run({ defaults: { hostedAuthentication: true } }),
    ).toMatchObject({ offered: false, asked: [] });

    // Without a sender it is asked once, defaulting to no.
    expect(await run({})).toMatchObject({
      offered: true,
      addSender: true,
      asked: [[EMAIL_SENDING_PROMPT, false]],
    });
    expect(await run({ answer: false })).toMatchObject({
      offered: true,
      addSender: false,
    });
    const recorded = validateSelfhostConfig({
      ...base,
      offeredEmailSending: true,
    });
    expect(recorded.offeredEmailSending).toBe(true);
    expect(await run({ existing: recorded })).toMatchObject({
      offered: false,
      asked: [],
    });
    // `--email` asks again.
    expect(await run({ existing: recorded, argv: ["--email"] })).toMatchObject({
      offered: true,
      addSender: true,
    });

    // A workers.dev deployment has no zone to send from: it is told, not asked.
    const workersDev = validateSelfhostConfig({
      name: "self",
      adminEmail: "owner@example.com",
      signIn: { providers: ["email-password"], admission: "invite" },
    });
    const noZone = await run({ existing: workersDev });
    expect(noZone).toMatchObject({
      offered: true,
      addSender: false,
      asked: [],
    });
    expect(noZone.log).toHaveBeenCalledOnce();
  });

  it("needs a Cloudflare API token only for magic-link sign-in", async () => {
    const base = validateSelfhostConfig({
      name: "self",
      adminEmail: "owner@example.com",
      domain: "dx.example.com",
      zone: "example.com",
      signIn: { providers: ["email-password"], admission: "invite" },
    });
    const sender = { ...base, authEmailFrom: "dx@example.com" };
    const magic = validateSelfhostConfig({
      ...sender,
      signIn: { providers: ["magic-link"], admission: "invite" },
    });
    const choose = async (input, answer = true) => {
      const asked = [];
      const log = vi.fn();
      const result = await chooseCloudflareAuth({
        hasToken: false,
        defaults: {},
        yes: async (label, fallback) => {
          asked.push([label, fallback]);
          return answer;
        },
        log,
        ...input,
      });
      return { ...result, asked };
    };
    const token = { credentials: "api-token", record: "api-token", asked: [] };
    const browser = {
      credentials: "alchemy-oauth",
      record: "alchemy-oauth",
      asked: [],
    };

    // The hosted wrapper and magic link manage Turnstile: always a token.
    expect(
      await choose({
        existing: sender,
        defaults: { hostedAuthentication: true },
      }),
    ).toEqual(token);
    expect(await choose({ existing: magic })).toEqual(token);
    expect(
      await choose({ existing: { ...magic, cloudflareAuth: "alchemy-oauth" } }),
    ).toEqual(token);

    // Notification email alone works with browser login.
    expect(
      await choose({
        existing: { ...sender, cloudflareAuth: "alchemy-oauth" },
      }),
    ).toEqual(browser);
    expect(await choose({ existing: base })).toEqual(browser);
    expect(
      await choose({ existing: { ...sender, cloudflareAuth: "api-token" } }),
    ).toEqual(token);

    // A sender from 0.2.18 or earlier was deployed with a token. Switching
    // uses it once more to remove what browser login cannot manage.
    const switched = await choose({ existing: sender });
    expect(switched).toEqual({
      credentials: "api-token",
      record: "alchemy-oauth",
      asked: [[BROWSER_LOGIN_SWITCH_PROMPT, true]],
    });
    expect(await choose({ existing: sender }, false)).toEqual({
      ...token,
      asked: [[BROWSER_LOGIN_SWITCH_PROMPT, true]],
    });

    // A token in the environment is used, never replaced by a browser login.
    expect(await choose({ existing: base, hasToken: true })).toEqual(token);
    expect(
      await choose({
        existing: { ...sender, cloudflareAuth: "alchemy-oauth" },
        hasToken: true,
      }),
    ).toEqual({ ...browser, credentials: "api-token" });

    // A new install decides from its sign-in answers.
    expect(
      await choose({ existing: undefined, sender: true, magicLink: true }),
    ).toEqual(token);
    expect(
      await choose({ existing: undefined, sender: true, magicLink: false }),
    ).toEqual(browser);
    expect(
      await choose({ existing: undefined, sender: false, magicLink: false }),
    ).toEqual(browser);
  });
});

describe("Portal domain choice", () => {
  const accountId = "a".repeat(32);
  const auth = {
    accountId,
    headers: { Authorization: "Bearer x" },
    method: "api-token",
  };
  const fullAccess = {
    policies: [
      {
        effect: "allow",
        permission_groups: [
          { name: "Zone Read" },
          { name: "DNS Write" },
          { name: "Workers Routes Write" },
        ],
        resources: { "com.cloudflare.api.account.zone.*": "*" },
      },
    ],
  };
  // An account with the app's zone, an unused zone, and a zone that already
  // serves hostnames.
  const account = (overrides = {}) => {
    const zone = (id, name) => ({
      id,
      name,
      status: "active",
      account: { id: accountId },
    });
    const results = {
      [`/zones?account.id=${accountId}&status=active&per_page=50&page=1`]: [
        zone("app", "example.com"),
        zone("fresh", "example-portals.dev"),
        zone("busy", "busy.dev"),
      ],
      "/zones/fresh": zone("fresh", "example-portals.dev"),
      "/zones/busy": zone("busy", "busy.dev"),
      "/zones/fresh/dns_records?per_page=1": [],
      "/zones/fresh/workers/routes": [],
      [`/accounts/${accountId}/workers/domains?zone_id=fresh`]: [],
      "/zones/busy/dns_records?per_page=1": [{}],
      "/zones/busy/workers/routes": [],
      [`/accounts/${accountId}/workers/domains?zone_id=busy`]: [{}],
      [`/accounts/${accountId}/tokens/verify`]: { id: "token" },
      [`/accounts/${accountId}/tokens/token`]: fullAccess,
      ...overrides,
    };
    return vi.fn(async (url) => {
      const parsed = new URL(url);
      const path = parsed.pathname.replace("/client/v4", "") + parsed.search;
      if (!(path in results))
        throw new Error(`Unexpected Cloudflare request: ${path}`);
      return results[path] === 403
        ? Response.json({ success: false }, { status: 403 })
        : Response.json({ success: true, result: results[path] });
    });
  };
  const run = async ({ answers, confirm = [], fetch = account(), current }) => {
    const log = vi.fn();
    const confirmations = [];
    const portalDomain = await collectPortalDomain({
      answer: vi.fn(async (label) => {
        expect(label).toBe(PORTAL_SKIP_PROMPT);
        return answers.shift() ?? "";
      }),
      yes: async (label, fallback) => {
        confirmations.push([label, fallback]);
        return confirm.shift() ?? false;
      },
      log,
      auth,
      appDomain: "dx.example.com",
      current,
      fetch,
    });
    return {
      portalDomain,
      confirmations,
      output: log.mock.calls.map(([message]) => message).join(""),
    };
  };

  it("offers the account's separate zones and flags one already in use", async () => {
    const chosen = await run({ answers: ["1"] });
    expect(chosen.portalDomain).toBe("example-portals.dev");
    expect(chosen.output).toContain("  1. example-portals.dev\n");
    expect(chosen.output).toContain(
      "  2. busy.dev (already has 1 DNS record, 1 Worker custom domain)\n",
    );
    // The app's own registrable domain is never offered.
    expect(chosen.output).not.toContain("example.com");
    expect(chosen.output).toContain(
      "Portal zone example-portals.dev prerequisites passed.",
    );
    expect(chosen.confirmations).toEqual([]);

    // A zone in use needs an explicit yes, which defaults to no.
    const declined = await run({ answers: ["busy.dev", "2", ""] });
    expect(declined.portalDomain).toBeUndefined();
    expect(declined.confirmations).toHaveLength(2);
    expect(declined.confirmations[0][0]).toContain(
      "busy.dev already serves hostnames: the route *.busy.dev/* would take over its proxied subdomains",
    );
    expect(declined.confirmations[0][1]).toBe(false);
    expect(declined.output).toContain("Portals stay off.");
    const confirmed = await run({ answers: ["busy.dev"], confirm: [true] });
    expect(confirmed.portalDomain).toBe("busy.dev");
    // A deployment's own Portal zone holds its Portal records already.
    const kept = await run({ answers: ["2"], current: "busy.dev" });
    expect(kept.portalDomain).toBe("busy.dev");
    expect(kept.confirmations).toEqual([]);
    expect(kept.output).toContain("  2. busy.dev (current Portal zone)\n");
  });

  it("stays off on a blank answer, an unknown zone, or an account without a separate zone", async () => {
    expect((await run({ answers: [""] })).portalDomain).toBeUndefined();
    const unknown = await run({
      answers: ["example.com", "portals.example.com", "9"],
    });
    expect(unknown.portalDomain).toBeUndefined();
    expect(unknown.output).toContain(
      "example.com is not one of the listed zones.",
    );
    const appOnly = await run({
      answers: [],
      fetch: account({
        [`/zones?account.id=${accountId}&status=active&per_page=50&page=1`]: [
          { id: "app", name: "example.com" },
        ],
      }),
    });
    expect(appOnly.portalDomain).toBeUndefined();
    expect(appOnly.output).toBe(
      "Portals stay off: no active zone in this Cloudflare account is a registrable domain separate from dx.example.com (workers.dev cannot serve the wildcard route Portals need). Add one, then run pnpm dx:deploy -- --portals.\n",
    );
  });

  it("refuses a chosen zone the credential cannot manage", async () => {
    await expect(
      run({
        answers: ["1"],
        // An unreadable zone is flagged too; the operator confirms it.
        confirm: [true],
        fetch: account({ "/zones/fresh/workers/routes": 403 }),
      }),
    ).rejects.toThrow(
      "The Cloudflare API token lacks Workers Routes Edit on the Portal zone example-portals.dev.",
    );
  });

  it("records the chosen Portal domain for the app's domain", async () => {
    const portals = vi.fn(async () => "example-portals.dev");
    const config = await collectDeploymentConfig({
      answer: async (label) => {
        if (label === "First administrator email") return "owner@example.com";
        if (label.startsWith("Who can create an account")) return "invite";
        if (label.startsWith("Allowed email domains")) return "";
        throw new Error(`Unexpected answer prompt: ${label}`);
      },
      yes: async (label, fallback = false) =>
        label === E2B_ORB_PROMPT || label === PASSWORD_PROMPT
          ? true
          : label === "Enable Workers AI"
            ? fallback
            : false,
      secret: async (label) =>
        label === "E2B API key" ? "fixture-e2b-key" : "",
      environment: {},
      defaults: {
        name: "mine",
        domain: "dx.example.com",
        zone: "example.com",
      },
      portals,
    });
    expect(portals).toHaveBeenCalledWith("dx.example.com");
    expect(config.portalDomain).toBe("example-portals.dev");
  });
});

describe("attachment R2 credentials", () => {
  const ACCESS = "0123456789abcdef0123456789abcdef";
  const SECRET = "f".repeat(64);
  const oauthConfig = (extra = {}) =>
    validateSelfhostConfig({
      name: "acme",
      adminEmail: "owner@example.com",
      cloudflareAuth: "alchemy-oauth",
      signIn: { providers: ["email-password"], admission: "invite" },
      ...extra,
    });
  const prompts = (accessKeyIds, secrets) => ({
    answer: vi.fn(async () => accessKeyIds.shift()),
    secret: vi.fn(async () => secrets.shift()),
  });

  it("asks a browser-login deployment once, with directions, and keeps the answer out of the config", async () => {
    const environment = {};
    const log = vi.fn();
    // A pasted token value instead of the S3 keys is refused and asked again.
    const { answer, secret } = prompts(["not-a-key", ACCESS], ["x", SECRET]);
    const config = await collectOperatorR2Credentials({
      config: oauthConfig(),
      credentials: "alchemy-oauth",
      environment,
      answer,
      secret,
      log,
    });
    expect(answer).toHaveBeenCalledTimes(2);
    expect(log.mock.calls.join("\n")).toContain("dx-storage-selfhost-acme");
    expect(environment).toEqual({
      DX_R2_ACCESS_KEY_ID: ACCESS,
      DX_R2_SECRET_ACCESS_KEY: SECRET,
    });
    expect(config.attachmentR2Credentials).toBe(true);
    expect(JSON.stringify(config)).not.toContain(SECRET);

    // The deployment holds it: later deploys do not ask, --rotate does.
    const later = prompts([], []);
    await collectOperatorR2Credentials({
      config,
      credentials: "alchemy-oauth",
      environment: {},
      ...later,
    });
    expect(later.answer).not.toHaveBeenCalled();
    const rotated = prompts([ACCESS], [SECRET]);
    await collectOperatorR2Credentials({
      config,
      credentials: "alchemy-oauth",
      rotate: true,
      environment: {},
      ...rotated,
    });
    expect(rotated.secret).toHaveBeenCalledTimes(1);
  });

  it("never asks a deployment that mints its own signing token", async () => {
    const { answer, secret } = prompts([], []);
    const config = oauthConfig({ cloudflareAuth: "api-token" });
    await expect(
      collectOperatorR2Credentials({
        config,
        credentials: "api-token",
        environment: {},
        answer,
        secret,
      }),
    ).resolves.toEqual(config);
    expect(answer).not.toHaveBeenCalled();
  });
});
