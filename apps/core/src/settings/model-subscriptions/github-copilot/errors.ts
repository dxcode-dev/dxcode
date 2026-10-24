import { Schema } from "effect";

export class CopilotError extends Schema.TaggedError<CopilotError>()(
  "CopilotError",
  { code: Schema.String, status: Schema.optional(Schema.Int) },
) {
  /**
   * Bounded upstream error body with the access token redacted, for the
   * coordinator's rejection log and failure classification. Not enumerable,
   * so a serialized error stays free of provider text.
   */
  declare readonly upstreamBody?: string;

  withUpstreamBody(body: string) {
    Object.defineProperty(this, "upstreamBody", {
      value: body,
      enumerable: false,
    });
    return this;
  }

  // Worker exception logs otherwise show "[object Object]" and lose the code.
  override get message() {
    return this.status === undefined
      ? `Copilot request failed: ${this.code}`
      : `Copilot request failed: ${this.code} (HTTP ${this.status})`;
  }
}
