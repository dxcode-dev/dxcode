/**
 * Images in the artifact editor (the owner's request on #1651): Insert Image
 * from the toolbar or `/`, paste, and drop upload the file to the Thread and
 * write `![alt](url)`.
 *
 * Ways it can fail, each covered below:
 *  1. Insert Image (toolbar or `/`) does not open the file picker, or the
 *     picked file is not uploaded, or the `/image` text stays behind.
 *  2. A pasted or dropped image is not uploaded, or lands somewhere else.
 *  3. No progress shows while uploading, or the placeholder is saved as text.
 *  4. A refused or failed upload drops the image silently, or takes the rest
 *     of the edit with it; Retry or Remove does nothing.
 *  5. A file over 10 MB is sent anyway.
 *  6. The image has no alt text, alt text cannot be changed, or it overflows
 *     the page; a phone cannot open it full size.
 *  7. A 401 (the session ended elsewhere) does not show sign-in, as other
 *     requests' 401s do.
 */
import type { ThreadArtifact } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { AuthContext } from "../../../shared/auth/auth-context.js";
import { noticeUnauthenticated } from "../../../shared/auth/session-ended.js";
import { createQueryClient } from "../../../shared/query/query-client.js";
import { ArtifactEditor } from "./artifact-editor.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// The real module, with its session check observed.
vi.mock(
  import("../../../shared/auth/session-ended.js"),
  async (importOriginal) => {
    const real = await importOriginal();
    return {
      ...real,
      noticeUnauthenticated: vi.fn(real.noticeUnauthenticated),
    };
  },
);

const threadId = "thr_00000000-0000-4000-8000-0000000000e1" as ThreadId;
const userId = "usr_viewer" as UserId;
const URL_OF = (name: string) =>
  `/v1/threads/${threadId}/storage/tsf_${name.length}/${name}`;

const artifact = (): ThreadArtifact => ({
  id: `art_${"e".repeat(32)}`,
  threadId,
  folder: "",
  title: "Images",
  revision: 1,
  sizeBytes: 0,
  createdBy: { kind: "agent" },
  updatedBy: { kind: "agent" },
  openCommentCount: 0,
  createdAt: 0,
  updatedAt: 0,
});

/** An upload the test answers: progress, then success or a refusal. */
class FakeUpload {
  static all: FakeUpload[] = [];
  url = "";
  body: unknown;
  status = 0;
  responseText = "";
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open(_method: string, url: string) {
    this.url = url;
  }
  setRequestHeader() {}
  getResponseHeader() {
    return null;
  }
  abort() {
    this.onabort?.();
  }
  send(body: unknown) {
    this.body = body;
    FakeUpload.all.push(this);
  }
  progress(loaded: number, total: number) {
    this.upload.onprogress?.({
      loaded,
      total,
      lengthComputable: true,
    } as ProgressEvent);
  }
  succeed(name: string) {
    this.status = 201;
    this.responseText = JSON.stringify({
      status: "success",
      data: {
        id: `tsf_${name.length}`,
        url: URL_OF(name),
        name,
        mimeType: "image/png",
        size: 4,
      },
    });
    this.onload?.();
  }
  refuse(status: number, code: string, message: string) {
    this.status = status;
    this.responseText = JSON.stringify({
      status: "error",
      data: { code, message, requestId: "req_test" },
    });
    this.onload?.();
  }
}

const saves: string[] = [];

let root: Root | undefined;
afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  FakeUpload.all = [];
});

const mount = async (markdown: string) => {
  saves.length = 0;
  vi.stubGlobal("XMLHttpRequest", FakeUpload);
  // Saves succeed, as the server answers them; other reads never settle.
  let revision = 1;
  vi.stubGlobal("fetch", (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "PUT" && typeof init.body === "string") {
      const body = JSON.parse(init.body) as { markdown?: string };
      if (typeof body.markdown === "string") {
        saves.push(body.markdown);
        revision += 1;
        return Promise.resolve(
          Response.json({
            status: "success",
            data: {
              artifact: { ...artifact(), revision },
              markdown: body.markdown,
            },
          }),
        );
      }
    }
    return new Promise<Response>(() => {});
  });
  const client = createQueryClient();
  const container = document.body.appendChild(document.createElement("div"));
  container.style.height = "800px";
  container.style.width = "700px";
  container.style.display = "flex";
  root = createRoot(container);
  await React.act(() =>
    root?.render(
      <QueryClientProvider client={client}>
        <AuthContext
          value={{
            identity: { id: userId, name: "Viewer Self", email: "v@dx.test" },
            logout: () => undefined,
          }}
        >
          <ArtifactEditor
            threadId={threadId}
            initial={{ artifact: artifact(), markdown }}
            readOnly={false}
            switcher={null}
          />
        </AuthContext>
      </QueryClientProvider>,
    ),
  );
  const prose = container.querySelector<HTMLElement>(".artifact-prose");
  const input = container.querySelector<HTMLInputElement>(
    "input[type=file].artifact-image-input",
  );
  if (prose === null) throw new Error("Expected the editor.");
  return { container, prose, input };
};

