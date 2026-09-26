import { Schema } from "effect";

export const Timestamp = Schema.DateTimeUtcFromString;

export type Timestamp = typeof Timestamp.Type;
