import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { validateSelfhostConfig } from "../deploy/selfhost/config.mjs";
import {
  assertInstallerDefaults,
  collectDeploymentConfig,
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
      label === "Enable Workers AI" ? fallback : false,
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
