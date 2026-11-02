// Ways a project icon upload can fail, each covered below:
// - bytes that are not a PNG, JPEG, or WebP image are stored because the
//   request's content type (the file extension, in a browser) says image;
// - an oversized or non-image upload answers with a generic error that does
//   not say what to choose instead;
// - a refused upload leaves an object in storage or changes the project;
// - a stored icon is served without nosniff, or with the claimed type
//   rather than the type its bytes prove.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  bindings,
  createProductApp,
  createProjectViaApi,
} from "./product-route-fixture.js";

const withStorage = { ...bindings, DX_STORAGE: env.DX_STORAGE };

const png = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const webp = new Uint8Array([
  ...new TextEncoder().encode("RIFF"),
  0x10,
  0x00,
  0x00,
  0x00,
  ...new TextEncoder().encode("WEBPVP8 "),
]);

const putIcon = (
  projectId: string,
  revision: number,
  body: BodyInit,
  contentType: string,
) =>
  createProductApp().request(
    `/projects/${projectId}/icon`,
    {
      method: "PUT",
      headers: {
        "content-type": contentType,
        "x-project-revision": String(revision),
      },
      body,
    },
    withStorage,
  );

const storedIcons = async (projectId: string) =>
  (await env.DX_STORAGE.list({ prefix: `projects/${projectId}/` })).objects;

describe("project icon uploads in workerd with real D1 and R2", () => {
  it("refuses non-image bytes and oversized files with a message that says what to choose", async () => {
    const project = (await createProjectViaApi("icon-refusals")).data;

    const refused = [
      // Text named fake.png: the browser sends image/png.
      await putIcon(project.id, project.revision, "hello", "image/png"),
      // SVG can carry script even with a PNG name.
      await putIcon(
        project.id,
        project.revision,
        '<svg xmlns="http://www.w3.org/2000/svg"/>',
        "image/png",
      ),
      await putIcon(project.id, project.revision, "hello", "text/plain"),
      await putIcon(
        project.id,
        project.revision,
        new Uint8Array(),
        "image/png",
      ),
    ];
    for (const response of refused) {
      expect(response.status).toBe(415);
      expect(await response.json()).toMatchObject({
        status: "error",
        data: {
          code: "PROJECT_ICON_NOT_IMAGE",
          message: "Choose a PNG, JPEG, or WebP image.",
        },
      });
    }

    const oversized = new Uint8Array(6 * 1024 * 1024);
    oversized.set(png);
    const tooLarge = await putIcon(
      project.id,
      project.revision,
      oversized,
      "image/png",
    );
    expect(tooLarge.status).toBe(413);
    expect(await tooLarge.json()).toMatchObject({
      status: "error",
      data: {
        code: "PROJECT_ICON_TOO_LARGE",
        message: "Choose an image of 512 KB or less.",
      },
    });

    expect(await storedIcons(project.id)).toEqual([]);
    const after = (await (
      await createProductApp().request(
        `/projects/${project.id}`,
        {},
        withStorage,
      )
    ).json()) as { data: { revision: number; iconUrl?: string } };
    expect(after.data.revision).toBe(project.revision);
    expect(after.data).not.toHaveProperty("iconUrl");
  });

  it.each([
    { name: "PNG", bytes: png, type: "image/png" },
    { name: "JPEG", bytes: jpeg, type: "image/jpeg" },
    { name: "WebP", bytes: webp, type: "image/webp" },
  ])(
    "stores a $name icon and serves it as the type its bytes prove, with nosniff",
    async ({ bytes, type }) => {
      const project = (await createProjectViaApi(`icon-${type.slice(6)}`)).data;
      // The claimed type is wrong on purpose: the bytes decide.
      const response = await putIcon(
        project.id,
        project.revision,
        bytes,
        "application/octet-stream",
      );
      expect(response.status).toBe(200);
      const updated = (await response.json()) as {
        data: { iconUrl: string };
      };
      const served = await createProductApp().request(
        updated.data.iconUrl.replace(/^\/v1/, ""),
        {},
        withStorage,
      );
      expect(served.status).toBe(200);
      expect(served.headers.get("content-type")).toBe(type);
      expect(served.headers.get("x-content-type-options")).toBe("nosniff");
      expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
      expect(await storedIcons(project.id)).toHaveLength(1);
    },
  );
});
