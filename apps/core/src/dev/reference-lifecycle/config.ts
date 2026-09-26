import {
  Config,
  ConfigProvider,
  Effect,
  Option,
  type Redacted,
  Schema,
} from "effect";
import { ProjectId, ProjectNameInput } from "@dx/domain";

export class ReferenceLifecycleConfigurationError extends Schema.TaggedError<ReferenceLifecycleConfigurationError>()(
  "ReferenceLifecycleConfigurationError",
  {},
) {}

export type ReferenceProject =
  | { readonly kind: "create"; readonly name: ProjectNameInput }
  | { readonly kind: "existing"; readonly id: ProjectId };

export interface ReferenceLifecycleConfig {
  readonly baseUrl: URL;
  readonly apiToken: Redacted.Redacted<string>;
  readonly project: ReferenceProject;
}

const configuration = Config.all({
  baseUrl: Config.string("DX_BASE_URL"),
  apiToken: Config.redacted("DX_TEMP_API_TOKEN"),
  projectName: Config.option(Config.string("DX_REFERENCE_PROJECT_NAME")),
  projectId: Config.option(Config.string("DX_REFERENCE_PROJECT_ID")),
});

const decodeBaseUrl = Effect.fn("decodeReferenceBaseUrl")(function* (
  value: string,
) {
  const url = yield* Effect.try({
    try: () => new URL(value),
    catch: () => new ReferenceLifecycleConfigurationError(),
  });
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== "/"
  ) {
    return yield* new ReferenceLifecycleConfigurationError();
  }
  return url;
});

export const loadReferenceLifecycleConfig = Effect.fn(
  "loadReferenceLifecycleConfig",
)(
  function* (environment: Record<string, string | undefined>) {
    const parsed = yield* configuration.parse(
      ConfigProvider.fromUnknown(environment),
    );
    const baseUrl = yield* decodeBaseUrl(parsed.baseUrl);

    let project: ReferenceProject;
    if (Option.isSome(parsed.projectName) && Option.isNone(parsed.projectId)) {
      project = {
        kind: "create",
        name: yield* Schema.decodeEffect(ProjectNameInput)(
          parsed.projectName.value,
        ),
      };
    } else if (
      Option.isSome(parsed.projectId) &&
      Option.isNone(parsed.projectName)
    ) {
      project = {
        kind: "existing",
        id: yield* Schema.decodeEffect(ProjectId)(parsed.projectId.value),
      };
    } else {
      return yield* new ReferenceLifecycleConfigurationError();
    }

    return {
      baseUrl,
      apiToken: parsed.apiToken,
      project,
    } satisfies ReferenceLifecycleConfig;
  },
  Effect.mapError(() => new ReferenceLifecycleConfigurationError()),
);
