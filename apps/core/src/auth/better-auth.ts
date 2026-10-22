import { apiKey } from "@better-auth/api-key";
import type { BetterAuthPlugin } from "@better-auth/core";
import {
  normalizeWorkspaceDisplayName,
  normalizeWorkspaceShortName,
  type Principal,
  personalApiTokenScopes,
  type SignInRejection,
  WorkspaceDisplayName,
  WorkspaceShortName,
} from "@dx/domain";
import { betterAuth, type InferAPI } from "better-auth";
import { APIError, getOAuthState } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { Effect, Option, Schema } from "effect";
import type { Bindings } from "../http/types.js";
import {
  admitNewIdentity,
  signInRejectionMessages,
  userExists,
} from "./admission.js";
import { cloudflareMagicLink } from "./cloudflare-magic-link.js";
import { emailPassword } from "./email-password.js";
import { fillMissingName } from "./profile-name.js";
import type { AuthenticationRequirements } from "./requirements.js";
import {
  noteSessionEnded,
  sessionCacheVersion,
  sessionCookieCacheMaxAgeSeconds,
} from "./session-revocation.js";
import {
  loadSignInConfiguration,
  type SignInConfiguration,
} from "./sign-in-configuration.js";
import { verifyTurnstile } from "./turnstile.js";
import { workspaceMembershipExists } from "./workspace-membership.js";

const turnstileVerifier =
  (
    configuration: SignInConfiguration,
    requirements: AuthenticationRequirements,
  ) =>
  async (token: string | null) => {
    const error = await Effect.runPromise(
      verifyTurnstile({
        token,
        secret: configuration.turnstile?.secretKey,
        hostname: new URL(requirements.authUrl).hostname,
      }).pipe(
        Effect.match({
          onFailure: (failure) => failure.message,
          onSuccess: () => undefined,
        }),
      ),
    );
    if (error) throw new APIError("FORBIDDEN", { message: error });
  };

const rejectionError = (rejection: SignInRejection) =>
  new APIError("FORBIDDEN", {
    code: rejection,
    message: signInRejectionMessages[rejection],
  });

/** Builds the Better Auth plugins for the configured sign-in providers. */
export const signInPlugins = (
  bindings: Bindings,
  requirements: AuthenticationRequirements,
  configuration: SignInConfiguration,
): readonly BetterAuthPlugin[] => {
  const db = bindings.DB;
  if (db === undefined) throw new Error("D1 database binding is required.");
  const verifyRequest =
    configuration.turnstile === undefined
      ? undefined
      : turnstileVerifier(configuration, requirements);
  const plugins: BetterAuthPlugin[] = [];
  if (configuration.providers.includes("magic-link")) {
    const email = configuration.email;
    if (email === undefined)
      throw new Error("Magic link requires an email sender.");
    plugins.push(
      cloudflareMagicLink({
        email: email.binding,
        from: email.from,
        verifyRequest,
        admitEmail: async (address, callbackURL) => {
          if (await userExists(db, address)) return "sent";
          const rejection = await admitNewIdentity(db, configuration, {
            email: address,
            callbackURL,
          });
          if (rejection === "waitlisted") return "waitlisted";
          if (rejection !== undefined) throw rejectionError(rejection);
          return "sent";
        },
      }),
    );
  }
  if (configuration.providers.includes("email-password"))
    plugins.push(
      emailPassword({
        ...(configuration.emailVerification && configuration.email
          ? {
              verification: {
                email: configuration.email.binding,
                from: configuration.email.from,
                signInUrl: `${requirements.authUrl}/signin`,
              },
            }
          : {}),
        ...(configuration.emailVerification && verifyRequest
          ? { verifyRequest }
          : {}),
        admitSignUp: async (address, callbackURL) => {
          if (await userExists(db, address)) return;
          const rejection = await admitNewIdentity(db, configuration, {
            email: address,
            callbackURL,
          });
          if (rejection !== undefined) throw rejectionError(rejection);
        },
      }),
    );
  return plugins;
};

const requestCallbackURL = async (
  method: string,
  context: { readonly body?: unknown; readonly query?: unknown } | undefined,
) => {
  if (method === "oauth") return (await getOAuthState())?.callbackURL;
  const fromRecord = (value: unknown) =>
    typeof value === "object" && value !== null && "callbackURL" in value
      ? value.callbackURL
      : undefined;
  return fromRecord(context?.body) ?? fromRecord(context?.query);
};

