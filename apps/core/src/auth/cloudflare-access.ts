import type {
  BetterAuthPlugin,
  GenericEndpointContext,
} from "@better-auth/core";
import {
  APIError,
  createAuthEndpoint,
  getSessionFromCtx,
} from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import {
  type AccessIdentity,
  accessUserId,
  verifyAccessAssertion,
} from "./access-jwt.js";

const providerId = "cloudflare-access";

export interface CloudflareAccessRequirements {
  readonly issuer: string;
  readonly audience: string;
}

type AccessAssertionVerifier = (
  assertion: string,
  issuer: string,
  audience: string,
) => Promise<AccessIdentity>;

const provisionAccessIdentity = async (
  context: GenericEndpointContext,
  identity: AccessIdentity,
) => {
  const adapter = context.context.internalAdapter;
  const userId = await accessUserId(identity.issuer, identity.subject);
  let account = await adapter.findAccountByKey({
    issuer: identity.issuer,
    accountId: identity.subject,
  });
  let user = account === null ? await adapter.findUserById(userId) : null;

  if (account !== null) {
    user = await adapter.findUserById(account.userId);
    if (account.userId !== userId || user === null) {
      throw new APIError("CONFLICT", { message: "Identity binding conflict." });
    }
    if (user.email !== identity.email) {
      throw new APIError("CONFLICT", { message: "Identity profile conflict." });
    }
  } else {
    if (user === null) {
      try {
        user = await adapter.createUser(
          {
            id: userId,
            email: identity.email,
            emailVerified: true,
            name: identity.name,
          },
          { method: providerId },
        );
      } catch {
        user = await adapter.findUserById(userId);
        if (user === null) {
          throw new APIError("CONFLICT", {
            message: "Identity could not be provisioned.",
          });
        }
      }
    }
    if (user.email !== identity.email) {
      throw new APIError("CONFLICT", { message: "Identity profile conflict." });
    }
    try {
      account = await adapter.createAccount({
        providerId,
        issuer: identity.issuer,
        accountId: identity.subject,
        userId,
      });
    } catch {
      account = await adapter.findAccountByKey({
        issuer: identity.issuer,
        accountId: identity.subject,
      });
    }
    if (account === null || account.userId !== userId) {
      throw new APIError("CONFLICT", { message: "Identity binding conflict." });
    }
  }

  const current = await getSessionFromCtx(context, {
    disableCookieCache: true,
  });
  const session =
    current?.session.userId === userId
      ? current.session
      : await adapter.createSession(userId);
  await setSessionCookie(context, { session, user });
  return { user: { id: user.id, email: user.email, name: user.name } };
};

export const cloudflareAccess = (
  requirements: CloudflareAccessRequirements,
  verifyAssertion: AccessAssertionVerifier = verifyAccessAssertion,
): BetterAuthPlugin => ({
  id: "cloudflare-access",
  endpoints: {
    accessExchange: createAuthEndpoint(
      "/access/exchange",
      { method: "POST" },
      async (context) => {
        const assertion = context.request?.headers.get(
          "cf-access-jwt-assertion",
        );
        if (assertion === null || assertion === undefined) {
          throw new APIError("UNAUTHORIZED", {
            message: "Cloudflare Access assertion required.",
          });
        }
        let identity: AccessIdentity;
        try {
          identity = await verifyAssertion(
            assertion,
            requirements.issuer,
            requirements.audience,
          );
        } catch {
          throw new APIError("UNAUTHORIZED", {
            message: "Cloudflare Access assertion invalid.",
          });
        }
        return context.json(await provisionAccessIdentity(context, identity));
      },
    ),
  },
});
