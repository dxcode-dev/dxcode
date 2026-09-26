import { UserId } from "@dx/domain";
import { QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  personalAdvancedKeys,
  personalAgentInstructionsQueryOptions,
  resetPersonalAgentInstructionsMutationOptions,
  updatePersonalAgentInstructionsMutationOptions,
} from "./personal-advanced-queries.js";

const userId = Schema.decodeUnknownSync(UserId)("user-1");
const saved = {
  instructions: "Use focused changes.",
  revision: 2,
  version: 1,
  updatedAt: "2026-08-25T12:00:00.000Z",
} as const;

afterEach(() => vi.unstubAllGlobals());

const verifyStaleGetCannotWin = async (
  executeMutation: (queryClient: QueryClient) => Promise<unknown>,
) => {
  let resolveStale: (response: Response) => void = () => undefined;
  const staleResponse = new Promise<Response>((resolve) => {
    resolveStale = resolve;
  });
  vi.stubGlobal(
    "fetch",
    vi
      .fn<typeof globalThis.fetch>()
      .mockImplementation((_request, init) =>
        init?.method === "PATCH"
          ? Promise.resolve(Response.json({ status: "success", data: saved }))
          : staleResponse,
      ),
  );
  const queryClient = new QueryClient();
  const staleGet = queryClient
    .fetchQuery(personalAgentInstructionsQueryOptions(userId))
    .catch(() => undefined);
  await executeMutation(queryClient);
  resolveStale(
    Response.json({
      status: "success",
      data: { ...saved, instructions: "Stale instructions", revision: 1 },
    }),
  );
  await staleGet;

  expect(
    queryClient.getQueryData(personalAdvancedKeys.instructions(userId)),
  ).toMatchObject({
    instructions: saved.instructions,
    revision: saved.revision,
  });
};

describe("personal instructions mutations", () => {
  it("protects an update from an in-flight stale GET", () =>
    verifyStaleGetCannotWin((queryClient) =>
      queryClient
        .getMutationCache()
        .build(
          queryClient,
          updatePersonalAgentInstructionsMutationOptions(queryClient, userId),
        )
        .execute({ instructions: saved.instructions, expectedRevision: 1 }),
    ));

  it("protects a reset from an in-flight stale GET", () =>
    verifyStaleGetCannotWin((queryClient) =>
      queryClient
        .getMutationCache()
        .build(
          queryClient,
          resetPersonalAgentInstructionsMutationOptions(queryClient, userId),
        )
        .execute(1),
    ));
});
