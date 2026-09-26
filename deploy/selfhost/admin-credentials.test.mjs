import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  adminCredentialPath,
  collectAdminPassword,
  generateAdminPassword,
  writeAdminCredentialFile,
} from "./admin-credentials.mjs";

describe("self-host administrator credentials", () => {
  it("confirms an operator-supplied password without logging it", async () => {
    const readSecret = vi
      .fn()
      .mockResolvedValueOnce("operator-password")
      .mockResolvedValueOnce("operator-password");

    await expect(collectAdminPassword({ readSecret })).resolves.toBe(
      "operator-password",
    );
    expect(readSecret).toHaveBeenCalledTimes(2);
  });

  it("generates a valid password from one empty response", async () => {
    const readSecret = vi.fn().mockResolvedValue("");
    const password = await collectAdminPassword({ readSecret });

    expect(password).toHaveLength(32);
    expect(password).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(readSecret).toHaveBeenCalledOnce();
    expect(generateAdminPassword()).not.toBe(password);
  });

  it("rejects a mismatched confirmation", async () => {
    const readSecret = vi
      .fn()
      .mockResolvedValueOnce("operator-password")
      .mockResolvedValueOnce("different-password");

    await expect(collectAdminPassword({ readSecret })).rejects.toThrow(
      "Administrator passwords do not match.",
    );
  });

  it("writes only login credentials to the ignored private path with mode 0600", () => {
    const root = mkdtempSync(resolve(tmpdir(), "dx-admin-credentials-"));
    const path = adminCredentialPath(root);
    writeAdminCredentialFile({
      path,
      url: "https://dx.example.com",
      email: "owner@example.com",
      password: "operator-password",
    });

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, "utf8")).toBe(
      "Login URL: https://dx.example.com\n" +
        "Administrator email: owner@example.com\n" +
        "Current administrator password: operator-password\n",
    );
    rmSync(root, { recursive: true, force: true });
  });
});
