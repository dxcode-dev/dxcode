import type { Sandbox } from "@flue/runtime";
import { encode as encodePng } from "fast-png";
import { describe, expect, it, vi } from "vitest";
import {
  createViewMediaTool,
  type ViewMediaDeps,
  viewMedia,
} from "./view-media.js";

/**
 * Failure modes:
 * - an image the agent asked about with an objective reaching the agent as
 *   an image block instead of the analysis subagent's text;
 * - a PDF returned raw instead of analyzed;
 * - audio or video sent to a model that cannot read it;
 * - a dx attachment or storage URL fetched from the Worker, which has no
 *   Thread key, instead of through dxd in the workspace;
 * - resolution "original" quietly downsizing.
 */

const png = (width: number, height: number) =>
  encodePng({
    width,
    height,
    channels: 3,
    data: new Uint8Array(width * height * 3).fill(200),
  });

const workspace = (files: Record<string, Uint8Array>) => {
  const exec = vi.fn(async (command: string) => {
    const match = /dxd files get '([^']+)' -o '([^']+)'/.exec(command);
    if (match?.[2] !== undefined) files[match[2]] = png(20, 10);
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  const sandbox = {
    cwd: "/home/user/workspace/repo",
    exec,
    stat: async (path: string) => {
      const file = files[path];
      if (file === undefined) throw new Error("ENOENT");
      return { isFile: true, isDirectory: false, size: file.length };
    },
    readFileBuffer: async (path: string) => {
      const file = files[path];
      if (file === undefined) throw new Error("ENOENT");
      return file;
    },
  } as unknown as Sandbox;
  return { sandbox, exec };
};

const deps = (analyze = vi.fn(async () => "It is gray.")) =>
  ({
    githubToken: async () => undefined,
    analyze,
    dxOrigin: "https://dx.example.com",
  }) satisfies ViewMediaDeps;

describe("view_media", () => {
  it("returns an image block without an objective, and the subagent's text with one", async () => {
    const { sandbox } = workspace({ "/tmp/a.png": png(3000, 1000) });
    const analyze = vi.fn(async () => "Matches: the image is gray.");
    const tool = createViewMediaTool(sandbox, deps(analyze));

    const plain = await tool.execute("call-1", { path: "/tmp/a.png" });
    expect(plain.content).toEqual([
      {
        type: "text",
        text: "/tmp/a.png: PNG, 2000×667, downsized from 3000×1000.",
      },
      { type: "image", data: expect.any(String), mimeType: "image/png" },
    ]);
    expect(analyze).not.toHaveBeenCalled();

    const asked = await tool.execute("call-2", {
      path: "/tmp/a.png",
      objective: "verify the image is gray",
    });
    expect(asked.content).toEqual([
      { type: "text", text: "Matches: the image is gray." },
    ]);
    expect(analyze).toHaveBeenCalledWith("verify the image is gray", {
      data: expect.any(String),
      mimeType: "image/png",
    });
  });

  it("analyzes a PDF and refuses audio and video", async () => {
    const pdf = new TextEncoder().encode("%PDF-1.4\n%dx\n");
    const wav = new Uint8Array(16);
    wav.set(new TextEncoder().encode("RIFF"), 0);
    wav.set(new TextEncoder().encode("WAVE"), 8);
    const { sandbox } = workspace({ "/tmp/a.pdf": pdf, "/tmp/a.wav": wav });
    const analyze = vi.fn(async () => "One page of test text.");
    const result = await viewMedia(
      sandbox,
      { path: "/tmp/a.pdf" },
      deps(analyze),
    );
    expect(result.text).toBe("One page of test text.");
    expect(result.image).toBeUndefined();
    expect(analyze).toHaveBeenCalledWith(expect.any(String), {
      data: Buffer.from(pdf).toString("base64"),
      mimeType: "application/pdf",
    });
    await expect(
      viewMedia(sandbox, { path: "/tmp/a.wav" }, deps()),
    ).rejects.toThrow(/audio/);
  });

  it("downloads dx attachment and storage URLs through dxd in the workspace", async () => {
    const { sandbox, exec } = workspace({});
    const result = await viewMedia(
      sandbox,
      {
        path: "https://dx.example.com/v1/threads/thr_1/storage/tsf_2/shot.png",
      },
      deps(),
    );
    expect(result.image?.mimeType).toBe("image/png");
    expect(exec.mock.calls[0]?.[0]).toMatch(
      /^dxd files get 'https:\/\/dx\.example\.com\/v1\/threads\/thr_1\/storage\/tsf_2\/shot\.png' -o '\/tmp\/dx-view-media-/,
    );
  });

  it("sends an original image unchanged and refuses one too large for that", async () => {
    const small = png(2400, 100);
    const { sandbox } = workspace({ "/tmp/s.png": small });
    const original = await viewMedia(
      sandbox,
      { path: "/tmp/s.png", resolution: "original" },
      deps(),
    );
    expect(original.details).toMatchObject({ width: 2400, height: 100 });
    const huge = new Uint8Array(png(8, 8));
    new DataView(huge.buffer).setUint32(16, 9000);
    const big = workspace({ "/tmp/h.png": huge });
    await expect(
      viewMedia(
        big.sandbox,
        { path: "/tmp/h.png", resolution: "original" },
        deps(),
      ),
    ).rejects.toThrow(/resolution high/);
  });
});
