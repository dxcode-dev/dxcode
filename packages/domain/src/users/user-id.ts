import { Schema } from "effect";

export const UserId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/UserId"));

export type UserId = typeof UserId.Type;
