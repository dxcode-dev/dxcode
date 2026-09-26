import {
  BrowserSessionNotFoundResponseSchema,
  BrowserSessionParamsSchema,
  CreatePersonalApiTokenRequestSchema,
  CreatePersonalApiTokenResponseSchema,
  CurrentBrowserSessionProtectedResponseSchema,
  GetPersonalSecurityResponseSchema,
  ListBrowserSessionsQuerySchema,
  ListBrowserSessionsResponseSchema,
  ListPersonalApiTokensResponseSchema,
  PersonalApiTokenNotFoundResponseSchema,
  PersonalApiTokenParamsSchema,
  PersonalSecurityBrowserSessionRequiredResponseSchema,
  PersonalSecurityInvalidRequestResponseSchema,
  PersonalSecurityPersistenceUnavailableResponseSchema,
  PersonalSecurityScopeForbiddenResponseSchema,
  RevokeBrowserSessionResponseSchema,
  RevokeOtherBrowserSessionsResponseSchema,
  RevokePersonalApiTokenResponseSchema,
  RotatePersonalApiTokenResponseSchema,
  type SettingsFieldError,
} from "@dx/api";
import {
  normalizePersonalApiTokenName,
  PersistenceUnavailable,
  PersonalApiToken,
  type PersonalApiTokenId,
  PersonalApiTokenName,
  PersonalApiTokenPlaintext,
  type PersonalApiTokenScope,
  PersonalApiTokenScopes,
  type Principal,
  type SecurityPageOffset,
  SettingsScopeForbidden,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { APIError } from "better-auth/api";
import { Effect, Layer, Option, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import { createAuth, type DxAuth } from "../../auth/better-auth.js";
import {
  BrowserSessionRequired,
  requireBrowserSession,
} from "../../auth/browser-session.js";
import { loadAuthenticationRequirements } from "../../auth/requirements.js";
import {
  decodeJsonBody,
  decodeRequestInput,
} from "../../http/request-decoding.js";
import type { AppEnv } from "../../http/types.js";
import { authorizationLogger } from "../../logging.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { SettingsAudit } from "../audit.js";
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import { PersonalSecurityRepositoryD1 } from "./repository-d1.js";
import {
  BrowserSessionNotFound,
  CurrentBrowserSessionProtected,
  PersonalSecurityService,
} from "./service.js";

const userKeyConfigId = "user-keys";

class InvalidPersonalSecurityRequest extends Schema.TaggedError<InvalidPersonalSecurityRequest>()(
  "InvalidPersonalSecurityRequest",
  {
    fieldErrors: Schema.Array(
      Schema.Struct({ field: Schema.String, message: Schema.String }),
    ),
  },
) {}

class PersonalApiTokenNotFound extends Schema.TaggedError<PersonalApiTokenNotFound>()(
  "PersonalApiTokenNotFound",
  {},
) {}

class SecurityProviderUnavailable extends Schema.TaggedError<SecurityProviderUnavailable>()(
  "SecurityProviderUnavailable",
  {},
) {}

const servicesFor = (db: D1Database) => {
  const workspaceRepository = WorkspaceRepositoryD1(db).pipe(
    Layer.provide(D1Client.layer({ db })),
  );
  const securityRepository = PersonalSecurityRepositoryD1(db);
  const settings = SettingsService.layer.pipe(
    Layer.provide(workspaceRepository),
  );
  const security = PersonalSecurityService.layer.pipe(
    Layer.provide(Layer.mergeAll(securityRepository, SettingsAudit.layer)),
  );
  return Layer.mergeAll(settings, security);
};

const decode = <S extends Schema.Constraint>(schema: S, input: unknown) =>
  decodeRequestInput(
    schema,
    input,
    () => new InvalidPersonalSecurityRequest({ fieldErrors: [] }),
  );

const securityError = (
  context: Context<AppEnv>,
  schema: Schema.ConstraintEncoder<unknown>,
  status: 400 | 401 | 403 | 404 | 409 | 503,
  code: string,
  message: string,
) =>
  context.json(
    Schema.encodeUnknownSync(schema)({
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    }),
    status,
  );

const failureResponse = (context: Context<AppEnv>, failure: unknown) => {
  if (failure instanceof InvalidPersonalSecurityRequest) {
    return context.json(
      Schema.encodeUnknownSync(PersonalSecurityInvalidRequestResponseSchema)({
        status: "error",
        data: {
          code: "INVALID_SECURITY_REQUEST",
          message: "Security request validation failed.",
          requestId: context.get("requestId"),
          fieldErrors: failure.fieldErrors,
        },
      }),
      400,
    );
  }
  if (failure instanceof SettingsScopeForbidden) {
    authorizationLogger.warn("Personal security scope authorization failed.", {
      event: "personal_security_scope_authorization_failed",
      requestId: context.get("requestId"),
    });
    return securityError(
      context,
      PersonalSecurityScopeForbiddenResponseSchema,
      403,
      "SETTINGS_SCOPE_FORBIDDEN",
      "The settings scope is unavailable for this user.",
    );
  }
  if (failure instanceof BrowserSessionRequired) {
    return securityError(
      context,
      PersonalSecurityBrowserSessionRequiredResponseSchema,
      403,
      "BROWSER_SESSION_REQUIRED",
      "A browser session is required to manage security settings.",
    );
  }
  if (failure instanceof PersonalApiTokenNotFound) {
    return securityError(
      context,
      PersonalApiTokenNotFoundResponseSchema,
      404,
      "PERSONAL_API_TOKEN_NOT_FOUND",
      "Personal API token not found.",
    );
  }
  if (failure instanceof BrowserSessionNotFound) {
    return securityError(
      context,
      BrowserSessionNotFoundResponseSchema,
      404,
      "BROWSER_SESSION_NOT_FOUND",
      "Browser session not found.",
    );
  }
  if (failure instanceof CurrentBrowserSessionProtected) {
    return securityError(
      context,
      CurrentBrowserSessionProtectedResponseSchema,
      409,
      "CURRENT_SESSION_PROTECTED",
      "The current browser session cannot be revoked from this control.",
    );
  }
  if (
    failure instanceof PersistenceUnavailable ||
    failure instanceof SecurityProviderUnavailable
  ) {
    return securityError(
      context,
      PersonalSecurityPersistenceUnavailableResponseSchema,
      503,
      "PERSISTENCE_UNAVAILABLE",
      "Security settings are temporarily unavailable.",
    );
  }
  throw failure;
};

const run = async <A, E>(
  context: Context<AppEnv>,
  operation: Effect.Effect<A, E>,
  status: 200 | 201 = 200,
) => {
  const result = await Effect.runPromise(Effect.result(operation));
  return Result.isSuccess(result)
    ? context.json(result.success, status)
    : failureResponse(context, result.failure);
};

const dependencies = Effect.fn("personalSecurityRouteDependencies")(function* (
  context: Context<AppEnv>,
) {
  const db = yield* decodeD1Binding(context.env.DB);
  const requirements = yield* loadAuthenticationRequirements(context.env);
  const auth = createAuth(context.env, requirements);
  const current = yield* requireBrowserSession(context, auth);
  return { db, auth, current };
});

const withSecurity = <A, E, R>(
  db: D1Database,
  effect: Effect.Effect<A, E, R | SettingsService | PersonalSecurityService>,
) => effect.pipe(Effect.provide(servicesFor(db)));

const authorizePersonal = (db: D1Database, principal: Principal) =>
  withSecurity(
    db,
    Effect.gen(function* () {
      const settings = yield* SettingsService;
      yield* settings.personal(principal);
    }),
  );

const audit = (
  db: D1Database,
  input: Parameters<
    (typeof PersonalSecurityService)["Service"]["auditMutation"]
  >[0],
) =>
  withSecurity(
    db,
    Effect.gen(function* () {
      const service = yield* PersonalSecurityService;
      yield* service.auditMutation(input);
    }),
  );

const provider = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: () => new SecurityProviderUnavailable(),
  });

