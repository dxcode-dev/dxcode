import { Schema } from "effect";

export const DeploymentIdentitySchema = Schema.Struct({
  label: Schema.String.check(
    Schema.isPattern(
      /^(?:Local|Branch preview · [^·]+ · [a-f0-9]{12}|Staging · [a-f0-9]{12})$/,
    ),
  ),
});

export class DeploymentIdentityParseError extends Error {
  readonly _tag = "DeploymentIdentityParseError";

  constructor(readonly cause: unknown) {
    super("Deployment identity is invalid.");
  }
}

export const decodeDeploymentIdentity = async (
  value: unknown,
): Promise<string> => {
  try {
    return (
      await Schema.decodeUnknownPromise(DeploymentIdentitySchema)(value, {
        onExcessProperty: "error",
      })
    ).label;
  } catch (cause) {
    throw new DeploymentIdentityParseError(cause);
  }
};
