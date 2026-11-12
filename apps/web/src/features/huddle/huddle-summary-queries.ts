import {
  HuddleErrorResponseSchema,
  HuddleSummaryResponseSchema,
} from "@dx/api";
import { request } from "../../shared/api/client.js";
import { type HuddleScope, huddleThreadId } from "./huddle-client.js";

/** `GET /v1/threads/:id/huddle`: who is in a Thread's or Space's huddle. */
export const getHuddleSummary = async (
  scope: HuddleScope,
  signal?: AbortSignal,
) =>
  (
    await request(
      `/v1/threads/${encodeURIComponent(huddleThreadId(scope))}/huddle`,
      HuddleSummaryResponseSchema,
      { signal },
      HuddleErrorResponseSchema,
    )
  ).data;
