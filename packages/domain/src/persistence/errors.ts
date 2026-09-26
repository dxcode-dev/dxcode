import { Schema } from "effect";

export class ProjectNotFound extends Schema.TaggedError<ProjectNotFound>()(
  "ProjectNotFound",
  { projectId: Schema.String },
) {}

export class ProjectNameConflict extends Schema.TaggedError<ProjectNameConflict>()(
  "ProjectNameConflict",
  {},
) {}

export class ThreadNotFound extends Schema.TaggedError<ThreadNotFound>()(
  "ThreadNotFound",
  { threadId: Schema.String },
) {}

export class InvalidPageCursor extends Schema.TaggedError<InvalidPageCursor>()(
  "InvalidPageCursor",
  {},
) {}

export class PersistenceUnavailable extends Schema.TaggedError<PersistenceUnavailable>()(
  "PersistenceUnavailable",
  { operation: Schema.String },
) {
  declare readonly cause?: unknown;

  static new(
    props: { readonly operation: string },
    cause: unknown,
  ): PersistenceUnavailable {
    const error = new this(props);
    Object.defineProperty(error, "cause", {
      configurable: false,
      enumerable: false,
      value: cause,
      writable: false,
    });
    return error;
  }
}
