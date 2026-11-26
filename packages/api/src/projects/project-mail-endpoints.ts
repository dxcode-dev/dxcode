import { ProjectId } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  GetProjectMailResponseSchema,
  MailErrorResponseSchema,
} from "../mail/mail.js";

/** Project Settings → Email: the viewer's own address for the Project. */
export const GetProjectMailEndpoint = defineEndpoint({
  id: "projects.mail.get",
  summary: "Read the person's email address for a Project",
  method: "GET",
  path: "/v1/projects/:projectId/mail",
  params: Schema.Struct({ projectId: ProjectId }),
  success: GetProjectMailResponseSchema,
  refusals: [
    { status: 400, schema: MailErrorResponseSchema },
    { status: 404, schema: MailErrorResponseSchema },
  ],
});
