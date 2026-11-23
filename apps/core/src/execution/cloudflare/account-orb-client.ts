import { readBoundedText } from "../../http/bounded-body.js";
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

/**
 * The largest reply Core reads from an account Orb Worker. That Worker runs
 * in the person's own account, so Core cannot trust it to keep the object's
 * caps. The largest real reply is a 16 MiB `readFile` as base64 (about
 * 21.3 MiB), or `exec`'s two 8 MiB output streams as JSON strings.
 */
export const ACCOUNT_ORB_MAX_REPLY_BYTES = 32 * 1024 * 1024;

/** Waits this long for one call; `exec` adds its own command timeout. */
const CALL_TIMEOUT_MS = 120_000;
/**
 * An open may wait up to 300 s for a slow start (#1956); Core bounds it at
 * `CLOUDFLARE_OPEN_TIMEOUT_MS` (330 s), and this call must not end first.
 */
const OPEN_CALL_TIMEOUT_MS = 330_000;

/** A reply's JSON object, else undefined. */
const parseReply = (
  text: string,
): { readonly [field: string]: unknown } | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null
      ? (value as { readonly [field: string]: unknown })
      : undefined;
  } catch {
    return undefined;
  }
};

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
        const text = await readBoundedText(
          response,
          ACCOUNT_ORB_MAX_REPLY_BYTES,
        );
        if (text === undefined)
          throw new AccountOrbUnavailable(
            502,
            `The account Orb Worker's reply is larger than ${ACCOUNT_ORB_MAX_REPLY_BYTES} bytes.`,
          );
        const body = parseReply(text);
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

/** `/health` answers a few fields. */
const MAX_HEALTH_REPLY_BYTES = 64 * 1024;

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
  const text = await readBoundedText(response, MAX_HEALTH_REPLY_BYTES);
  const body = text === undefined ? undefined : parseReply(text);
  return response.ok && body?.recipe === input.recipe;
};
