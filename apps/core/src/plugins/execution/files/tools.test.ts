import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sandbox } from "@flue/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileDescription,
  createFileParameters,
  editFileDescription,
  editFileParameters,
} from "./definitions.js";
import { createFileTools } from "./tools.js";

describe("file tools", () => {
  let root: string;
  let sandbox: Sandbox;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "dx-files-"));
    sandbox = {
      mkdir,
      readFileBuffer: readFile,
      writeFile,
    } as unknown as Sandbox;
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const call = (name: string, params: unknown, signal?: AbortSignal) => {
    const tool = createFileTools(sandbox).find((tool) => tool.name === name);
    if (!tool) throw new Error(`Unknown tool ${name}`);
    return tool.execute("test", params, signal);
  };
  const edit = (params: Record<string, unknown>) =>
    call("edit_file", {
      path: join(root, "a"),
      old_str: "old",
      new_str: "new",
      ...params,
    });

  it("exposes the exact model definitions", () => {
    expect(
      createFileTools(sandbox).map(({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      })),
    ).toEqual([
      {
        name: "create_file",
        description: createFileDescription,
        parameters: createFileParameters,
      },
      {
        name: "edit_file",
        description: editFileDescription,
        parameters: editFileParameters,
      },
    ]);
    expect(createFileDescription.endsWith("\n")).toBe(true);
    expect(editFileDescription.endsWith("\n")).toBe(true);
    expect(
      createFileTools(sandbox).map(({ name, description, parameters }) => ({
        name,
        description,
        parameters: JSON.parse(JSON.stringify(parameters)),
      })),
    ).toMatchSnapshot();
  });
  it("creates nested files and overwrites existing content", async () => {
    const path = join(root, "nested/a");
    expect(
      (await call("create_file", { path, content: "one" })).content,
    ).toEqual([{ type: "text", text: `Successfully created file ${path}` }]);
    await call("create_file", { path, content: "two" });
    expect(await readFile(path, "utf8")).toBe("two");
  });
  it.each(["create_file", "edit_file"])(
    "rejects relative paths for %s",
    async (name) => {
      await expect(
        call(name, { path: "a", content: "x", old_str: "old", new_str: "new" }),
      ).rejects.toThrow("absolute");
    },
  );
  it("returns a unified diff and changed new-file range", async () => {
    await writeFile(join(root, "a"), "context\nold\nend\n");
    const result = await edit({ new_str: "new\nextra" });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("```diff\n--- a/"),
    });
    expect(result.content[0]).toMatchObject({
      text: expect.stringContaining("-old\n+new\n+extra\n"),
    });
    expect(result.details).toMatchObject({ lineRange: [2, 3] });
    expect(await readFile(join(root, "a"), "utf8")).toBe(
      "context\nnew\nextra\nend\n",
    );
  });
  it("counts multiple matches and replaces all literally", async () => {
    await writeFile(join(root, "a"), "old\nold\n");
    await expect(edit({})).rejects.toThrow("2 matches");
    const result = await edit({ replace_all: true, new_str: "$&" });
    expect(await readFile(join(root, "a"), "utf8")).toBe("$&\n$&\n");
    expect(result.details).toMatchObject({
      lineRange: [1, 2],
      replacements: 2,
    });
  });
  it("fails for missing files", async () => {
    await expect(edit({})).rejects.toThrow();
  });
  it("covers all replacement regions after line-count changes", async () => {
    await writeFile(join(root, "a"), "first\nold\nmiddle\nold\nlast\n");
    const result = await edit({ replace_all: true, new_str: "new\nextra" });
    expect(result.details).toMatchObject({ lineRange: [2, 6] });
  });
  it("anchors deletions at EOF to a surviving line", async () => {
    await writeFile(join(root, "a"), "first\nold\n");
    const result = await edit({ old_str: "old\n", new_str: "" });
    expect(result.details).toMatchObject({ lineRange: [1, 1] });
    expect(await readFile(join(root, "a"), "utf8")).toBe("first\n");
  });
  it("checks cancellation after reading and before writing", async () => {
    const controller = new AbortController();
    await writeFile(join(root, "a"), "old");
    sandbox.readFileBuffer = async (path) => {
      const bytes = await readFile(path);
      controller.abort();
      return bytes;
    };
    await expect(
      call(
        "edit_file",
        { path: join(root, "a"), old_str: "old", new_str: "new" },
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(await readFile(join(root, "a"), "utf8")).toBe("old");
  });
  it.each([
    [{ new_str: "old" }, "different"],
    [{ old_str: "absent" }, "not found"],
    [{ old_str: "" }, "empty"],
  ])("rejects invalid replacements %j", async (params, message) => {
    await writeFile(join(root, "a"), "old");
    await expect(edit(params)).rejects.toThrow(message);
    expect(await readFile(join(root, "a"), "utf8")).toBe("old");
  });
  it("preserves CRLF, BOM, and missing trailing newline", async () => {
    await writeFile(join(root, "a"), "\ufefffirst\r\nold\r\nlast");
    await edit({});
    expect(await readFile(join(root, "a"), "utf8")).toBe(
      "\ufefffirst\r\nnew\r\nlast",
    );
  });
  it.each([Buffer.from([0, 1]), Buffer.from([255])])(
    "refuses binary files",
    async (bytes) => {
      await writeFile(join(root, "a"), bytes);
      await expect(edit({})).rejects.toThrow("binary");
    },
  );
  it("honours cancellation before mutation", async () => {
    await expect(
      call(
        "create_file",
        { path: join(root, "a"), content: "x" },
        AbortSignal.abort(),
      ),
    ).rejects.toThrow();
  });
});
