import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { validateSelfhostConfig } from "../deploy/selfhost/config.mjs";
import {
  assertInstallerDefaults,
  CLOUDFLARE_ORB_PROMPT,
  collectDeploymentConfig,
  collectOrbProviders,
  collectPluginChoices,
  E2B_ORB_PROMPT,
  provisionalDeploymentConfigPath,
  WORKER_TRACES_PROMPT,
} from "./dx-deploy.mjs";

describe("common deployment installer", () => {
  it("runs Cloudflare preflight before collecting deployment credentials", () => {
    const source = readFileSync(
      new URL("./dx-deploy.mjs", import.meta.url),
      "utf8",
    );
    const runner = source.slice(source.indexOf("export const runDxDeploy"));
    expect(runner.indexOf("Cloudflare deployment API token")).toBeLessThan(
      runner.indexOf("Magic-link sender email"),
    );
    expect(runner.indexOf("await preflightCloudflareDeployment")).toBeLessThan(
      runner.indexOf("config = await collectDeploymentConfig"),
    );
  });

  it("keeps first-run config provisional until deployment succeeds", () => {
    const source = readFileSync(
      new URL("./dx-deploy.mjs", import.meta.url),
      "utf8",
    );
    const runner = source.slice(source.indexOf("export const runDxDeploy"));
    const provisionalWrite = runner.indexOf(
      "writeFileSync(deploymentConfigPath",
    );
    const failedDeployment = runner.indexOf("if (result.status !== 0)");
    const promotion = runner.indexOf(
      "renameSync(deploymentConfigPath, configPath)",
    );
    expect(provisionalWrite).toBeGreaterThan(-1);
    expect(provisionalWrite).toBeLessThan(failedDeployment);
    expect(failedDeployment).toBeLessThan(promotion);
  });

  it("keeps each provisional config beside its final destination", () => {
    expect(
      provisionalDeploymentConfigPath("/mnt/config/deploy.json", "first"),
    ).toBe("/mnt/config/.deploy.json.first.pending");
    expect(
      provisionalDeploymentConfigPath("/mnt/config/deploy.json", "second"),
    ).toBe("/mnt/config/.deploy.json.second.pending");
  });

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
      if (label === "Magic-link sender email")
        return "sign-in@auth.example.com";
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
    });
    expect(yes).toHaveBeenCalledWith(WORKER_TRACES_PROMPT, false);
    expect(environment).toEqual({ E2B_API_KEY: "fixture-e2b-key" });
    expect(answer).not.toHaveBeenCalledWith(
      "Deployment name",
      expect.anything(),
    );
    expect(yes).not.toHaveBeenCalledWith("Use a custom domain");
    expect(yes).not.toHaveBeenCalledWith("Allow public account creation");
  });

  it("installs Search at deploy time with an optional deployment Exa key", async () => {
    const run = async (withKey) => {
      const environment = {};
      const config = await collectDeploymentConfig({
        answer: async (label) => {
          if (label === "First administrator email") return "owner@example.com";
          if (label === "Magic-link sender email")
            return "sign-in@auth.example.com";
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

  it("installs Speech at deploy time with an optional deployment Sarvam key", async () => {
    const asked = [];
    const run = async (withKey) => {
      const environment = {};
      const config = await collectDeploymentConfig({
        answer: async (label) => {
          if (label === "First administrator email") return "owner@example.com";
          if (label === "Magic-link sender email")
            return "sign-in@auth.example.com";
          throw new Error(`Unexpected answer prompt: ${label}`);
        },
        yes: async (label, fallback = false) => {
          asked.push(label);
          return label.startsWith("Install the Speech plugin")
            ? true
            : label.startsWith("Configure a deployment Sarvam API key")
              ? withKey
              : fallback;
        },
        secret: async (label) =>
          label === "Sarvam API key" ? "fixture-sarvam-key" : "fixture-e2b-key",
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
      plugins: ["speech"],
      integrations: ["sarvam"],
    });
    expect(keyed.environment.SARVAM_API_KEY).toBe("fixture-sarvam-key");
    const keyless = await run(false);
    expect(keyless.config).toMatchObject({
      plugins: ["speech"],
      integrations: [],
    });
    expect(keyless.environment).not.toHaveProperty("SARVAM_API_KEY");
    // The old standalone dictation question is gone.
    expect(asked).not.toContain("Configure Sarvam dictation");
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

    const source = readFileSync(
      new URL("./dx-deploy.mjs", import.meta.url),
      "utf8",
    );
    const runner = source.slice(source.indexOf("export const runDxDeploy"));
    const ask = runner.indexOf("config.offeredPlugins ?? []");
    expect(ask).toBeGreaterThan(
      runner.indexOf("config = await collectDeploymentConfig"),
    );
    expect(ask).toBeLessThan(runner.indexOf("Deployment review"));
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

  it("records a new deployment's traces answer", async () => {
    const yes = vi.fn(async (label, fallback = false) =>
      label === WORKER_TRACES_PROMPT ? true : fallback,
    );
    await expect(
      collectDeploymentConfig({
        answer: vi.fn(async () => "owner@example.com"),
        yes,
        secret: vi.fn(async () => "fixture-secret"),
        environment: {},
        defaults: {
          name: "hosted",
          cloudflareAccountId: "a".repeat(32),
          domain: "app.example.com",
          zone: "example.com",
          hostedAuthentication: true,
          authEmailFrom: "sign-in@example.com",
        },
      }),
    ).resolves.toMatchObject({ workerTraces: true });
  });

  it("asks an upgraded deployment about traces once and keeps the answer", () => {
    const source = readFileSync(
      new URL("./dx-deploy.mjs", import.meta.url),
      "utf8",
    );
    const runner = source.slice(source.indexOf("export const runDxDeploy"));
    const ask = runner.indexOf("config.workerTraces === undefined");
    expect(ask).toBeGreaterThan(
      runner.indexOf("config = await collectDeploymentConfig"),
    );
    expect(ask).toBeLessThan(runner.indexOf("Deployment review"));
    expect(ask).toBeLessThan(
      runner.indexOf("writeFileSync(deploymentConfigPath"),
    );

    const legacy = { name: "hosted", adminEmail: "owner@example.com" };
    expect(validateSelfhostConfig(legacy)).not.toHaveProperty("workerTraces");
    expect(
      validateSelfhostConfig({ ...legacy, workerTraces: false }),
    ).toMatchObject({ workerTraces: false });
    expect(() =>
      validateSelfhostConfig({ ...legacy, workerTraces: "yes" }),
    ).toThrow("workerTraces must be true or false.");
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
});
