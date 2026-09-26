import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const alchemyDirectory = dirname(fileURLToPath(import.meta.resolve("alchemy")));
const stateStoreSource = readFileSync(
  resolve(alchemyDirectory, "Cloudflare/StateStore/State.js"),
  "utf8",
);

describe("Alchemy Cloudflare state-store login", () => {
  it("selects the Secrets Store that contains Alchemy's token", () => {
    const login = stateStoreSource.slice(
      stateStoreSource.indexOf("export const loginWithCloudflare"),
      stateStoreSource.indexOf("const isStateStoreAvailable"),
    );

    expect(login).toContain("SecretsStore.listStoreSecrets");
    expect(login).toContain("secret.name === AuthTokenSecretName");
    expect(login.indexOf("SecretsStore.listStoreSecrets")).toBeLessThan(
      login.indexOf("readSecretViaEdge"),
    );
  });
});
