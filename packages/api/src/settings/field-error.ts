import { Schema } from "effect";

export const SettingsFieldErrorSchema = Schema.Struct({
  field: Schema.String,
  message: Schema.String,
});

export type SettingsFieldError = typeof SettingsFieldErrorSchema.Type;