const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
const type = async (text: string) => {
  await userEvent.keyboard(text);
  await settle();
};
const png = (name: string, size = 4) =>
  new File([new Uint8Array(size)], name, { type: "image/png" });
const placeholder = () =>
  document.querySelector<HTMLElement>(".artifact-image-upload");
/** The Markdown of the newest save, once the autosave has run. */
const lastSave = async () => {
  await settle(1_000);
  return saves.at(-1) ?? "";
};

describe("adding images", () => {
  it("Insert Image in / opens the picker, shows progress, and writes the image", async () => {
    const { prose, input } = await mount("Intro\n");
    if (input === null) throw new Error("No file input.");
    const opened = vi.spyOn(input, "click").mockImplementation(() => {});
    await userEvent.click(prose.querySelector("p") ?? prose);
    await type("{End}{Enter}/image{Enter}");
    expect([...prose.children].map((block) => block.textContent)).toEqual([
      "Intro",
      "",
    ]);
    expect(opened).toHaveBeenCalled();
    expect(prose.textContent).not.toContain("/image");
    await userEvent.upload(input, png("chart.png"));
    await settle();
    const upload = FakeUpload.all[0];
    expect(upload?.url).toContain(
      `/v1/threads/${threadId}/artifacts/images?name=chart.png`,
    );
    upload?.progress(1, 4);
    await settle();
    expect(
      placeholder()
        ?.querySelector("[role=progressbar]")
        ?.getAttribute("aria-valuenow"),
    ).toBe("25");
    // The placeholder is not text: a save meanwhile holds no trace of it.
    await type("{ArrowUp}{End} more");
    expect(await lastSave()).toBe("Intro more\n");
    upload?.succeed("chart.png");
    await settle();
    expect(placeholder()).toBeNull();
    // The image took the empty line it was asked for; nothing moved above.
    expect([...prose.children].map((block) => block.textContent)).toEqual([
      "Intro more",
      "OpenAlt text",
    ]);
    const image = prose.querySelector<HTMLImageElement>(".artifact-image img");
    expect(image?.getAttribute("src")).toBe(URL_OF("chart.png"));
    expect(image?.getAttribute("alt")).toBe("chart");
    expect(await lastSave()).toBe(
      `Intro more\n\n![chart](${URL_OF("chart.png")})\n`,
    );
  });

  it("Insert Image in the toolbar opens the picker", async () => {
    const { container, input } = await mount("Intro\n");
    if (input === null) throw new Error("No file input.");
    const opened = vi.spyOn(input, "click").mockImplementation(() => {});
    const insert = container.querySelector<HTMLElement>(
      ".artifact-toolbar [aria-label=Insert]",
    );
    if (insert === null) throw new Error("No Insert menu.");
    await userEvent.click(insert);
    const item = [
      ...document.querySelectorAll<HTMLElement>("[role=menuitem]"),
    ].find((element) => element.textContent?.includes("Image"));
    if (item === undefined) throw new Error("No Image item.");
    await userEvent.click(item);
    expect(opened).toHaveBeenCalled();
  });

  it("uploads a pasted image and a dropped one", async () => {
    const { prose } = await mount("First\n\nSecond\n");
    await userEvent.click(prose.querySelector("p") ?? prose);
    const pasted = new DataTransfer();
    pasted.items.add(png("pasted.png"));
    prose.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: pasted,
        bubbles: true,
        cancelable: true,
      }),
    );
    await settle();
    FakeUpload.all[0]?.succeed("pasted.png");
    await settle();
    const second = [...prose.querySelectorAll("p")].find(
      (paragraph) => paragraph.textContent === "Second",
    );
    if (second === undefined) throw new Error("No second paragraph.");
    const box = second.getBoundingClientRect();
    const dropped = new DataTransfer();
    dropped.items.add(png("dropped.png"));
    second.dispatchEvent(
      new DragEvent("drop", {
        dataTransfer: dropped,
        clientX: box.right - 2,
        clientY: box.top + box.height / 2,
        bubbles: true,
        cancelable: true,
      }),
    );
    await settle();
    FakeUpload.all[1]?.succeed("dropped.png");
    await settle();
    expect(await lastSave()).toBe(
      `First\n\n![pasted](${URL_OF("pasted.png")})\n\nSecond\n\n![dropped](${URL_OF("dropped.png")})\n`,
    );
  });

  it("keeps a refused upload on screen with Retry and Remove, and the rest of the edit", async () => {
    const { prose, input } = await mount("Intro\n");
    if (input === null) throw new Error("No file input.");
    await userEvent.click(prose);
    await type("{End}");
    await userEvent.upload(input, png("notes.png"));
    await settle();
    FakeUpload.all[0]?.refuse(
      415,
      "ARTIFACT_IMAGE_INVALID",
      "Only PNG, JPEG, GIF, or WebP.",
    );
    await settle();
    expect(placeholder()?.dataset.state).toBe("failed");
    expect(placeholder()?.textContent).toContain(
      "Only PNG, JPEG, GIF, and WebP images can be added.",
    );
    await type(" kept");
    expect(await lastSave()).toBe("Intro kept\n");
    const retry = [...(placeholder()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Retry",
    );
    retry?.click();
    await settle();
    expect(FakeUpload.all.length).toBe(2);
    expect(placeholder()?.dataset.state).toBe("uploading");
    FakeUpload.all[1]?.refuse(500, "ARTIFACTS_UNAVAILABLE", "Down.");
    await settle();
    const remove = [...(placeholder()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Remove",
    );
    remove?.click();
    await settle();
    expect(placeholder()).toBeNull();
    expect(prose.textContent).toBe("Intro kept");
  });

  it("checks the session when an upload is refused for want of one", async () => {
    const { prose, input } = await mount("Intro\n");
    if (input === null) throw new Error("No file input.");
    await userEvent.click(prose);
    await userEvent.upload(input, png("late.png"));
    await settle();
    FakeUpload.all[0]?.refuse(401, "UNAUTHENTICATED", "Sign in again.");
    await settle();
    const noticed = vi
      .mocked(noticeUnauthenticated)
      .mock.calls.map(([response]) => response.status);
    expect(noticed).toContain(401);
  });

  it("refuses a file over 10 MB without sending it", async () => {
    const { prose, input } = await mount("Intro\n");
    if (input === null) throw new Error("No file input.");
    await userEvent.click(prose);
    await userEvent.upload(input, png("huge.png", 10 * 1024 * 1024 + 1));
    await settle();
    expect(FakeUpload.all.length).toBe(0);
    expect(placeholder()?.textContent).toContain(
      "Images can be at most 10 MB.",
    );
  });
});

