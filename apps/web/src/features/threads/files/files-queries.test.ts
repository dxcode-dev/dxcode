import {
  SaveThreadFileRequestSchema,
  type ThreadFilesPath,
  type ThreadFilesWorktreeId,
  type ThreadFileVersion,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { expect, it } from "vitest";
import { createThreadFilesApi } from "./files-api.js";
import {
  saveThreadFileOptions,
  threadFileOptions,
  threadFileTreeOptions,
} from "./files-queries.js";

it("sends the Save mutation through the strict HTTP body contract without the URL path", async () => {
  const version = `sha256:${"a".repeat(64)}` as ThreadFileVersion;
  const api = createThreadFilesApi(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    // Core's decodeJsonBody rejects excess properties, not just invalid values.
    Schema.decodeUnknownSync(SaveThreadFileRequestSchema, {
      onExcessProperty: "error",
    })(body);
    expect(body).toEqual({
      content: "const saved = '✓';\n",
      expectedVersion: version,
    });
    return Response.json({
      status: "success",
      data: { kind: "saved", contentVersion: version },
    });
  });
  const options = saveThreadFileOptions(
    api,
    "thr_00000000-0000-4000-8000-000000000243" as ThreadId,
    "primary" as ThreadFilesWorktreeId,
    new QueryClient(),
  );
  if (options.mutationFn === undefined)
    throw new Error("Missing save mutation");
  const result = await options.mutationFn(
    {
      path: "src/proof.ts" as ThreadFilesPath,
      content: "const saved = '✓';\n",
      expectedVersion: version,
    },
    {} as never,
  );
  expect(result.kind).toBe("saved");
});

it("bounds read recovery retries while never retrying uncertain saves", () => {
  const api = createThreadFilesApi();
  const id = "thr_00000000-0000-4000-8000-000000000243" as ThreadId;
  const worktree = "primary" as ThreadFilesWorktreeId;
  const path = "src/proof.ts" as ThreadFilesPath;
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: 9 } },
  });

  expect(threadFileTreeOptions(api, id, worktree, undefined, true).retry).toBe(
    2,
  );
  expect(threadFileOptions(api, id, worktree, path, true).retry).toBe(2);
  expect(saveThreadFileOptions(api, id, worktree, client).retry).toBe(false);
});
