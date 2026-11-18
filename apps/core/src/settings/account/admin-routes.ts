import {
  DeploymentAdminUserNotFoundResponseSchema,
  PersonalAccountPersistenceUnavailableResponseSchema,
  ResetUsernameChangeResponseSchema,
} from "@dx/api";
import { personalAccountUsernameChangeAvailable, UserId } from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Match, Option, Result, Schema } from "effect";
import { Hono } from "hono";
import type { AppEnv } from "../../http/types.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { SettingsAudit } from "../audit.js";
import { PersonalAccountRepositoryD1 } from "./repository-d1.js";
import { PersonalAccountService } from "./service.js";

/**
 * Deployment-admin account routes, mounted under `/v1/deployment-admin/users`
 * behind the admin check (auth/deployment-admin.ts). Every deployment has
 * them, public dx included.
 */
export const deploymentAdminAccountRoutes = new Hono<AppEnv>();

const userNotFound = (requestId: string) =>
  Schema.encodeUnknownSync(DeploymentAdminUserNotFoundResponseSchema)({
    status: "error",
    data: {
      code: "USER_NOT_FOUND",
      message: "No account has that user ID.",
      requestId,
    },
  });

/** Gives a person their one username change back; audited. */
deploymentAdminAccountRoutes.post(
  "/:userId/username-change/reset",
  async (context) => {
    const requestId = context.get("requestId");
    const userId = Schema.decodeUnknownOption(UserId)(
      context.req.param("userId"),
    );
    if (Option.isNone(userId))
      return context.json(userNotFound(requestId), 404);
    const operation = Effect.gen(function* () {
      const db = yield* decodeD1Binding(context.env.DB);
      return yield* Effect.gen(function* () {
        const accounts = yield* PersonalAccountService;
        const account = yield* accounts.resetUsernameChange(
          context.get("principal"),
          userId.value,
          requestId,
        );
        return yield* Schema.encodeUnknownEffect(
          ResetUsernameChangeResponseSchema,
        )({
          status: "success",
          data: {
            userId: account.userId,
            username: account.username,
            usernameChangeAvailable:
              personalAccountUsernameChangeAvailable(account),
          },
        });
      }).pipe(
        Effect.provide(
          PersonalAccountService.layer.pipe(
            Layer.provide(
              Layer.merge(
                PersonalAccountRepositoryD1.pipe(
                  Layer.provide(D1Client.layer({ db })),
                ),
                SettingsAudit.layer,
              ),
            ),
          ),
        ),
      );
    });

    const result = await Effect.runPromise(Effect.result(operation));
    if (Result.isSuccess(result)) return context.json(result.success, 200);
    return Match.value(result.failure).pipe(
      Match.tags({
        PersonalAccountNotFound: () =>
          context.json(userNotFound(requestId), 404),
        PersistenceUnavailable: () =>
          context.json(
            Schema.encodeUnknownSync(
              PersonalAccountPersistenceUnavailableResponseSchema,
            )({
              status: "error",
              data: {
                code: "PERSISTENCE_UNAVAILABLE",
                message: "Settings are temporarily unavailable.",
                requestId,
              },
            }),
            503,
          ),
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
  },
);