const localCookiePrefix = (requirements: AuthenticationRequirements) => {
  if (requirements.environment !== "local") return undefined;
  const authUrl = new URL(requirements.authUrl);
  if (
    (authUrl.hostname !== "localhost" && authUrl.hostname !== "127.0.0.1") ||
    authUrl.port.length === 0
  ) {
    return undefined;
  }
  return `dx-local-${authUrl.port}`;
};

const workspaceOrganization = (bindings: Bindings) => {
  const db = bindings.DB;
  if (db === undefined) throw new Error("D1 database binding is required.");
  const assertNoMembership = async (userId: string) => {
    if (await workspaceMembershipExists(db, userId)) {
      throw new APIError("CONFLICT", {
        message: "This user already belongs to a workspace.",
      });
    }
  };
  const normalizedProfile = (input: {
    readonly name?: string;
    readonly slug?: string;
    readonly [key: string]: unknown;
  }) => {
    const displayName =
      input.name === undefined
        ? undefined
        : Schema.decodeOption(WorkspaceDisplayName)(
            normalizeWorkspaceDisplayName(input.name),
          );
    const shortName =
      input.slug === undefined
        ? undefined
        : Schema.decodeOption(WorkspaceShortName)(
            normalizeWorkspaceShortName(input.slug),
          );
    if (
      (displayName !== undefined && Option.isNone(displayName)) ||
      (shortName !== undefined && Option.isNone(shortName))
    ) {
      throw new APIError("BAD_REQUEST", {
        message: "Workspace profile validation failed.",
      });
    }
    return {
      ...input,
      ...(displayName === undefined || Option.isNone(displayName)
        ? {}
        : { name: displayName.value }),
      ...(shortName === undefined || Option.isNone(shortName)
        ? {}
        : { slug: shortName.value }),
    };
  };

  return organization({
    organizationLimit: 1,
    invitationLimit: 0,
    disableOrganizationDeletion: true,
    allowUserToCreateOrganization: async (user) =>
      !(await workspaceMembershipExists(db, user.id)),
    organizationHooks: {
      beforeCreateOrganization: async ({ organization }) => ({
        data: normalizedProfile(organization),
      }),
      beforeUpdateOrganization: async ({ organization }) => ({
        data: normalizedProfile(organization),
      }),
      beforeAddMember: async ({ member }) => {
        await assertNoMembership(member.userId);
      },
      // Workspaces grow only through dx invite links (settings/members).
      beforeCreateInvitation: async () => {
        throw new APIError("FORBIDDEN", {
          message: "Use a workspace invite link.",
        });
      },
      beforeAcceptInvitation: async () => {
        throw new APIError("FORBIDDEN", {
          message: "Use a workspace invite link.",
        });
      },
    },
  });
};

const dxApiKey = () =>
  apiKey([
    {
      configId: "user-keys",
      defaultPrefix: "dxu_",
      references: "user",
      requireName: true,
      maximumNameLength: 64,
      startingCharactersConfig: {
        shouldStore: true,
        charactersLength: 12,
      },
      permissions: {
        defaultPermissions: { dx: [...personalApiTokenScopes] },
      },
      rateLimit: { enabled: false },
    },
    {
      configId: "org-keys",
      defaultPrefix: "dxo_",
      references: "organization",
      permissions: { defaultPermissions: {} },
      rateLimit: { enabled: false },
    },
    {
      configId: "daemon-keys",
      defaultPrefix: "dxd_",
      references: "user",
      requireName: true,
      maximumNameLength: 64,
      startingCharactersConfig: {
        shouldStore: true,
        charactersLength: 12,
      },
      enableMetadata: true,
      permissions: { defaultPermissions: {} },
      rateLimit: { enabled: false },
    },
  ]);

type ApiKeyApi = InferAPI<ReturnType<typeof dxApiKey>["endpoints"]>;

function assertAuthApiKey<Auth extends { readonly api: object }>(
  auth: Auth,
): asserts auth is Auth & { readonly api: Auth["api"] & ApiKeyApi } {
  const { api } = auth;
  if (
    !("createApiKey" in api) ||
    typeof api.createApiKey !== "function" ||
    !("verifyApiKey" in api) ||
    typeof api.verifyApiKey !== "function" ||
    !("getApiKey" in api) ||
    typeof api.getApiKey !== "function" ||
    !("deleteApiKey" in api) ||
    typeof api.deleteApiKey !== "function" ||
    !("listApiKeys" in api) ||
    typeof api.listApiKeys !== "function"
  ) {
    throw new Error("Better Auth API key endpoints are unavailable.");
  }
}

