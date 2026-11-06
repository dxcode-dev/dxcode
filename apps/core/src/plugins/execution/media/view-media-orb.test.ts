import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "@flue/runtime";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { imageInfo } from "./image.js";
import { downscaleInOrb, ORB_IMAGE_TIMEOUT_SECONDS } from "./orb-image.js";
import { type ViewMediaDeps, viewMedia } from "./view-media.js";

/**
 * view_media downsizing in the Orb, against a real shell and the Orb
 * image's ffmpeg. Failure modes:
 * - a 6K JPEG or a 20 MB photo the isolate cannot decode still refused, or
 *   sent at full size, instead of downsized in the workspace;
 * - a file over 16 MB read into the isolate: a Cloudflare container Orb
 *   refuses to hand it over, and the isolate has no use for it;
 * - the tool result not saying the image was resized, from what to what;
 * - a hostile image hanging the Orb's ffmpeg past its timeout, or a pixel
 *   bomb reaching ffmpeg at all;
 * - temporary files left in /tmp, on success or failure;
 * - an Orb without ffmpeg failing differently from today's refusal;
 * - bytes fetched from a URL not reaching the Orb's downscale;
 * - a dx attachment downloaded by dxd not downsized, or left behind.
 */

const hasFfmpeg = (() => {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

/** The Orb, as a local shell. */
const shellSandbox = (cwd: string, env: Record<string, string> = {}) =>
  ({
    cwd,
    exec: (
      command: string,
      options?: { timeoutMs?: number; signal?: AbortSignal },
    ) =>
      new Promise((resolve) => {
        const child = spawn("/bin/sh", ["-c", command], {
          cwd,
          env: { ...process.env, ...env },
          ...(options?.timeoutMs === undefined
            ? {}
            : { timeout: options.timeoutMs }),
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("close", (code) =>
          resolve({ exitCode: code ?? 1, stdout, stderr }),
        );
      }),
    stat: async (path: string) => {
      const info = await stat(path);
      // As a Cloudflare container Orb's: no size.
      return { isFile: info.isFile(), isDirectory: info.isDirectory() };
    },
    // As a Cloudflare container Orb's file API: at most 16 MiB.
    readFileBuffer: async (path: string) => {
      if ((await stat(path)).size > 16 * 1024 * 1024)
        throw new Error(`${path} is larger than 16777216 bytes`);
      return new Uint8Array(await readFile(path));
    },
    writeFile: (path: string, content: string | Uint8Array) =>
      writeFile(path, content),
  }) as unknown as Sandbox;

const deps = {
  githubToken: async () => undefined,
  analyze: async () => {
    throw new Error("not used");
  },
  dxOrigin: "https://dx.example.com",
} satisfies ViewMediaDeps;

/** A noisy test pattern, as a JPEG photo would be, at 4:4:4. */
const photo = (path: string, width: number, height: number, noise: number) =>
  execFileSync("ffmpeg", [
    ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi"],
    ...["-i", `testsrc2=s=${width}x${height},noise=alls=${noise}:allf=t`],
    ...["-frames:v", "1", "-pix_fmt", "yuvj444p", "-q:v", "2", path],
  ]);

/**
 * A 10000×10000 progressive JPEG that is all scan headers: each AC scan
 * covers 1.5 million blocks with a few end-of-band runs, so a 3 MB file
 * keeps a decoder busy for minutes.
 */
const slowJpeg = (width: number, height: number, scans: number) => {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  const segment = (marker: number, body: number[]) => {
    const out = Buffer.alloc(4 + body.length);
    out[0] = 0xff;
    out[1] = marker;
    out.writeUInt16BE(body.length + 2, 2);
    Buffer.from(body).copy(out, 4);
    parts.push(out);
  };
  const twoCodes = [2, ...new Array(15).fill(0)];
  segment(0xdb, [0, ...new Array(64).fill(1)]);
  // One component, 1×1 sampling, quantization table 0.
  segment(0xc2, [
    ...[8, height >> 8, height & 255, width >> 8, width & 255],
    ...[1, 1, 0x11, 0],
  ]);
  segment(0xc4, [0x00, ...twoCodes, 0x00, 0x01]);
  segment(0xc4, [0x10, ...twoCodes, 0xe0, 0x00]);
  const blocks = Math.ceil(width / 8) * Math.ceil(height / 8);
  segment(0xda, [1, 1, 0, 0, 0, 0]);
  parts.push(Buffer.alloc(Math.ceil(blocks / 8)));
  // EOB run code "0" and 14 one bits: 32767 blocks, byte-stuffed.
  const bits = Array.from({ length: Math.ceil(blocks / 32767) }, () => [
    0,
    ...new Array(14).fill(1),
  ]).flat();
  while (bits.length % 8 !== 0) bits.push(1);
  const bytes: number[] = [];
  for (let at = 0; at < bits.length; at += 8) {
    const byte = bits
      .slice(at, at + 8)
      .reduce((value, bit) => (value << 1) | bit, 0);
    bytes.push(byte);
    if (byte === 0xff) bytes.push(0);
  }
  const run = Buffer.from(bytes);
  for (let scan = 0; scan < scans; scan++) {
    segment(0xda, [1, 1, 0, 1, 63, 0]);
    parts.push(run);
  }
  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
};

const leftovers = () =>
  readdirSync("/tmp").filter((name) => name.startsWith("dx-view-media-"));

describe.skipIf(!hasFfmpeg)("view_media downsizing in the Orb", () => {
  let dir: string;
  let before: string[];
  const file = (name: string) => join(dir, name);

  beforeAll(() => {
    before = leftovers();
    dir = mkdtempSync(join(tmpdir(), "dx-orb-image-test-"));
    photo(file("6k.jpg"), 6016, 3384, 8);
    // Past the container Orb's 16 MiB file reads, and past the isolate's
    // 20 MiB read cap.
    photo(file("photo-19mb.jpg"), 5600, 3800, 25);
    photo(file("photo-23mb.jpg"), 6000, 4000, 28);
    writeFileSync(file("slow.jpg"), slowJpeg(10000, 10000, 20_000));
    const bomb = slowJpeg(8, 8, 0);
    // The SOF's height and width, declared 60000×60000.
    bomb.writeUInt16BE(60000, 2 + 69 + 5);
    bomb.writeUInt16BE(60000, 2 + 69 + 7);
    writeFileSync(file("bomb.jpg"), bomb);
    // A full-page phone recording strip: small enough to send, too many
    // pixels to decode in the isolate (thr_40ba508d's video-390.png).
    execFileSync("ffmpeg", [
      ...["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi"],
      ...["-i", "testsrc2=s=1920x5190", "-frames:v", "1", file("tall.png")],
    ]);
  }, 120_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    // Nothing view_media wrote to /tmp stays there.
    expect(leftovers()).toEqual(before);
  });

  it.each([
    ["6k.jpg", 6016, 3384, 1125],
    ["photo-19mb.jpg", 5600, 3800, 1357],
    ["photo-23mb.jpg", 6000, 4000, 1333],
  ])("downsizes %s and says so", async (name, width, height, outHeight) => {
    const size = (await stat(file(name))).size;
    expect(size).toBeGreaterThan(3.75 * 1024 * 1024);
    const result = await viewMedia(
      shellSandbox(dir),
      { path: file(name) },
      deps,
    );
    expect(result.image?.mimeType).toBe("image/jpeg");
    const sent = Buffer.from(result.image?.data ?? "", "base64");
    expect(imageInfo(sent)).toEqual({
      format: "jpeg",
      width: 2000,
      height: outHeight,
    });
    expect(sent.length).toBeLessThan(3.75 * 1024 * 1024);
    expect(result.text).toMatch(
      new RegExp(
        `^${file(name)}: JPEG, 2000×${outHeight}, resized in the workspace from ${width}×${height} \\(${(size / 1024 / 1024).toFixed(1)} MB\\) to 2000×${outHeight} \\(\\d+ KB JPEG\\)\\.$`,
      ),
    );
    expect(result.details).toMatchObject({
      width: 2000,
      height: outHeight,
      sourceWidth: width,
      sourceHeight: height,
      sourceBytes: size,
      resizedIn: "workspace",
    });
    expect(leftovers()).toEqual(before);
  });

  it("downsizes a small image with too many pixels to decode in the isolate", async () => {
    // Sent at full size, it passed while a conversation held 20 images or
    // fewer, then made every later turn fail: providers refuse any image
    // over 2000–3000 px once a request holds more than 20.
    const size = (await stat(file("tall.png"))).size;
    expect(size).toBeLessThan(3.75 * 1024 * 1024);
    const result = await viewMedia(
      shellSandbox(dir),
      { path: file("tall.png") },
      deps,
    );
    const sent = Buffer.from(result.image?.data ?? "", "base64");
    expect(imageInfo(sent)).toEqual({
      format: "jpeg",
      width: 740,
      height: 2000,
    });
    expect(result.text).toMatch(
      new RegExp(
        `^${file("tall.png")}: PNG, 740×2000, resized in the workspace from 1920×5190 `,
      ),
    );
    expect(leftovers()).toEqual(before);
  });

  it("stops a decode that outlasts its timeout", async () => {
    const started = Date.now();
    await expect(
      viewMedia(shellSandbox(dir), { path: file("slow.jpg") }, deps),
    ).rejects.toThrow(
      `took over ${ORB_IMAGE_TIMEOUT_SECONDS} seconds, so it was stopped`,
    );
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(ORB_IMAGE_TIMEOUT_SECONDS * 1000);
    expect(elapsed).toBeLessThan((ORB_IMAGE_TIMEOUT_SECONDS + 5) * 1000);
    expect(leftovers()).toEqual(before);
  }, 60_000);

  it("refuses a pixel bomb before ffmpeg runs", async () => {
    const started = Date.now();
    await expect(
      viewMedia(shellSandbox(dir), { path: file("bomb.jpg") }, deps),
    ).rejects.toThrow("60000×60000, more than the 100 megapixels");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("keeps today's refusal in an Orb without ffmpeg", async () => {
    // Every tool the Orb image has, except ffmpeg.
    const bin = mkdtempSync(join(tmpdir(), "dx-orb-image-path-"));
    for (const tool of ["head", "wc", "mkdir", "rm", "tail", "timeout"])
      symlinkSync(
        execFileSync("sh", ["-c", `command -v ${tool}`], {
          encoding: "utf8",
        }).trim(),
        join(bin, tool),
      );
    const orb = shellSandbox(dir, { PATH: bin });
    try {
      await expect(
        viewMedia(orb, { path: file("6k.jpg") }, deps),
      ).rejects.toThrow(
        /^The image is 6016×3384 \(\d+\.\d MB\), too large to view\. Save a copy at most 2000 pixels .* ffmpeg -i/,
      );
      await expect(
        viewMedia(orb, { path: file("photo-19mb.jpg") }, deps),
      ).rejects.toThrow(
        /^The image is 5600×3800 \(18\.9 MB\), too large to view\./,
      );
      await expect(
        viewMedia(orb, { path: file("photo-23mb.jpg") }, deps),
      ).rejects.toThrow(
        /photo-23mb\.jpg is 22\.4 MB; files over 20\.0 MB are not read\.$/,
      );
      expect(leftovers()).toEqual(before);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it("downsizes bytes fetched from a URL in the Orb", async () => {
    const bytes = new Uint8Array(await readFile(file("6k.jpg")));
    const image = await downscaleInOrb(shellSandbox(dir), {
      input: { bytes },
      image: { format: "jpeg", width: 6016, height: 3384, bytes: bytes.length },
    });
    expect(image).toMatchObject({
      mimeType: "image/jpeg",
      width: 2000,
      height: 1125,
    });
    expect(leftovers()).toEqual(before);
  });

  it("downsizes a dx attachment where dxd downloaded it", async () => {
    const bin = mkdtempSync(join(tmpdir(), "dx-orb-image-bin-"));
    try {
      // dxd files get <url> -o <target>
      writeFileSync(
        join(bin, "dxd"),
        `#!/bin/sh\ncp ${JSON.stringify(file("photo-19mb.jpg"))} "$5"\n`,
      );
      chmodSync(join(bin, "dxd"), 0o755);
      const url = "https://dx.example.com/v1/attachments/att_1/photo.jpg";
      const result = await viewMedia(
        shellSandbox(dir, { PATH: `${bin}:${process.env.PATH}` }),
        { path: url },
        deps,
      );
      expect(result.text).toMatch(
        `${url}: JPEG, 2000×1357, resized in the workspace from 5600×3800`,
      );
      expect(leftovers()).toEqual(before);
    } finally {
      rmSync(bin, { recursive: true, force: true });
    }
  });
});
