import { describe, expect, it, vi } from "vitest";
import { validateSelfhostConfig } from "../deploy/selfhost/config.mjs";
import {
  assertInstallerDefaults,
  BROWSER_LOGIN_SWITCH_PROMPT,
  chooseCloudflareAuth,
  CLOUDFLARE_ORB_PROMPT,
  collectDeploymentConfig,
  collectOrbProviders,
  collectPluginChoices,
  collectSenderUpgrade,
  E2B_ORB_PROMPT,
  EMAIL_SENDING_PROMPT,
  PASSWORD_PROMPT,
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
    expect(environment).toEqual({ E2B_API_KEY: "fixture-e2b-key" });
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
  it("asks for E2B and Cloudflare Containers, keys only E2B, and requires one", async () => {
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
    // E2B is the default; Containers must be an explicit choice.
    expect(e2bOnly.asked).toEqual([
      [E2B_ORB_PROMPT, true],
      [CLOUDFLARE_ORB_PROMPT, false],
    ]);
    expect(CLOUDFLARE_ORB_PROMPT).toContain("Workers Paid");
    const containersOnly = await run([false, true]);
    expect(containersOnly.providers).toEqual(["cloudflare"]);
    expect(containersOnly.environment).toEqual({});
    const both = await run([true, true]);
    expect(both.providers).toEqual(["e2b", "cloudflare"]);
    const retried = await run([false, false, false, true]);
    expect(retried.providers).toEqual(["cloudflare"]);
    expect(retried.log).toHaveBeenCalledOnce();
    await expect(run([])).rejects.toThrow("at least one Orb provider");
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