/**
 * The issuer better-auth 1.7.0 through 1.7.2 recorded for an account: the
 * provider's own issuer when it has one (Cloudflare Access passes its team
 * URL), otherwise a local issuer named after the provider, such as
 * `local:credential`.
 */
const accountIssuer = (account: {
  readonly providerId: string;
  readonly issuer?: unknown;
}) =>
  typeof account.issuer === "string" && account.issuer !== ""
    ? account.issuer
    : `local:${encodeURIComponent(account.providerId)}`;

export const createAuth = (
  bindings: Bindings,
  requirements: AuthenticationRequirements,
  authenticationPlugin?: BetterAuthPlugin | readonly BetterAuthPlugin[],
) => {
  const configuration = Effect.runSync(
    loadSignInConfiguration(bindings, requirements),
  );
  const db = bindings.DB;
  if (db === undefined) throw new Error("D1 database binding is required.");
  const providerPlugins =
    authenticationPlugin === undefined
      ? signInPlugins(bindings, requirements, configuration)
      : Array.isArray(authenticationPlugin)
        ? authenticationPlugin
        : [authenticationPlugin];
  const auth = betterAuth({
    appName: "dx",
    database: bindings.DB,
    secret: requirements.secret,
    baseURL: requirements.authUrl,
    basePath: "/api/auth",
    trustedOrigins: [...requirements.trustedOrigins],
    ...(configuration.google === undefined
      ? {}
      : {
          socialProviders: {
            google: {
              clientId: configuration.google.clientId,
              clientSecret: configuration.google.clientSecret,
              prompt: "select_account",
            },
          },
        }),
    user: {
      // The one admission gate for every provider: magic link, password,
      // Google, and Cloudflare Access all create users through it.
      validateUserInfo: async ({ user, source }, context) => {
        if (
          source.action === "link-account" &&
          source.method === "oauth" &&
          typeof user.id === "string"
        )
          await fillMissingName(db, user.id, user.name);
        if (source.action !== "create-user") return;
        if (typeof user.email !== "string")
          return { error: "email_unverified" };
        if (source.method === "oauth" && user.emailVerified !== true) {
          const rejection: SignInRejection = "email_unverified";
          return {
            error: rejection,
            errorDescription: signInRejectionMessages[rejection],
          };
        }
        const rejection = await admitNewIdentity(db, configuration, {
          email: user.email,
          callbackURL: await requestCallbackURL(source.method, context),
        });
        return rejection === undefined
          ? undefined
          : {
              error: rejection,
              errorDescription: signInRejectionMessages[rejection],
            };
      },
    },
    account: {
      // Migration 0002 created the account table with better-auth 1.7.0's
      // required issuer and its unique (issuer, accountId) index. Since
      // 1.7.3 better-auth keys accounts by (providerId, accountId) and no
      // longer writes issuer, so dx keeps writing it here.
      additionalFields: {
        issuer: { type: "string", required: false, input: false },
      },
    },
    databaseHooks: {
      user: {
        create: {
          // Local and test environments send no email, so a password sign-up
          // there counts as proven, as the deployment bootstrap's operator
          // address does. Otherwise a later magic link would revoke it.
          before: async (user, context) =>
            (requirements.environment === "local" ||
              requirements.environment === "test") &&
            context?.path === "/sign-up/email"
              ? { data: { ...user, emailVerified: true } }
              : undefined,
        },
      },
      account: {
        create: {
          before: async (account) => ({
            data: { ...account, issuer: accountIssuer(account) },
          }),
        },
      },
      session: {
        delete: {
          after: async (session) => noteSessionEnded(session.id),
        },
      },
    },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: sessionCookieCacheMaxAgeSeconds,
        strategy: "compact",
        // Asked on every cache hit. An ended session's cache stops matching,
        // so Better Auth reads D1, finds no session, and clears the cookies.
        version: (session) => sessionCacheVersion(db, session.id),
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      window: 60,
      max: 100,
    },
    advanced: {
      cookiePrefix: localCookiePrefix(requirements),
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
      useSecureCookies: new URL(requirements.authUrl).protocol === "https:",
      database: { generateId: () => crypto.randomUUID() },
    },
    plugins: [...providerPlugins, workspaceOrganization(bindings), dxApiKey()],
  });
  assertAuthApiKey(auth);
  return auth;
};

export type DxAuth = ReturnType<typeof createAuth>;

export const sessionPrincipal = (session: {
  readonly session: { readonly id: string };
  readonly user: { readonly id: string };
}): Principal => ({
  userId: session.user.id as Principal["userId"],
  credentialScopes: ["personal", "workspace"],
});
