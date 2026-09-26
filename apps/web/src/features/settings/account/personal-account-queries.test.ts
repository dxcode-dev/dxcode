import { UserId } from "@dx/domain";
import { QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  personalAccountKeys,
  personalAccountQueryOptions,
  updatePersonalAccountMutationOptions,
  updatePersonalAppearanceMutationOptions,
} from "./personal-account-queries.js";

const userId = Schema.decodeUnknownSync(UserId)("user-1");
const otherUserId = Schema.decodeUnknownSync(UserId)("user-2");
const account = {
  displayName: "Test User",
  username: "test-user",
  email: "test@example.com",
  emailVerified: true,
  identityAuthority: "local-password",
  threadCount: 2,
  appearance: "dark",
  palette: "daydream",
  terminalTheme: "github",
} as const;

afterEach(() => vi.unstubAllGlobals());

describe("personal account query contracts", () => {
  it("reuses the existing user-scoped key for every account consumer", () => {
    expect(personalAccountQueryOptions(userId).queryKey).toEqual(
      personalAccountKeys.detail(userId),
    );
    expect(personalAccountQueryOptions(otherUserId).queryKey).not.toEqual(
      personalAccountQueryOptions(userId).queryKey,
    );
  });

  it("forwards Query cancellation to the account request", async () => {
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => {
        requestSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) =>
          requestSignal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          ),
        );
      }),
    );
    const queryClient = new QueryClient();
    const pending = queryClient.fetchQuery(personalAccountQueryOptions(userId));

    await queryClient.cancelQueries({
      queryKey: personalAccountKeys.detail(userId),
    });

    expect(requestSignal?.aborted).toBe(true);
    await expect(pending).rejects.toBeDefined();
  });

  it("writes the authoritative account returned by update", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(Response.json({ status: "success", data: account })),
    );
    const queryClient = new QueryClient();
    const mutation = queryClient
      .getMutationCache()
      .build(
        queryClient,
        updatePersonalAccountMutationOptions(queryClient, userId),
      );

    const updated = await mutation.execute({
      displayName: account.displayName,
      username: account.username,
    });

    expect(queryClient.getQueryData(personalAccountKeys.detail(userId))).toBe(
      updated,
    );
  });

  it("applies appearance optimistically and restores it when persistence fails", async () => {
    let rejectRequest: (error: Error) => void = () => undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockReturnValue(
        new Promise<Response>((_resolve, reject) => {
          rejectRequest = reject;
        }),
      ),
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData(personalAccountKeys.detail(userId), account);
    const mutation = queryClient
      .getMutationCache()
      .build(
        queryClient,
        updatePersonalAppearanceMutationOptions(queryClient, userId),
      );

    const pending = mutation.execute({
      appearance: "light",
      palette: "deadpan",
      terminalTheme: "gruvbox",
    });
    const rejected = expect(pending).rejects.toThrow(
      "appearance persistence failed",
    );
    await vi.waitFor(() =>
      expect(
        queryClient.getQueryData(personalAccountKeys.detail(userId)),
      ).toMatchObject({
        appearance: "light",
        palette: "deadpan",
        terminalTheme: "gruvbox",
      }),
    );
    rejectRequest(new Error("appearance persistence failed"));
    await rejected;
    expect(
      queryClient.getQueryData(personalAccountKeys.detail(userId)),
    ).toStrictEqual(account);
  });

  it("serializes partial appearance saves without losing a newer choice", async () => {
    const patchResolvers: Array<(response: Response) => void> = [];
    const requestBodies: unknown[] = [];
    const finalAccount = {
      ...account,
      appearance: "light" as const,
      palette: "deadpan" as const,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockImplementation((_input, init) => {
        if (init?.method !== "PATCH")
          return Promise.resolve(
            Response.json({ status: "success", data: finalAccount }),
          );
        requestBodies.push(JSON.parse(String(init.body)));
        return new Promise<Response>((resolve) => patchResolvers.push(resolve));
      }),
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData(personalAccountKeys.detail(userId), account);
    const options = updatePersonalAppearanceMutationOptions(
      queryClient,
      userId,
    );
    const first = queryClient.getMutationCache().build(queryClient, options);
    const second = queryClient.getMutationCache().build(queryClient, options);

    const appearanceSave = first.execute({ appearance: "light" });
    const paletteSave = second.execute({ palette: "deadpan" });
    await vi.waitFor(() => expect(requestBodies).toHaveLength(1));
    expect(requestBodies[0]).toEqual({ appearance: "light" });
    patchResolvers[0]?.(
      Response.json({
        status: "success",
        data: { ...account, appearance: "light" },
      }),
    );
    await vi.waitFor(() => expect(requestBodies).toHaveLength(2));
    expect(requestBodies[1]).toEqual({ palette: "deadpan" });
    patchResolvers[1]?.(
      Response.json({ status: "success", data: finalAccount }),
    );
    await Promise.all([appearanceSave, paletteSave]);
    await vi.waitFor(() =>
      expect(
        queryClient.getQueryData(personalAccountKeys.detail(userId)),
      ).toMatchObject({ appearance: "light", palette: "deadpan" }),
    );
  });

  it("cancels an in-flight stale account GET before caching an update", async () => {
    let resolveStale: (response: Response) => void = () => undefined;
    const staleResponse = new Promise<Response>((resolve) => {
      resolveStale = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof globalThis.fetch>()
        .mockImplementation((_input, init) =>
          init?.method === "PATCH"
            ? Promise.resolve(
                Response.json({ status: "success", data: account }),
              )
            : staleResponse,
        ),
    );
    const queryClient = new QueryClient();
    const staleGet = queryClient
      .fetchQuery(personalAccountQueryOptions(userId))
      .catch(() => undefined);
    const mutation = queryClient
      .getMutationCache()
      .build(
        queryClient,
        updatePersonalAccountMutationOptions(queryClient, userId),
      );

    await mutation.execute({
      displayName: account.displayName,
      username: account.username,
    });
    resolveStale(
      Response.json({
        status: "success",
        data: { ...account, displayName: "Stale User" },
      }),
    );
    await staleGet;

    expect(
      queryClient.getQueryData(personalAccountKeys.detail(userId)),
    ).toMatchObject({
      displayName: account.displayName,
      username: account.username,
    });
  });
});