describe("an image in the document", () => {
  it("fits the page, edits its alt text, and opens full size", async () => {
    const { prose } = await mount(
      `Intro\n\n![old alt](${URL_OF("wide.png")})\n`,
    );
    const image = prose.querySelector<HTMLImageElement>(".artifact-image img");
    if (image === null) throw new Error("No image.");
    expect(getComputedStyle(image).maxWidth).toBe("100%");
    await userEvent.click(image);
    await settle();
    const open = document.querySelector<HTMLAnchorElement>(
      "a[aria-label='Open image']",
    );
    expect(open?.getAttribute("href")).toBe(URL_OF("wide.png"));
    expect(open?.getAttribute("target")).toBe("_blank");
    const edit = document.querySelector<HTMLElement>(
      "button[aria-label='Alt text']",
    );
    if (edit === null) throw new Error("No Alt text button.");
    await userEvent.click(edit);
    const field = document.querySelector<HTMLInputElement>(
      "input[aria-label='Alt text']",
    );
    if (field === null) throw new Error("No alt text field.");
    await userEvent.clear(field);
    await userEvent.type(field, "Weekly chart{Enter}");
    await settle();
    expect(
      prose.querySelector(".artifact-image img")?.getAttribute("alt"),
    ).toBe("Weekly chart");
    expect(await lastSave()).toBe(
      `Intro\n\n![Weekly chart](${URL_OF("wide.png")})\n`,
    );
  });
});
