import {
  GetPersonalAccountResponseSchema,
  GetPersonalComposerDefaultsResponseSchema,
  PersonalAccountForbiddenResponseSchema,
  PersonalAccountInvalidRequestResponseSchema,
  PersonalAccountNotFoundResponseSchema,
  PersonalAccountPersistenceUnavailableResponseSchema,
  PersonalAccountUsernameUnavailableResponseSchema,
  type SettingsFieldError,
  UpdatePersonalAccountRequestSchema,
  UpdatePersonalAccountResponseSchema,
  UpdatePersonalAppearanceRequestSchema,
  UpdatePersonalAppearanceResponseSchema,
  UpdatePersonalComposerDefaultsRequestSchema,
  UpdatePersonalComposerDefaultsResponseSchema,
} from "@dx/api";
import {
  normalizePersonalAccountDisplayName,
  normalizePersonalAccountUsername,
  PersonalAccountDisplayName,
  PersonalAccountUsername,
  PersonalAppearance,
  PersonalPalette,
  PersonalTerminalTheme,
  type UpdatePersonalAccountInput,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Match, Option, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import { decodeJsonBody } from "../../http/request-decoding.js";
import type { AppEnv } from "../../http/types.js";
import { authorizationLogger } from "../../logging.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { SettingsAudit } from "../audit.js";
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import { PersonalAccountRepositoryD1 } from "./repository-d1.js";
import { PersonalAccountService } from "./service.js";

const ProfileFieldError = Schema.Struct({
  field: Schema.String,
  message: Schema.String,
});

class InvalidPersonalAccountRequest extends Schema.TaggedError<InvalidPersonalAccountRequest>()(
  "InvalidPersonalAccountRequest",
  { fieldErrors: Schema.Array(ProfileFieldError) },
) {}

const invalidAppearanceRequest = (input?: unknown) => {
  const message = "Choose a supported appearance and color palette.";
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return new InvalidPersonalAccountRequest({
      fieldErrors: [{ field: "request", message }],
    });

  const record = input as Record<string, unknown>;
  const fieldErrors = [
    ...(Object.hasOwn(record, "appearance") &&
    Option.isNone(
      Schema.decodeUnknownOption(PersonalAppearance)(record.appearance),
    )
      ? [{ field: "appearance", message }]
      : []),
    ...(Object.hasOwn(record, "palette") &&
    Option.isNone(Schema.decodeUnknownOption(PersonalPalette)(record.palette))
      ? [{ field: "palette", message }]
      : []),
    ...(Object.hasOwn(record, "terminalTheme") &&
    Option.isNone(
      Schema.decodeUnknownOption(PersonalTerminalTheme)(record.terminalTheme),
    )
      ? [{ field: "terminalTheme", message }]
      : []),
  ];
  return new InvalidPersonalAccountRequest({
    fieldErrors:
      fieldErrors.length > 0 ? fieldErrors : [{ field: "request", message }],
  });
};

const responseData = (account: {
  readonly displayName: string;
  readonly username: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly identityAuthority:
    | "local-password"
    | "cloudflare-access"
    | "external";
  readonly threadCount: number;
  readonly appearance: "system" | "light" | "dark";
  readonly palette: "daydream" | "deadpan";
  readonly terminalTheme: PersonalTerminalTheme;
}) => ({
  displayName: account.displayName,
  username: account.username,
  email: account.email,
  emailVerified: account.emailVerified,
  identityAuthority: account.identityAuthority,
  threadCount: account.threadCount,
  appearance: account.appearance,
  palette: account.palette,
  terminalTheme: account.terminalTheme,
});

const validateUpdate = (
  input: typeof UpdatePersonalAccountRequestSchema.Type,
): Effect.Effect<UpdatePersonalAccountInput, InvalidPersonalAccountRequest> => {
  const displayName = Schema.decodeOption(PersonalAccountDisplayName)(
    normalizePersonalAccountDisplayName(input.displayName),
  );
  const username = Schema.decodeOption(PersonalAccountUsername)(
    normalizePersonalAccountUsername(input.username),
  );
  const fieldErrors: Array<SettingsFieldError> = [];
  if (Option.isNone(displayName)) {
    fieldErrors.push({
      field: "displayName",
      message: "Enter a display name between 1 and 128 characters.",
    });
  }
  if (Option.isNone(username)) {
    fieldErrors.push({
      field: "username",
      message:
        "Use 3–32 lowercase letters, numbers, or hyphens, starting and ending with a letter or number.",
    });
  }
  return Option.isSome(displayName) && Option.isSome(username)
    ? Effect.succeed({
        displayName: displayName.value,
        username: username.value,
      })
    : Effect.fail(new InvalidPersonalAccountRequest({ fieldErrors }));
};

const servicesFor = (db: D1Database) => {
  const repositories = Layer.merge(
    WorkspaceRepositoryD1(db),
    PersonalAccountRepositoryD1,
  ).pipe(Layer.provide(D1Client.layer({ db })));
  return Layer.merge(
    SettingsService.layer.pipe(Layer.provide(repositories)),
    PersonalAccountService.layer.pipe(
      Layer.provide(Layer.merge(repositories, SettingsAudit.layer)),
    ),
  );
};

const auditInvalidUpdate = (
  context: Context<AppEnv>,
  fieldErrors: ReadonlyArray<SettingsFieldError>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const audit = yield* SettingsAudit;
      yield* audit.record({
        action: "personal_account.update",
        scope: "personal",
        outcome: "rejected",
        requestId: context.get("requestId"),
        userId: context.get("principal").userId,
        fields: fieldErrors.flatMap(({ field }) =>
          field === "displayName" || field === "username" ? [field] : [],
        ),
      });
    }).pipe(Effect.provide(SettingsAudit.layer)),
  );

