import { GetHuddleSummaryEndpoint } from "@dx/api";
import { dxClient } from "../../shared/api/client.js";
import { type HuddleScope, huddleThreadId } from "./huddle-client.js";

/** `GET /v1/threads/:id/huddle`: who is in a Thread's or Space's huddle. */
export const getHuddleSummary = async (
  scope: HuddleScope,
  signal?: AbortSignal,
) =>
  (
    await dxClient.call(
      GetHuddleSummaryEndpoint,
      { params: { threadId: huddleThreadId(scope) } },
      { ...(signal === undefined ? {} : { signal }) },
    )
  ).data;
