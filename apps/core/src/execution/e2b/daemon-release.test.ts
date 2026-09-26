import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { loadDaemonRelease } from "./daemon-release.js";

const bytes = new TextEncoder().encode("verified daemon");
const sha256 = createHash("sha256").update(bytes).digest("hex");

describe("daemon release loader", () => {
  it("downloads and verifies the configured release in Core", async () => {
    const fetchRelease = vi.fn(async () => new Response(bytes));
    await expect(
      loadDaemonRelease(
        {
          DX_DXD_RELEASE_URL: "https://release.test/dxd",
          DX_DXD_RELEASE_SHA256: sha256,
        },
        fetchRelease as typeof fetch,
      ),
    ).resolves.toEqual({ binary: bytes, sha256 });
    expect(fetchRelease).toHaveBeenCalledWith("https://release.test/dxd");
  });

  it("rejects a mismatch and requires lowercase checksum configuration", async () => {
    const fetchRelease = vi.fn(async () => new Response(bytes));
    await expect(
      loadDaemonRelease(
        {
          DX_DXD_RELEASE_URL: "https://release.test/dxd",
          DX_DXD_RELEASE_SHA256: "0".repeat(64),
        },
        fetchRelease as typeof fetch,
      ),
    ).rejects.toThrow("checksum mismatch");
    await expect(
      loadDaemonRelease(
        {
          DX_DXD_RELEASE_URL: "https://release.test/dxd",
          DX_DXD_RELEASE_SHA256: sha256.toUpperCase(),
        },
        fetchRelease as typeof fetch,
      ),
    ).rejects.toBeDefined();
  });
});