const auditInvalidAppearanceUpdate = (
  context: Context<AppEnv>,
  fieldErrors: ReadonlyArray<SettingsFieldError>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const audit = yield* SettingsAudit;
      yield* audit.record({
        action: "personal_appearance.update",
        scope: "personal",
        outcome: "rejected",
        requestId: context.get("requestId"),
        userId: context.get("principal").userId,
        fields: fieldErrors.flatMap(({ field }) =>
          field === "appearance" ||
          field === "palette" ||
          field === "terminalTheme"
            ? [field]
            : [],
        ),
      });
    }).pipe(Effect.provide(SettingsAudit.layer)),
  );

const forbidden = (context: Context<AppEnv>) => {
  authorizationLogger.warn("Personal account authorization failed.", {
    event: "personal_account_authorization_failed",
    requestId: context.get("requestId"),
  });
  return context.json(
    Schema.encodeUnknownSync(PersonalAccountForbiddenResponseSchema)({
      status: "error",
      data: {
        code: "SETTINGS_SCOPE_FORBIDDEN",
        message: "The settings scope is unavailable for this user.",
        requestId: context.get("requestId"),
      },
    }),
    403,
  );
};

const notFound = (context: Context<AppEnv>) =>
  context.json(
    Schema.encodeUnknownSync(PersonalAccountNotFoundResponseSchema)({
      status: "error",
      data: {
        code: "PERSONAL_ACCOUNT_NOT_FOUND",
        message: "Personal account not found.",
        requestId: context.get("requestId"),
      },
    }),
    404,
  );

const unavailable = (context: Context<AppEnv>) =>
  context.json(
    Schema.encodeUnknownSync(
      PersonalAccountPersistenceUnavailableResponseSchema,
    )({
      status: "error",
      data: {
        code: "PERSISTENCE_UNAVAILABLE",
        message: "Settings are temporarily unavailable.",
        requestId: context.get("requestId"),
      },
    }),
    503,
  );

export const personalAccountRoutes = new Hono<AppEnv>();

personalAccountRoutes.get("/", async (context) => {
  const operation = Effect.gen(function* () {
    const db = yield* decodeD1Binding(context.env.DB);
    return yield* Effect.gen(function* () {
      const settings = yield* SettingsService;
      yield* settings.personal(context.get("principal"));
      const accounts = yield* PersonalAccountService;
      const account = yield* accounts.get(context.get("principal"));
      return yield* Schema.encodeUnknownEffect(
        GetPersonalAccountResponseSchema,
      )({
        status: "success",
        data: responseData(account),
      });
    }).pipe(Effect.provide(servicesFor(db)));
  });

  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) return context.json(result.success, 200);
  return Match.value(result.failure).pipe(
    Match.tags({
      SettingsScopeForbidden: () => forbidden(context),
      PersonalAccountNotFound: () => notFound(context),
      PersistenceUnavailable: () => unavailable(context),
      SettingsMembershipInvariantViolation: (error) => {
        throw error;
      },
      D1BindingUnavailable: (error) => {
        throw error;
      },
      ConfigError: (error) => {
        throw error;
      },
      SchemaError: (error) => {
        throw error;
      },
    }),
    Match.exhaustive,
  );
});

