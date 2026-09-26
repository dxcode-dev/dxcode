import { Schema } from "effect";

export class CopilotError extends Schema.TaggedError<CopilotError>()(
  "CopilotError",
  { code: Schema.String, status: Schema.optional(Schema.Int) },
) {}
