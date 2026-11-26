import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  HuddleErrorResponseSchema,
  HuddleJoinResponseSchema,
  HuddleLinkResponseSchema,
  HuddleLinkTargetResponseSchema,
  HuddleSummaryResponseSchema,
} from "./huddle.js";
import { ThreadAccessRefusals } from "./thread-access-refusals.js";

/** The huddle endpoints, apart from `huddle.ts`'s schemas. */

/** A Thread's huddle; a Space's is its own Thread's, by the Space's ID. */
/** One union of codes, each sent with its own status. */
const huddleRefusals = ([403, 404, 409, 502] as const).map((status) => ({
  status,
  schema: HuddleErrorResponseSchema,
}));

export const HuddleParamsSchema = Schema.Struct({ threadId: ThreadId });
export const HuddleLinkTargetParamsSchema = Schema.Struct({
  workspace: Schema.String,
  code: Schema.String,
});

export const GetHuddleSummaryEndpoint = defineEndpoint({
  id: "huddles.summary",
  summary: "Who is in the Thread's huddle",
  method: "GET",
  path: "/v1/threads/:threadId/huddle",
  params: HuddleParamsSchema,
  success: HuddleSummaryResponseSchema,
  refusals: [...ThreadAccessRefusals, ...huddleRefusals],
});

export const JoinHuddleEndpoint = defineEndpoint({
  id: "huddles.join",
  summary: "Join the Thread's huddle",
  method: "POST",
  path: "/v1/threads/:threadId/huddle/join",
  params: HuddleParamsSchema,
  success: HuddleJoinResponseSchema,
  refusals: [...ThreadAccessRefusals, ...huddleRefusals],
});

export const CreateHuddleLinkEndpoint = defineEndpoint({
  id: "huddles.link",
  summary: "The huddle's short link",
  method: "POST",
  path: "/v1/threads/:threadId/huddle/link",
  params: HuddleParamsSchema,
  success: HuddleLinkResponseSchema,
  refusals: [...ThreadAccessRefusals, ...huddleRefusals],
});

export const GetHuddleLinkTargetEndpoint = defineEndpoint({
  id: "huddles.linkTarget",
  summary: "Where a huddle link leads",
  method: "GET",
  path: "/v1/huddle-links/:workspace/:code",
  params: HuddleLinkTargetParamsSchema,
  success: HuddleLinkTargetResponseSchema,
  refusals: huddleRefusals,
});