personalAccountRoutes.patch("/appearance", async (context) => {
  const requestId = context.get("requestId");
  const operation = Effect.gen(function* () {
    const input = yield* decodeJsonBody(
      context.req,
      UpdatePersonalAppearanceRequestSchema,
      invalidAppearanceRequest,
    );
    const db = yield* decodeD1Binding(context.env.DB);
    return yield* Effect.gen(function* () {
      const settings = yield* SettingsService;
      yield* settings.personal(context.get("principal"));
      const accounts = yield* PersonalAccountService;
      const account = yield* accounts.updateAppearance(
        context.get("principal"),
        input,
        requestId,
      );
      return yield* Schema.encodeUnknownEffect(
        UpdatePersonalAppearanceResponseSchema,
      )({ status: "success", data: responseData(account) });
    }).pipe(Effect.provide(servicesFor(db)));
  }).pipe(
    Effect.tapErrorTag("InvalidPersonalAccountRequest", (error) =>
      Effect.promise(() =>
        auditInvalidAppearanceUpdate(context, error.fieldErrors),
      ),
    ),
  );

  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) return context.json(result.success, 200);
  return Match.value(result.failure).pipe(
    Match.tags({
      InvalidPersonalAccountRequest: (error) =>
        context.json(
          Schema.encodeUnknownSync(PersonalAccountInvalidRequestResponseSchema)(
            {
              status: "error",
              data: {
                code: "INVALID_ACCOUNT_PROFILE",
                message: "Account profile validation failed.",
                requestId,
                fieldErrors: error.fieldErrors,
              },
            },
          ),
          400,
        ),
      SettingsScopeForbidden: () => forbidden(context),
      PersonalAccountNotFound: () => notFound(context),
      PersistenceUnavailable: () => unavailable(context),
      SettingsMembershipInvariantViolation: (error) => {
        throw error;
      },
      D1BindingUnavailable: (error) => {
        throw error;
      },
      ConfigError: (error) => {
        throw error;
      },
      SchemaError: (error) => {
        throw error;
      },
    }),
    Match.exhaustive,
  );
});

personalAccountRoutes.patch("/", async (context) => {
  const requestId = context.get("requestId");
  const operation = Effect.gen(function* () {
    const raw = yield* decodeJsonBody(
      context.req,
      UpdatePersonalAccountRequestSchema,
      () =>
        new InvalidPersonalAccountRequest({
          fieldErrors: [
            {
              field: "request",
              message: "Only displayName and username can be changed.",
            },
          ],
        }),
    );
    const input = yield* validateUpdate(raw);
    const db = yield* decodeD1Binding(context.env.DB);
    return yield* Effect.gen(function* () {
      const settings = yield* SettingsService;
      yield* settings.personal(context.get("principal"));
      const accounts = yield* PersonalAccountService;
      const account = yield* accounts.update(
        context.get("principal"),
        input,
        requestId,
      );
      return yield* Schema.encodeUnknownEffect(
        UpdatePersonalAccountResponseSchema,
      )({ status: "success", data: responseData(account) });
    }).pipe(Effect.provide(servicesFor(db)));
  }).pipe(
    Effect.tapErrorTag("InvalidPersonalAccountRequest", (error) =>
      Effect.promise(() => auditInvalidUpdate(context, error.fieldErrors)),
    ),
  );

  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) return context.json(result.success, 200);
  return Match.value(result.failure).pipe(
    Match.tags({
      InvalidPersonalAccountRequest: (error) =>
        context.json(
          Schema.encodeUnknownSync(PersonalAccountInvalidRequestResponseSchema)(
            {
              status: "error",
              data: {
                code: "INVALID_ACCOUNT_PROFILE",
                message: "Account profile validation failed.",
                requestId,
                fieldErrors: error.fieldErrors,
              },
            },
          ),
          400,
        ),
      PersonalAccountUsernameUnavailable: () =>
        context.json(
          Schema.encodeUnknownSync(
            PersonalAccountUsernameUnavailableResponseSchema,
          )({
            status: "error",
            data: {
              code: "USERNAME_UNAVAILABLE",
              message: "That username is already in use.",
              requestId,
              fieldErrors: [
                {
                  field: "username",
                  message: "Choose a different username.",
                },
              ],
            },
          }),
          409,
        ),
      SettingsScopeForbidden: () => forbidden(context),
      PersonalAccountNotFound: () => notFound(context),
      PersistenceUnavailable: () => unavailable(context),
      SettingsMembershipInvariantViolation: (error) => {
        throw error;
      },
      D1BindingUnavailable: (error) => {
        throw error;
      },
      ConfigError: (error) => {
        throw error;
      },
      SchemaError: (error) => {
        throw error;
      },
    }),
    Match.exhaustive,
  );
});

