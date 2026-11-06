import type { ThreadId } from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { threadPersistenceLogger } from "../logging.js";

/**
 * Wakes a new Thread's own Durable Objects while `POST /v1/threads` is
 * still persisting it (#1793).
 *
 * The first turn reaches two objects per Thread: its BYOK credential
 * coordinator (model routing) and its execution object (the Orb's restart
 * note). Each was brand new, so each paid its cold start, 0.4–1.4 s from
 * Asia, on the first message's path. Creation now sends each a `GET /warm`
 * once every check has passed. The route answers 204 before anything else
 * runs: it writes no storage, sets no alarm, and starts nothing. An object
 * woken for a Thread that then fails to persist holds no state and is
 * evicted when idle.
 *
 * The Thread's agent object is not woken here: constructing it creates its
 * storage schema, so it still starts only when its first message is
 * dispatched.
 */

export const WARM_PATH = "/warm";

/** The answer to `GET /warm`, before any other work of the object. */
export const warmResponse = () => new Response(null, { status: 204 });

export type InitialThreadObjectsWarmer = (
  bindings: Pick<Bindings, "BYOK_CREDENTIAL_COORDINATOR" | "THREAD_EXECUTION">,
  threadId: ThreadId,
) => Promise<void>;

const wake = async (
  namespace: DurableObjectNamespace,
  name: string,
  object: "byok_coordinator" | "thread_execution",
  threadId: ThreadId,
) => {
  try {
    const response = await namespace
      .get(namespace.idFromName(name))
      .fetch(`https://dx-warm.invalid${WARM_PATH}`);
    await response.body?.cancel();
  } catch (cause) {
    threadPersistenceLogger.warn("A new Thread's object did not wake early.", {
      event: "thread_initial_object_warm_failed",
      threadId,
      object,
      code: cause instanceof Error ? cause.name : "UNKNOWN",
    });
  }
};

/** Best effort: never rejects, and the response never waits for it. */
export const warmInitialThreadObjects: InitialThreadObjectsWarmer = async (
  bindings,
  threadId,
) => {
  await Promise.all([
    bindings.BYOK_CREDENTIAL_COORDINATOR === undefined
      ? undefined
      : wake(
          bindings.BYOK_CREDENTIAL_COORDINATOR,
          `byok-${threadId}`,
          "byok_coordinator",
          threadId,
        ),
    bindings.THREAD_EXECUTION === undefined
      ? undefined
      : wake(bindings.THREAD_EXECUTION, threadId, "thread_execution", threadId),
  ]);
};
