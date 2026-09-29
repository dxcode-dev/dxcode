import { Schema } from "effect";

export class CopilotError extends Schema.TaggedError<CopilotError>()(
  "CopilotError",
  { code: Schema.String, status: Schema.optional(Schema.Int) },
) {
  // Worker exception logs otherwise show "[object Object]" and lose the code.
  override get message() {
    return this.status === undefined
      ? `Copilot request failed: ${this.code}`
      : `Copilot request failed: ${this.code} (HTTP ${this.status})`;
  }
}
