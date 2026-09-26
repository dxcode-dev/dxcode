import { Schema } from "effect";
import { PageCursor } from "./cursor.js";

export const PageLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 100 }),
);

export type PageLimit = typeof PageLimit.Type;

export const PageRequest = Schema.Struct({
  limit: Schema.optional(PageLimit),
  cursor: Schema.optional(PageCursor),
});

export type PageRequest = typeof PageRequest.Type;

export const Page = <S extends Schema.Top>(item: S) =>
  Schema.Struct({
    items: Schema.Array(item),
    nextCursor: Schema.optional(PageCursor),
  });

export interface Page<T> {
  readonly items: ReadonlyArray<T>;
  readonly nextCursor?: PageCursor;
}
