import { PageLimit } from "@dx/domain";
import { Schema } from "effect";

export const PageLimitQuerySchema = Schema.String.check(
  Schema.isPattern(/^[0-9]+$/),
).pipe(Schema.decodeTo(Schema.FiniteFromString), Schema.decodeTo(PageLimit));
