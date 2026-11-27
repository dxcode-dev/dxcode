import { TranscriptUpdatesEndpoint } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { dxClient } from "../../shared/api/client.js";

/**
 * Opens the Thread's transcript updates stream (`server-transcript`
 * experimental feature); `readEventStream` from `@dx/client` reads it.
 */
export const openTranscriptUpdates = (
  threadId: ThreadId,
  signal: AbortSignal,
) =>
  dxClient.call(
    TranscriptUpdatesEndpoint,
    { params: { threadId }, query: {} },
    { signal },
  );
