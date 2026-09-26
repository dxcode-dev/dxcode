import { PersonalApiTokenId, UserId } from "@dx/domain";
import { QueryClient } from "@tanstack/react-query";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  browserSessionsQueryOptions,
  createPersonalApiTokenMutationOptions,
  personalApiTokensQueryOptions,
  rotatePersonalApiTokenMutationOptions,
  securityKeys,
} from "./security-queries.js";

const userId = Schema.decodeUnknownSync(UserId)("user-1");
const plaintext = `dxu_${"a".repeat(40)}`;
const token = {
  id: "token-1",
  name: "Local CLI",
  identifier: "dxu_abcd1234",
  scopes: ["projects:read"],
  createdAt: "2026-08-23T12:00:00.000Z",
} as const;

afterEach(() => vi.unstubAllGlobals());

describe("personal security query contracts", () => {
  it("uses a user-scoped infinite key and the server offset", () => {
    const options = browserSessionsQueryOptions(userId);
    expect(options.queryKey).toEqual(securityKeys.sessions(userId));
    expect(
      options.getNextPageParam?.(
        { items: [], nextOffset: 25 },
        [],
        undefined,
        [],
      ),
    ).toBe(25);
  });

  it("reveals one-display plaintext locally while caching only token metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json({
          status: "success",
          data: { token, plaintext },
        }),
      ),
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData(securityKeys.tokens(userId), []);
    let revealed: unknown;
    const mutation = queryClient.getMutationCache().build(
      queryClient,
      createPersonalApiTokenMutationOptions(queryClient, userId, (secret) => {
        revealed = secret;
      }),
    );

    const result = await mutation.execute({
      name: token.name,
      scopes: token.scopes,
    });

    expect(JSON.stringify(revealed)).toContain(plaintext);
    expect(mutation.options.gcTime).toBe(0);
    expect(JSON.stringify(result)).not.toContain(plaintext);
    expect(JSON.stringify(mutation.state.data)).not.toContain(plaintext);
    expect(
      JSON.stringify(queryClient.getQueryData(securityKeys.tokens(userId))),
    ).not.toContain(plaintext);
    expect(queryClient.getQueryData(securityKeys.tokens(userId))).toEqual([
      result,
    ]);
  });

  it("cancels a stale token read before caching created metadata", async () => {
    let readSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>((_input, init) => {
        if (init?.method === "POST")
          return Promise.resolve(
            Response.json({
              status: "success",
              data: { token, plaintext },
            }),
          );
        readSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          readSignal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      }),
    );
    const queryClient = new QueryClient();
    const query = personalApiTokensQueryOptions(userId);
    queryClient.setQueryData(query.queryKey, []);
    const stale = queryClient.fetchQuery({ ...query, staleTime: 0 });
    void stale.catch(() => undefined);
    await vi.waitFor(() => expect(readSignal).toBeDefined());
    const mutation = queryClient.getMutationCache().build(
      queryClient,
      createPersonalApiTokenMutationOptions(queryClient, userId, () => {}),
    );

    const metadata = await mutation.execute({
      name: token.name,
      scopes: token.scopes,
    });

    expect(readSignal?.aborted).toBe(true);
    expect(queryClient.getQueryData(query.queryKey)).toEqual([metadata]);
  });

  it("leaves the in-flight token read to complete when caching a token while the tokens cache is undefined", async () => {
    let readSignal: AbortSignal | undefined;
    let resolveRead!: (response: Response) => void;
    const readPromise = new Promise<Response>((resolve) => {
      resolveRead = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>((_input, init) => {
        if (init?.method === "POST")
          return Promise.resolve(
            Response.json({ status: "success", data: { token, plaintext } }),
          );
        readSignal = init?.signal ?? undefined;
        return readPromise;
      }),
    );
    const queryClient = new QueryClient();
    const query = personalApiTokensQueryOptions(userId);
    const stale = queryClient.fetchQuery({ ...query, staleTime: 0 });
    void stale.catch(() => undefined);
    await vi.waitFor(() => expect(readSignal).toBeDefined());
    const mutation = queryClient.getMutationCache().build(
      queryClient,
      createPersonalApiTokenMutationOptions(queryClient, userId, () => {}),
    );

    const metadata = await mutation.execute({
      name: token.name,
      scopes: token.scopes,
    });

    expect(readSignal?.aborted).toBe(false);
    expect(queryClient.getQueryData(query.queryKey)).toBeUndefined();

    resolveRead(Response.json({ status: "success", data: { items: [] } }));
    const data = await stale;

    expect(data).toEqual([]);
    expect(queryClient.getQueryData(query.queryKey)).toEqual([]);
    expect(queryClient.getQueryData(query.queryKey)).not.toContainEqual(
      metadata,
    );
  });

  it("replaces rotated token metadata without retaining either plaintext or the revoked ID", async () => {
    const replacement = { ...token, id: "token-2", identifier: "dxu_efgh5678" };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json({
          status: "success",
          data: { token: replacement, plaintext },
        }),
      ),
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData(securityKeys.tokens(userId), [token]);
    let revealed: unknown;
    const mutation = queryClient.getMutationCache().build(
      queryClient,
      rotatePersonalApiTokenMutationOptions(queryClient, userId, (secret) => {
        revealed = secret;
      }),
    );

    await mutation.execute(
      Schema.decodeUnknownSync(PersonalApiTokenId)(token.id),
    );

    const cached = queryClient.getQueryData(securityKeys.tokens(userId));
    expect(mutation.options.gcTime).toBe(0);
    expect(JSON.stringify(revealed)).toContain(plaintext);
    expect(JSON.stringify(mutation.state.data)).not.toContain(plaintext);
    expect(JSON.stringify(cached)).not.toContain(plaintext);
    expect(cached).toMatchObject([{ id: replacement.id }]);
    expect(cached).not.toMatchObject([{ id: token.id }]);
  });
});