const invalidComposerDefaultsRequest = () =>
  new InvalidPersonalAccountRequest({
    fieldErrors: [
      {
        field: "request",
        message: "Choose a supported Project, mode, model, and Orb.",
      },
    ],
  });

personalAccountRoutes.get("/composer", async (context) => {
  const operation = Effect.gen(function* () {
    const db = yield* decodeD1Binding(context.env.DB);
    return yield* Effect.gen(function* () {
      const settings = yield* SettingsService;
      yield* settings.personal(context.get("principal"));
      const accounts = yield* PersonalAccountService;
      const defaults = yield* accounts.getComposerDefaults(
        context.get("principal"),
      );
      return yield* Schema.encodeUnknownEffect(
        GetPersonalComposerDefaultsResponseSchema,
      )({ status: "success", data: defaults });
    }).pipe(Effect.provide(servicesFor(db)));
  });

  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) return context.json(result.success, 200);
  return Match.value(result.failure).pipe(
    Match.tags({
      SettingsScopeForbidden: () => forbidden(context),
      PersonalAccountNotFound: () => notFound(context),
      PersistenceUnavailable: () => unavailable(context),
      SettingsMembershipInvariantViolation: (error) => {
        throw error;
      },
      D1BindingUnavailable: (error) => {
        throw error;
      },
      ConfigError: (error) => {
        throw error;
      },
      SchemaError: (error) => {
        throw error;
      },
    }),
    Match.exhaustive,
  );
});

personalAccountRoutes.patch("/composer", async (context) => {
  const requestId = context.get("requestId");
  const operation = Effect.gen(function* () {
    const input = yield* decodeJsonBody(
      context.req,
      UpdatePersonalComposerDefaultsRequestSchema,
      invalidComposerDefaultsRequest,
    );
    const db = yield* decodeD1Binding(context.env.DB);
    return yield* Effect.gen(function* () {
      const settings = yield* SettingsService;
      yield* settings.personal(context.get("principal"));
      const accounts = yield* PersonalAccountService;
      const defaults = yield* accounts.updateComposerDefaults(
        context.get("principal"),
        input,
      );
      return yield* Schema.encodeUnknownEffect(
        UpdatePersonalComposerDefaultsResponseSchema,
      )({ status: "success", data: defaults });
    }).pipe(Effect.provide(servicesFor(db)));
  });

  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) return context.json(result.success, 200);
  return Match.value(result.failure).pipe(
    Match.tags({
      InvalidPersonalAccountRequest: (error) =>
        context.json(
          Schema.encodeUnknownSync(PersonalAccountInvalidRequestResponseSchema)(
            {
              status: "error",
              data: {
                code: "INVALID_ACCOUNT_PROFILE",
                message: "Account profile validation failed.",
                requestId,
                fieldErrors: error.fieldErrors,
              },
            },
          ),
          400,
        ),
      SettingsScopeForbidden: () => forbidden(context),
      PersonalAccountNotFound: () => notFound(context),
      PersistenceUnavailable: () => unavailable(context),
      SettingsMembershipInvariantViolation: (error) => {
        throw error;
      },
      D1BindingUnavailable: (error) => {
        throw error;
      },
      ConfigError: (error) => {
        throw error;
      },
      SchemaError: (error) => {
        throw error;
      },
    }),
    Match.exhaustive,
  );
});
