import {
  AddVerificationKeyRequestSchema,
  AddVerificationKeyResponseSchema,
  CreateManagedSigningKeyResponseSchema,
  GetSigningKeysResponseSchema,
  ManagedSigningUnavailableResponseSchema,
  RevokeManagedSigningKeyResponseSchema,
  RevokeVerificationKeyResponseSchema,
  RotateManagedSigningKeyResponseSchema,
  SigningKeyConflictResponseSchema,
  SigningKeyNotFoundResponseSchema,
  SigningKeyParamsSchema,
  SigningKeysBrowserSessionRequiredResponseSchema,
  SigningKeysForbiddenResponseSchema,
  SigningKeysInvalidRequestResponseSchema,
  SigningKeysUnavailableResponseSchema,
  VerificationKeyParamsSchema,
} from "@dx/api";
import {
  normalizeVerificationKeyName,
  PersistenceUnavailable,
  SettingsMembershipInvariantViolation,
  SettingsScopeForbidden,
  SigningKeyConflict,
  SigningKeyNotFound,
  VerificationKeyName,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import {
  decodeJsonBody,
  decodeRequestInput,
} from "../../http/request-decoding.js";
import type { AppEnv } from "../../http/types.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { SettingsAudit } from "../audit.js";
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import {
  ManagedSigningUnavailable,
  requireManagedSigning,
  signingBackendCapabilities,
} from "./backend.js";
import { SigningKeyRepositoryD1 } from "./repository-d1.js";
import { SigningKeyService } from "./service.js";
import {
  InvalidSshPublicKey,
  SigningKeyGenerationUnavailable,
} from "./ssh-ed25519.js";

class InvalidSigningKeysRequest extends Schema.TaggedError<InvalidSigningKeysRequest>()(
  "InvalidSigningKeysRequest",
  {},
) {}

class BrowserSessionRequired extends Schema.TaggedError<BrowserSessionRequired>()(
  "BrowserSessionRequired",
  {},
) {}

const layersFor = (db: D1Database) => {
  const d1 = D1Client.layer({ db });
  const workspace = WorkspaceRepositoryD1(db).pipe(Layer.provide(d1));
  const settings = SettingsService.layer.pipe(Layer.provide(workspace));
  const keys = SigningKeyRepositoryD1(db);
  const service = SigningKeyService.layer.pipe(
    Layer.provide(Layer.merge(keys, SettingsAudit.layer)),
  );
  return Layer.mergeAll(workspace, settings, keys, service);
};

const authorizePersonal = Effect.fn("authorizePersonalSigningKeys")(function* (
  context: Context<AppEnv>,
  db: D1Database,
) {
  yield* Effect.gen(function* () {
    const settings = yield* SettingsService;
    yield* settings.personal(context.get("principal"));
  }).pipe(Effect.provide(layersFor(db)));
});

const setupGuidance = {
  title: "Add this public key to your Git host",
  steps: [
    "Copy the public key below. The private key never leaves dx's encrypted signing boundary.",
    "On GitHub, add a new SSH key and choose Signing Key as its key type.",
    "Compare the SHA-256 fingerprint before trusting signed commits.",
  ],
  gitHubUrl: "https://github.com/settings/ssh/new",
} as const;

const mutationAudit = (context: Context<AppEnv>) => ({
  requestId: context.get("requestId"),
  userId: context.get("principal").userId,
});

const errorResponse = (
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
  if (
    failure instanceof InvalidSigningKeysRequest ||
    failure instanceof InvalidSshPublicKey
  ) {
    return errorResponse(
      context,
      SigningKeysInvalidRequestResponseSchema,
      400,
      "INVALID_SIGNING_KEYS_REQUEST",
      "Signing key validation failed.",
    );
  }
  if (failure instanceof SettingsScopeForbidden) {
    return errorResponse(
      context,
      SigningKeysForbiddenResponseSchema,
      403,
      "SIGNING_KEYS_FORBIDDEN",
      "Signing keys are unavailable for this user.",
    );
  }
  if (failure instanceof BrowserSessionRequired) {
    return errorResponse(
      context,
      SigningKeysBrowserSessionRequiredResponseSchema,
      403,
      "BROWSER_SESSION_REQUIRED",
      "A browser session is required to manage signing keys.",
    );
  }
  if (failure instanceof SigningKeyNotFound) {
    return errorResponse(
      context,
      SigningKeyNotFoundResponseSchema,
      404,
      "SIGNING_KEY_NOT_FOUND",
      "Signing key not found.",
    );
  }
  if (failure instanceof SigningKeyConflict) {
    return errorResponse(
      context,
      SigningKeyConflictResponseSchema,
      409,
      "SIGNING_KEY_CONFLICT",
      "The signing key conflicts with an existing key.",
    );
  }
  if (failure instanceof ManagedSigningUnavailable) {
    return errorResponse(
      context,
      ManagedSigningUnavailableResponseSchema,
      503,
      "MANAGED_SIGNING_UNAVAILABLE",
      "Managed signing is not available in this deployment.",
    );
  }
  if (
    failure instanceof PersistenceUnavailable ||
    failure instanceof SettingsMembershipInvariantViolation ||
    failure instanceof SigningKeyGenerationUnavailable ||
    Schema.isSchemaError(failure)
  ) {
    return errorResponse(
      context,
      SigningKeysUnavailableResponseSchema,
      503,
      "SIGNING_KEYS_UNAVAILABLE",
      "Signing keys are temporarily unavailable.",
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

const signingKeyId = (context: Context<AppEnv>) =>
  decodeRequestInput(
    SigningKeyParamsSchema,
    { signingKeyId: context.req.param("signingKeyId") },
    () => new InvalidSigningKeysRequest(),
  ).pipe(Effect.map(({ signingKeyId: id }) => id));

const verificationKeyId = (context: Context<AppEnv>) =>
  decodeRequestInput(
    VerificationKeyParamsSchema,
    { verificationKeyId: context.req.param("verificationKeyId") },
    () => new InvalidSigningKeysRequest(),
  ).pipe(Effect.map(({ verificationKeyId: id }) => id));

export const personalSigningKeyRoutes = new Hono<AppEnv>();

personalSigningKeyRoutes.get("/", async (context) => {
  const operation = Effect.gen(function* () {
    const db = yield* decodeD1Binding(context.env.DB);
    yield* authorizePersonal(context, db);
    const capabilities = yield* signingBackendCapabilities(context.env);
    const data = yield* Effect.gen(function* () {
      const service = yield* SigningKeyService;
      return yield* service.overview(context.get("principal"), capabilities);
    }).pipe(Effect.provide(layersFor(db)));
    return yield* Schema.encodeUnknownEffect(GetSigningKeysResponseSchema)({
      status: "success",
      data,
    });
  });
  return run(context, operation);
});

personalSigningKeyRoutes.post("/managed", async (context) => {
  const operation = Effect.gen(function* () {
    const db = yield* decodeD1Binding(context.env.DB);
    yield* authorizePersonal(context, db);
    const keyring = yield* requireManagedSigning(context.env);
    const key = yield* Effect.gen(function* () {
      const service = yield* SigningKeyService;
      return yield* service.createManaged(
        keyring,
        context.get("principal"),
        mutationAudit(context),
      );
    }).pipe(Effect.provide(layersFor(db)));
    return yield* Schema.encodeUnknownEffect(
      CreateManagedSigningKeyResponseSchema,
    )({ status: "success", data: { key, setup: setupGuidance } });
  });
  return run(context, operation, 201);
});

personalSigningKeyRoutes.post(
  "/managed/:signingKeyId/rotate",
  async (context) => {
    const operation = Effect.gen(function* () {
      const id = yield* signingKeyId(context);
      const db = yield* decodeD1Binding(context.env.DB);
      yield* authorizePersonal(context, db);
      const keyring = yield* requireManagedSigning(context.env);
      const key = yield* Effect.gen(function* () {
        const service = yield* SigningKeyService;
        return yield* service.rotateManaged(
          keyring,
          context.get("principal"),
          id,
          mutationAudit(context),
        );
      }).pipe(Effect.provide(layersFor(db)));
      return yield* Schema.encodeUnknownEffect(
        RotateManagedSigningKeyResponseSchema,
      )({ status: "success", data: { key, setup: setupGuidance } });
    });
    return run(context, operation);
  },
);

personalSigningKeyRoutes.delete("/managed/:signingKeyId", async (context) => {
  const operation = Effect.gen(function* () {
    const id = yield* signingKeyId(context);
    const db = yield* decodeD1Binding(context.env.DB);
    yield* authorizePersonal(context, db);
    yield* Effect.gen(function* () {
      const service = yield* SigningKeyService;
      yield* service.revokeManaged(
        context.get("principal"),
        id,
        mutationAudit(context),
      );
    }).pipe(Effect.provide(layersFor(db)));
    return yield* Schema.encodeUnknownEffect(
      RevokeManagedSigningKeyResponseSchema,
    )({ status: "success", data: { revokedSigningKeyId: id } });
  });
  return run(context, operation);
});

personalSigningKeyRoutes.post("/verification", async (context) => {
  const operation = Effect.gen(function* () {
    const body = yield* decodeJsonBody(
      context.req,
      AddVerificationKeyRequestSchema,
      () => new InvalidSigningKeysRequest(),
    );
    const name = yield* Schema.decodeUnknownEffect(VerificationKeyName)(
      normalizeVerificationKeyName(body.name),
    ).pipe(Effect.mapError(() => new InvalidSigningKeysRequest()));
    const db = yield* decodeD1Binding(context.env.DB);
    yield* authorizePersonal(context, db);
    const key = yield* Effect.gen(function* () {
      const service = yield* SigningKeyService;
      return yield* service.addVerification(
        context.get("principal"),
        { name, publicKey: body.publicKey },
        mutationAudit(context),
      );
    }).pipe(Effect.provide(layersFor(db)));
    return yield* Schema.encodeUnknownEffect(AddVerificationKeyResponseSchema)({
      status: "success",
      data: key,
    });
  });
  return run(context, operation, 201);
});

personalSigningKeyRoutes.delete(
  "/verification/:verificationKeyId",
  async (context) => {
    const operation = Effect.gen(function* () {
      const id = yield* verificationKeyId(context);
      const db = yield* decodeD1Binding(context.env.DB);
      yield* authorizePersonal(context, db);
      yield* Effect.gen(function* () {
        const service = yield* SigningKeyService;
        yield* service.revokeVerification(
          context.get("principal"),
          id,
          mutationAudit(context),
        );
      }).pipe(Effect.provide(layersFor(db)));
      return yield* Schema.encodeUnknownEffect(
        RevokeVerificationKeyResponseSchema,
      )({ status: "success", data: { revokedVerificationKeyId: id } });
    });
    return run(context, operation);
  },
);
