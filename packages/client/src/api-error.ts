import type { SettingsFieldError } from "@dx/api";

/** A dx endpoint answered with an error, or with nothing a client can read. */
export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly currentRevision?: number;
  readonly fieldErrors?: ReadonlyArray<SettingsFieldError>;
  /** The answer matched one of the endpoint's declared error schemas. */
  readonly hasValidatedPayload: boolean;
  /** The decoded error's own fields, for a caller that offers a next step. */
  readonly data?: Readonly<Record<string, unknown>>;

  constructor(
    status: number,
    message: string,
    code?: string,
    fieldErrors?: ReadonlyArray<SettingsFieldError>,
    currentRevision?: number,
    hasValidatedPayload = false,
    data?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
    this.currentRevision = currentRevision;
    this.hasValidatedPayload = hasValidatedPayload;
    if (data !== undefined) this.data = data;
  }
}

/**
 * The ApiError for a decoded error answer. A provider's own `detail` (Orb
 * credentials) says what to fix, so it wins over the generic message.
 */
export const apiErrorFromRefusal = (
  status: number,
  data: { readonly code: string; readonly message: string },
): ApiError => {
  const fields = data as Readonly<Record<string, unknown>>;
  return new ApiError(
    status,
    typeof fields.detail === "string" ? fields.detail : data.message,
    data.code,
    Array.isArray(fields.fieldErrors)
      ? (fields.fieldErrors as ReadonlyArray<SettingsFieldError>)
      : undefined,
    typeof fields.currentRevision === "number"
      ? fields.currentRevision
      : undefined,
    true,
    fields,
  );
};