interface ApiKeyMetadata {
  readonly id: string;
  readonly name: string | null;
  readonly start: string | null;
  readonly prefix: string | null;
  readonly permissions: unknown;
  readonly createdAt: Date;
  readonly lastRequest: Date | null;
}

const tokenData = (key: ApiKeyMetadata) =>
  Schema.decodeUnknownEffect(PersonalApiToken)({
    id: key.id,
    name: key.name,
    identifier: key.start ?? key.prefix ?? "dxu_",
    scopes: (key.permissions as { readonly dx?: unknown } | null)?.dx,
    createdAt: key.createdAt.toISOString(),
    ...(key.lastRequest === null
      ? {}
      : { lastUsedAt: key.lastRequest.toISOString() }),
  });

const fieldError = (field: string, message: string): SettingsFieldError => ({
  field,
  message,
});

const validatedTokenInput = (input: {
  readonly name: string;
  readonly scopes: ReadonlyArray<string>;
}) => {
  const name = Schema.decodeOption(PersonalApiTokenName)(
    normalizePersonalApiTokenName(input.name),
  );
  const scopes = Schema.decodeUnknownOption(PersonalApiTokenScopes)(
    input.scopes,
  );
  const fieldErrors: Array<SettingsFieldError> = [];
  if (Option.isNone(name)) {
    fieldErrors.push(
      fieldError("name", "Enter a token name between 1 and 64 characters."),
    );
  }
  if (Option.isNone(scopes)) {
    fieldErrors.push(
      fieldError("scopes", "Select one or more valid, distinct dx scopes."),
    );
  }
  return Option.isSome(name) && Option.isSome(scopes)
    ? Effect.succeed({ name: name.value, scopes: scopes.value })
    : Effect.fail(new InvalidPersonalSecurityRequest({ fieldErrors }));
};

