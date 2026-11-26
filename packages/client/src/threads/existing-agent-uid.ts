import { FlueApiError } from "@flue/sdk";

export const existingAgentUid = (cause: unknown) => {
  if (!(cause instanceof FlueApiError) || cause.status !== 409)
    return undefined;
  const body = cause.body;
  if (typeof body !== "object" || body === null || !("error" in body))
    return undefined;
  const error = body.error;
  if (
    typeof error !== "object" ||
    error === null ||
    !("type" in error) ||
    error.type !== "agent_instance_exists" ||
    !("meta" in error) ||
    typeof error.meta !== "object" ||
    error.meta === null ||
    !("uid" in error.meta) ||
    typeof error.meta.uid !== "string"
  )
    return undefined;
  return error.meta.uid;
};
