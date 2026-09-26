import { apiKey } from "@better-auth/api-key";
import type { BetterAuthPlugin } from "@better-auth/core";
import type { BrowserAuthenticationMode } from "@dx/api";
import {
  normalizeWorkspaceDisplayName,
  normalizeWorkspaceShortName,
  type Principal,
  personalApiTokenScopes,
  WorkspaceDisplayName,
  WorkspaceShortName,
} from "@dx/domain";
import { betterAuth, type InferAPI } from "better-auth";
import { APIError } from "better-auth/api";
import { organization } from "better-auth/plugins";
import { Effect, Option, Schema } from "effect";
import type { Bindings } from "../http/types.js";
import { cloudflareMagicLink } from "./cloudflare-magic-link.js";
import { emailPassword } from "./email-password.js";
import type { AuthenticationRequirements } from "./requirements.js";
import { verifyTurnstile } from "./turnstile.js";
import { waitlistAdmission } from "./waitlist.js";
import { workspaceMembershipExists } from "./workspace-membership.js";

export const browserAuthenticationMode = (
  requirements: AuthenticationRequirements,
  bindings: Pick<Bindings, "DX_AUTH_EMAIL_FROM"> = {},
): BrowserAuthenticationMode =>
  bindings.DX_AUTH_EMAIL_FROM?.trim()
    ? "magic-link"
    : requirements.environment === "local" ||
        requirements.environment === "test" ||
        requirements.environment === "selfhost"
      ? "email-password"
      : "magic-link";

export const reviewerPasswordEnabled = (
  bindings: Pick<Bindings, "DX_DEPLOYMENT_TARGET">,
  requirements: AuthenticationRequirements,
) =>
  (requirements.environment === "preview" &&
    bindings.DX_DEPLOYMENT_TARGET === "branch") ||
  (requirements.environment === "staging" &&
    bindings.DX_DEPLOYMENT_TARGET === "staging");

export const selfhostSignupEnabled = (
  bindings: Pick<Bindings, "DX_SIGNUP_ENABLED">,
) => bindings.DX_SIGNUP_ENABLED === "true";

const defaultAuthenticationPlugins = (
  bindings: Bindings,
  requirements: AuthenticationRequirements,
): readonly BetterAuthPlugin[] => {
  if (browserAuthenticationMode(requirements, bindings) === "email-password") {
    return [
      requirements.environment === "selfhost"
        ? emailPassword(undefined, selfhostSignupEnabled(bindings))
        : emailPassword(undefined, true),
    ];
  }
  if (bindings.DB === undefined)
    throw new Error("D1 database binding is required.");
  if (bindings.EMAIL === undefined)
    throw new Error("Cloudflare email binding is required for deployed auth.");
  const from = bindings.DX_AUTH_EMAIL_FROM?.trim();
  if (from === undefined || from.length === 0)
    throw new Error("DX_AUTH_EMAIL_FROM is required for deployed auth.");
  const magicLink = cloudflareMagicLink({
    email: bindings.EMAIL,
    from,
    admitEmail: waitlistAdmission(bindings.DB),
    verifyRequest: async (token) => {
      const error = await Effect.runPromise(
        verifyTurnstile({
          token,
          secret: bindings.DX_TURNSTILE_SECRET_KEY,
          hostname: new URL(requirements.authUrl).hostname,
        }).pipe(
          Effect.match({
            onFailure: (failure) => failure.message,
            onSuccess: () => undefined,
          }),
        ),
      );
      if (error) throw new APIError("FORBIDDEN", { message: error });
    },
  });
  return reviewerPasswordEnabled(bindings, requirements)
    ? [magicLink, emailPassword(undefined)]
    : [magicLink];
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

export const createAuth = (
  bindings: Bindings,
  requirements: AuthenticationRequirements,
  authenticationPlugin:
    | BetterAuthPlugin
    | readonly BetterAuthPlugin[] = defaultAuthenticationPlugins(
    bindings,
    requirements,
  ),
) => {
  const auth = betterAuth({
    appName: "dx",
    database: bindings.DB,
    secret: requirements.secret,
    baseURL: requirements.authUrl,
    basePath: "/api/auth",
    trustedOrigins: [...requirements.trustedOrigins],
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 60 * 60,
        strategy: "compact",
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
    plugins: [
      ...(Array.isArray(authenticationPlugin)
        ? authenticationPlugin
        : [authenticationPlugin]),
      workspaceOrganization(bindings),
      dxApiKey(),
    ],
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
