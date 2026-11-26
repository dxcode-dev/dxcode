import { ThreadId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint, FileAnswerSchema } from "../http/endpoint.js";
import { NotFoundResponseSchema } from "../http/not-found-response.js";
import {
  GetThreadDesktopResponseSchema,
  GetThreadDesktopWindowsResponseSchema,
  ThreadDesktopMachineOwnerOnlyResponseSchema,
  ThreadDesktopReadOnlyResponseSchema,
  ThreadDesktopRunnerOwnerOnlyResponseSchema,
  ThreadDesktopSettingsInvalidResponseSchema,
  ThreadDesktopSettingsRequestSchema,
  ThreadDesktopSettingsResponseSchema,
  ThreadDesktopWindowsActionInvalidResponseSchema,
  ThreadDesktopWindowsActionSchema,
} from "./desktop.js";
import {
  ThreadAccessRefusals,
  ThreadActiveRefusals,
} from "./thread-access-refusals.js";

/** The Desktop endpoints, apart from `desktop.ts`'s schemas. */

export const ThreadDesktopParamsSchema = Schema.Struct({ threadId: ThreadId });
export const ThreadDesktopChannelParamsSchema = Schema.Struct({
  threadId: ThreadId,
  channel: Schema.Literal("ws"),
});

/** What every Desktop route refuses before its own checks. */
const desktopRefusals = [
  ...ThreadAccessRefusals,
  ...ThreadActiveRefusals,
  { status: 403, schema: ThreadDesktopRunnerOwnerOnlyResponseSchema },
  { status: 403, schema: ThreadDesktopMachineOwnerOnlyResponseSchema },
  { status: 403, schema: ThreadDesktopReadOnlyResponseSchema },
] as const;

export const GetThreadDesktopEndpoint = defineEndpoint({
  id: "threads.desktop.get",
  summary: "Whether the Thread's Desktop can stream; starts it",
  method: "GET",
  path: "/v1/threads/:threadId/desktop",
  params: ThreadDesktopParamsSchema,
  success: GetThreadDesktopResponseSchema,
  refusals: desktopRefusals,
});

export const ListThreadDesktopWindowsEndpoint = defineEndpoint({
  id: "threads.desktop.windows",
  summary: "List the Desktop's open windows",
  method: "GET",
  path: "/v1/threads/:threadId/desktop/windows",
  params: ThreadDesktopParamsSchema,
  success: GetThreadDesktopWindowsResponseSchema,
  refusals: desktopRefusals,
});

export const ActOnThreadDesktopWindowsEndpoint = defineEndpoint({
  id: "threads.desktop.windowsAction",
  summary: "Bring a Desktop app or window to the front",
  method: "POST",
  path: "/v1/threads/:threadId/desktop/windows",
  params: ThreadDesktopParamsSchema,
  body: ThreadDesktopWindowsActionSchema,
  success: GetThreadDesktopWindowsResponseSchema,
  refusals: [
    ...desktopRefusals,
    { status: 400, schema: ThreadDesktopWindowsActionInvalidResponseSchema },
  ],
});

/** A Mac runner's Desktop only; any other Thread answers 404. */
export const OpenThreadDesktopSettingsEndpoint = defineEndpoint({
  id: "threads.desktop.openSettings",
  summary: "Open a System Settings pane on a Mac runner's Desktop",
  method: "POST",
  path: "/v1/threads/:threadId/desktop/settings",
  params: ThreadDesktopParamsSchema,
  body: ThreadDesktopSettingsRequestSchema,
  success: ThreadDesktopSettingsResponseSchema,
  refusals: [
    ...desktopRefusals,
    { status: 400, schema: ThreadDesktopSettingsInvalidResponseSchema },
    { status: 404, schema: NotFoundResponseSchema },
  ],
});

/**
 * The Desktop's WebSocket, which Core relays to voxl. A client opens it at
 * `endpointPath`; it is never `call`ed.
 */
export const ThreadDesktopSocketEndpoint = defineEndpoint({
  id: "threads.desktop.socket",
  summary: "The Desktop's live session (WebSocket)",
  method: "GET",
  path: "/v1/threads/:threadId/desktop/:channel",
  params: ThreadDesktopChannelParamsSchema,
  success: FileAnswerSchema,
  answer: "file",
  refusals: [
    ...desktopRefusals,
    { status: 404, schema: NotFoundResponseSchema },
  ],
});
