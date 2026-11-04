import { type ThreadQuickAction, ThreadQuickActionSchema } from "@dx/api";
import { Option, Schema } from "effect";

/**
 * Clef Flash's pick for one agent message, kept in this colo's cache, so a
 * reload or a second tab costs no Flue history read and no model call. An
 * agent message never changes, and what Clef is asked about it depends only
 * on that message and whether Snooze is a candidate, so an entry never goes
 * stale; it expires after a day. Keys hold the Thread, so an entry is found
 * only through a request `authorizeThread` already let into that Thread.
 * Only the route writes entries, under the message ID it read from Flue's
 * history and with the pick it made from that read: a client only names a
 * message to look up and sends no text, so one member cannot change what
 * another member of a shared Thread is shown.
 * Only usable answers are kept: a failed call is asked again next time.
 */
const CACHE_NAME = "dx-thread-quick-actions";
/** Bump when the candidates, rubric, or question change what Clef picks. */
const VERSION = "v1";
const TTL_SECONDS = 24 * 60 * 60;

const cacheUrl = (threadId: string, messageId: string, snooze: boolean) =>
  `https://quick-actions.cache.invalid/${VERSION}/${encodeURIComponent(threadId)}/${encodeURIComponent(messageId)}/${snooze ? "snooze" : "replies"}`;

const openCache = async () =>
  typeof caches === "undefined"
    ? undefined
    : await caches.open(CACHE_NAME).catch(() => undefined);

export const cachedQuickActions = async (
  threadId: string,
  messageId: string,
  snooze: boolean,
): Promise<ReadonlyArray<ThreadQuickAction> | undefined> => {
  try {
    const cached = await (await openCache())?.match(
      cacheUrl(threadId, messageId, snooze),
    );
    if (cached === undefined) return undefined;
    return Option.getOrUndefined(
      Schema.decodeUnknownOption(Schema.Array(ThreadQuickActionSchema))(
        await cached.json(),
      ),
    );
  } catch {
    return undefined;
  }
};

export const cacheQuickActions = async (
  threadId: string,
  messageId: string,
  snooze: boolean,
  actions: ReadonlyArray<ThreadQuickAction>,
) => {
  try {
    await (await openCache())?.put(
      cacheUrl(threadId, messageId, snooze),
      new Response(JSON.stringify(actions), {
        headers: {
          "content-type": "application/json",
          "cache-control": `public, max-age=${TTL_SECONDS}`,
        },
      }),
    );
  } catch {
    // A cache that cannot store only costs the next request a model call.
  }
};
