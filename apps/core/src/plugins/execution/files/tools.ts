import { posix } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { Sandbox, SandboxToolFactory } from "@flue/runtime";
import { createTwoFilesPatch } from "diff";
import {
  createFileDescription,
  createFileParameters,
  editFileDescription,
  editFileParameters,
} from "./definitions.js";

type AgentTool = ReturnType<SandboxToolFactory>[number];

const absolute = (path: string) => {
  if (!posix.isAbsolute(path)) throw new Error("path must be absolute.");
};

/** A fenced unified patch, blank line, then inclusive new-file line range.
 * Deletions use the surviving line at the deletion point, clamped to EOF.
 */
export const formatEditResult = (
  path: string,
  before: string,
  after: string,
  range: readonly [number, number],
) => {
  const filename = path.replace(/^\/+/, "");
  const patch = createTwoFilesPatch(
    `a/${filename}`,
    `b/${filename}`,
    before,
    after,
    undefined,
    undefined,
    { context: 3 },
  ).replace(/^=+\n/, "");
  return `\`\`\`diff\n${patch}\`\`\`\n\n[${range[0]}, ${range[1]}]`;
};

export const createFileTools = (sandbox: Sandbox): AgentTool[] => [
  {
    name: "create_file",
    label: "Create File",
    description: createFileDescription,
    parameters: Type.Unsafe<{ path: string; content: string }>(
      createFileParameters,
    ),
    async execute(_id, input, signal) {
      const params = input as { path: string; content: string };
      signal?.throwIfAborted();
      absolute(params.path);
      await sandbox.mkdir(posix.dirname(params.path), { recursive: true });
      signal?.throwIfAborted();
      await sandbox.writeFile(params.path, params.content);
      signal?.throwIfAborted();
      return {
        content: [
          { type: "text", text: `Successfully created file ${params.path}` },
        ],
        details: { path: params.path },
      };
    },
  },
  {
    name: "edit_file",
    label: "Edit File",
    description: editFileDescription,
    parameters: Type.Unsafe<{
      path: string;
      old_str: string;
      new_str: string;
      replace_all?: boolean;
    }>(editFileParameters),
    async execute(_id, input, signal) {
      const params = input as {
        path: string;
        old_str: string;
        new_str: string;
        replace_all?: boolean;
      };
      signal?.throwIfAborted();
      absolute(params.path);
      if (params.old_str === params.new_str)
        throw new Error("old_str and new_str must be different.");
      if (params.old_str === "") throw new Error("old_str must not be empty.");
      const bytes = await sandbox.readFileBuffer(params.path);
      signal?.throwIfAborted();
      let before: string;
      try {
        before = new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(bytes);
        if (before.includes("\0")) throw new Error("binary");
      } catch {
        throw new Error(`Cannot edit binary or non-UTF-8 file ${params.path}.`);
      }
      const pieces = before.split(params.old_str);
      const matches = pieces.length - 1;
      if (matches === 0)
        throw new Error(`old_str not found in ${params.path}.`);
      if (!params.replace_all && matches !== 1)
        throw new Error(
          `Found ${matches} matches in ${params.path}; old_str must be unique or replace_all must be true.`,
        );
      const after = pieces.join(params.new_str);
      let offset = (pieces[0] ?? "").length;
      const start = after.slice(0, offset).split("\n").length;
      for (let index = 1; index < matches; index++)
        offset += params.new_str.length + (pieces[index] ?? "").length;
      const last =
        after.slice(0, offset + params.new_str.length).split("\n").length -
        (params.new_str.endsWith("\n") ? 1 : 0);
      const lines = Math.max(
        1,
        after.split("\n").length - (after.endsWith("\n") ? 1 : 0),
      );
      const range: [number, number] = [
        Math.min(start, lines),
        Math.min(Math.max(start, last), lines),
      ];
      const text = formatEditResult(params.path, before, after, range);
      signal?.throwIfAborted();
      await sandbox.writeFile(params.path, after);
      signal?.throwIfAborted();
      return {
        content: [{ type: "text", text }],
        details: { path: params.path, replacements: matches, lineRange: range },
      };
    },
  },
];