const createToken = (
  auth: DxAuth,
  principal: Principal,
  name: string,
  scopes: ReadonlyArray<PersonalApiTokenScope>,
) =>
  Effect.gen(function* () {
    const created = yield* provider(() =>
      auth.api.createApiKey({
        body: {
          configId: userKeyConfigId,
          name,
          permissions: { dx: [...scopes] },
          userId: principal.userId,
        },
      }),
    );
    return {
      token: yield* tokenData(created),
      plaintext: yield* Schema.decodeUnknownEffect(PersonalApiTokenPlaintext)(
        created.key,
      ),
    };
  });

const tokenNotFound = (error: unknown) =>
  error instanceof APIError && error.status === "NOT_FOUND";

const ownedToken = (
  auth: DxAuth,
  headers: Headers,
  tokenId: PersonalApiTokenId,
) =>
  Effect.tryPromise({
    try: () =>
      auth.api.getApiKey({
        headers,
        query: { configId: userKeyConfigId, id: tokenId },
      }),
    catch: (error) =>
      tokenNotFound(error)
        ? new PersonalApiTokenNotFound()
        : new SecurityProviderUnavailable(),
  });

const deleteOwnedToken = (
  auth: DxAuth,
  headers: Headers,
  tokenId: PersonalApiTokenId,
) =>
  Effect.tryPromise({
    try: () =>
      auth.api.deleteApiKey({
        headers,
        body: { configId: userKeyConfigId, keyId: tokenId },
      }),
    catch: (error) =>
      tokenNotFound(error)
        ? new PersonalApiTokenNotFound()
        : new SecurityProviderUnavailable(),
  });

export const personalSecurityRoutes = new Hono<AppEnv>();

personalSecurityRoutes.get("/", async (context) => {
  const operation = Effect.gen(function* () {
    const { db } = yield* dependencies(context);
    const principal = context.get("principal");
    yield* authorizePersonal(db, principal);
    return yield* Schema.encodeUnknownEffect(GetPersonalSecurityResponseSchema)(
      {
        status: "success",
        data: {
          passkeys: {
            available: false,
            reason:
              "Passkeys are unavailable until the Better Auth WebAuthn plugin and a deterministic Worker ceremony are configured.",
          },
        },
      },
    );
  });
  return run(context, operation);
});

personalSecurityRoutes.get("/tokens", async (context) => {
  const operation = Effect.gen(function* () {
    const { db, auth } = yield* dependencies(context);
    yield* authorizePersonal(db, context.get("principal"));
    const result = yield* provider(() =>
      auth.api.listApiKeys({
        headers: context.req.raw.headers,
        query: {
          configId: userKeyConfigId,
          limit: 100,
          sortBy: "createdAt",
          sortDirection: "desc",
        },
      }),
    );
    const items = yield* Effect.all(result.apiKeys.map(tokenData));
    return yield* Schema.encodeUnknownEffect(
      ListPersonalApiTokensResponseSchema,
    )({ status: "success", data: { items } });
  });
  return run(context, operation);
});

personalSecurityRoutes.post("/tokens", async (context) => {
  const operation = Effect.gen(function* () {
    const body = yield* decodeJsonBody(
      context.req,
      CreatePersonalApiTokenRequestSchema,
      () => new InvalidPersonalSecurityRequest({ fieldErrors: [] }),
    );
    const input = yield* validatedTokenInput(body);
    const { db, auth } = yield* dependencies(context);
    const principal = context.get("principal");
    yield* authorizePersonal(db, principal);
    const created = yield* createToken(
      auth,
      principal,
      input.name,
      input.scopes,
    );
    yield* audit(db, {
      action: "personal_api_token.create",
      outcome: "success",
      principal,
      requestId: context.get("requestId"),
      targetTokenId: created.token.id,
      tokenScopes: input.scopes,
    });
    return yield* Schema.encodeUnknownEffect(
      CreatePersonalApiTokenResponseSchema,
    )({ status: "success", data: created });
  });
  return run(context, operation, 201);
});

