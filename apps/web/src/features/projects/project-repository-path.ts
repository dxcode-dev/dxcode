import { normalizeProjectRepositoryPath, ProjectRepositoryPath } from "@dx/api";
import { Option, Schema } from "effect";

/**
 * The Project page's `?path=`: a repository directory, or `undefined` for the
 * root, including when the value is not a safe directory path.
 */
export const projectRepositoryPathSearch = (value: unknown) => {
  if (typeof value !== "string") return undefined;
  const path = Schema.decodeUnknownOption(ProjectRepositoryPath)(
    normalizeProjectRepositoryPath(value),
  );
  return Option.isSome(path) && path.value !== "" ? path.value : undefined;
};
