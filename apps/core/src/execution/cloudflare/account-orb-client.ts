import {
  ACCOUNT_ORB_METHODS,
  type AccountOrbMethod,
  decodeRpcValue,
  encodeRpcValue,
} from "./account-orb-protocol.js";
import type { OrbContainerObject } from "./orb-container-object.js";

/** The Orb container object methods Core calls, by either route. */
export type OrbContainerRpc = {
  readonly [Method in AccountOrbMethod]: (
    ...args: Parameters<OrbContainerObject[Method]>
  ) => Promise<Awaited<ReturnType<OrbContainerObject[Method]>>>;
};

export class AccountOrbUnavailable extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Waits this long for one call; `exec` adds its own command timeout. */
const CALL_TIMEOUT_MS = 120_000;
/**
 * An open may retry a stuck cold start (#1783), up to 155 s; Core bounds it
 * at `CLOUDFLARE_OPEN_TIMEOUT_MS` (180 s), and this call must not end first.
 */
const OPEN_CALL_TIMEOUT_MS = 180_000;

/**
 * One Thread's Orb container object in a person's or workspace's own
 * Cloudflare account, through that account's Orb Worker
 * (`account-orb-worker.ts`).
 */
export const accountOrbContainer = (input: {
  readonly endpoint: string;
  readonly secret: string;
  readonly threadId: string;
  readonly fetch?: typeof fetch;
}): OrbContainerRpc => {
  const send = input.fetch ?? fetch;
  const call =
    (method: AccountOrbMethod) =>
    async (...args: ReadonlyArray<unknown>): Promise<never> => {
      const options = args[1] as { readonly timeoutMs?: number } | undefined;
      const timeoutMs =
        (method === "open" ? OPEN_CALL_TIMEOUT_MS : CALL_TIMEOUT_MS) +
        (method === "exec" && typeof options?.timeoutMs === "number"
          ? options.timeoutMs
          : 0);
      // A timer the call clears, rather than `AbortSignal.timeout`, so tests
      // can drive it with fake timers.
      const timeout = new AbortController();
      const timer = setTimeout(
        () =>
          timeout.abort(
            new DOMException("The operation timed out.", "TimeoutError"),
          ),
        timeoutMs,
      );
      try {
        const response = await send(new URL("/rpc", input.endpoint), {
          method: "POST",
          headers: {
            authorization: `Bearer ${input.secret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            threadId: input.threadId,
            method,
            args: args.map(encodeRpcValue),
          }),
          signal: timeout.signal,
        });
        const body = (await response.json().catch(() => undefined)) as
          | { readonly result?: unknown; readonly error?: unknown }
          | undefined;
        if (!response.ok)
          throw new AccountOrbUnavailable(
            response.status,
            typeof body?.error === "string"
              ? body.error
              : `The account Orb Worker answered ${response.status}.`,
          );
        return decodeRpcValue(body?.result) as never;
      } finally {
        clearTimeout(timer);
      }
    };
  return Object.fromEntries(
    ACCOUNT_ORB_METHODS.map((method) => [method, call(method)]),
  ) as unknown as OrbContainerRpc;
};

/**
 * Whether the account Orb Worker serves with this secret, uploaded for
 * `recipe`.
 */
export const accountOrbHealth = async (input: {
  readonly endpoint: string;
  readonly secret: string;
  readonly recipe: string;
  readonly fetch?: typeof fetch;
}) => {
  const response = await (input.fetch ?? fetch)(
    new URL("/health", input.endpoint),
    {
      headers: { authorization: `Bearer ${input.secret}` },
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    readonly recipe?: unknown;
  };
  return response.ok && body.recipe === input.recipe;
};