personalSecurityRoutes.post("/tokens/:tokenId/rotate", async (context) => {
  const operation = Effect.gen(function* () {
    const { tokenId } = yield* decode(PersonalApiTokenParamsSchema, {
      tokenId: context.req.param("tokenId"),
    });
    const { db, auth } = yield* dependencies(context);
    const principal = context.get("principal");
    yield* authorizePersonal(db, principal);
    const existing = yield* ownedToken(auth, context.req.raw.headers, tokenId);
    const source = yield* tokenData(existing);
    const replacement = yield* createToken(
      auth,
      principal,
      source.name,
      source.scopes,
    );
    const deleted = yield* Effect.result(
      deleteOwnedToken(auth, context.req.raw.headers, tokenId),
    );
    if (Result.isFailure(deleted)) {
      yield* Effect.ignore(
        deleteOwnedToken(auth, context.req.raw.headers, replacement.token.id),
      );
      return yield* Effect.fail(deleted.failure);
    }
    yield* audit(db, {
      action: "personal_api_token.rotate",
      outcome: "success",
      principal,
      requestId: context.get("requestId"),
      targetTokenId: tokenId,
      tokenScopes: source.scopes,
    });
    return yield* Schema.encodeUnknownEffect(
      RotatePersonalApiTokenResponseSchema,
    )({ status: "success", data: replacement });
  });
  return run(context, operation);
});

personalSecurityRoutes.delete("/tokens/:tokenId", async (context) => {
  const operation = Effect.gen(function* () {
    const { tokenId } = yield* decode(PersonalApiTokenParamsSchema, {
      tokenId: context.req.param("tokenId"),
    });
    const { db, auth } = yield* dependencies(context);
    const principal = context.get("principal");
    yield* authorizePersonal(db, principal);
    const existing = yield* ownedToken(auth, context.req.raw.headers, tokenId);
    const source = yield* tokenData(existing);
    yield* deleteOwnedToken(auth, context.req.raw.headers, tokenId);
    yield* audit(db, {
      action: "personal_api_token.revoke",
      outcome: "success",
      principal,
      requestId: context.get("requestId"),
      targetTokenId: tokenId,
      tokenScopes: source.scopes,
    });
    return yield* Schema.encodeUnknownEffect(
      RevokePersonalApiTokenResponseSchema,
    )({ status: "success", data: { revokedTokenId: tokenId } });
  });
  return run(context, operation);
});

personalSecurityRoutes.get("/sessions", async (context) => {
  const operation = Effect.gen(function* () {
    const query = yield* decode(ListBrowserSessionsQuerySchema, {
      limit: context.req.query("limit"),
      offset: context.req.query("offset"),
    });
    const { db, current } = yield* dependencies(context);
    const principal = context.get("principal");
    yield* authorizePersonal(db, principal);
    const page = yield* withSecurity(
      db,
      Effect.gen(function* () {
        const service = yield* PersonalSecurityService;
        return yield* service.listSessions(
          principal,
          current.sessionId,
          query.limit ?? 25,
          query.offset ?? (0 as SecurityPageOffset),
        );
      }),
    );
    return yield* Schema.encodeUnknownEffect(ListBrowserSessionsResponseSchema)(
      {
        status: "success",
        data: {
          items: page.items,
          ...(page.nextOffset === undefined
            ? {}
            : { nextOffset: page.nextOffset }),
        },
      },
    );
  });
  return run(context, operation);
});

personalSecurityRoutes.delete("/sessions/:sessionId", async (context) => {
  const operation = Effect.gen(function* () {
    const { sessionId } = yield* decode(BrowserSessionParamsSchema, {
      sessionId: context.req.param("sessionId"),
    });
    const { db, auth, current } = yield* dependencies(context);
    const principal = context.get("principal");
    yield* authorizePersonal(db, principal);
    const target = yield* withSecurity(
      db,
      Effect.gen(function* () {
        const service = yield* PersonalSecurityService;
        return yield* service.ownedSessionForRevocation(
          principal,
          current.sessionId,
          sessionId,
        );
      }),
    );
    yield* provider(() =>
      auth.api.revokeSession({
        headers: context.req.raw.headers,
        body: { token: target.token },
      }),
    );
    yield* audit(db, {
      action: "browser_session.revoke",
      outcome: "success",
      principal,
      requestId: context.get("requestId"),
      targetSessionId: sessionId,
    });
    return yield* Schema.encodeUnknownEffect(
      RevokeBrowserSessionResponseSchema,
    )({ status: "success", data: { revokedSessionId: sessionId } });
  });
  return run(context, operation);
});

personalSecurityRoutes.post("/sessions/revoke-others", async (context) => {
  const operation = Effect.gen(function* () {
    const { db, auth } = yield* dependencies(context);
    const principal = context.get("principal");
    yield* authorizePersonal(db, principal);
    yield* provider(() =>
      auth.api.revokeOtherSessions({ headers: context.req.raw.headers }),
    );
    yield* audit(db, {
      action: "browser_session.revoke_others",
      outcome: "success",
      principal,
      requestId: context.get("requestId"),
    });
    return yield* Schema.encodeUnknownEffect(
      RevokeOtherBrowserSessionsResponseSchema,
    )({ status: "success", data: { currentSessionProtected: true } });
  });
  return run(context, operation);
});
