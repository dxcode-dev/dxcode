import {
  AllowedEmailDomain,
  SignInAdmission,
  SignInProviderId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { deploymentEmailSender, type EmailSender } from "../email/sender.js";
import type { Bindings } from "../http/types.js";
import type { AuthenticationRequirements } from "./requirements.js";

export class SignInConfigurationError extends Schema.TaggedError<SignInConfigurationError>()(
  "SignInConfigurationError",
  {
    reason: Schema.Literals([
      "invalid_provider",
      "no_provider",
      "invalid_admission",
      "invalid_email_domain",
      "email_sender_required",
      "google_credentials_required",
      "turnstile_required",
      "invalid_legal_url",
    ]),
  },
) {}

type Reason = SignInConfigurationError["reason"];

/** The deployment's sign-in providers and the policy that admits new users. */
export interface SignInConfiguration {
  readonly providers: ReadonlyArray<SignInProviderId>;
  readonly admission: SignInAdmission;
  readonly allowedEmailDomains: ReadonlyArray<string>;
  /**
   * The deployment's sender; required by magic link and by password
   * verification. Notification email uses the same sender.
   */
  readonly email?: EmailSender;
  /** Password sign-ups confirm their address before the first session. */
  readonly emailVerification: boolean;
  readonly google?: {
    readonly clientId: string;
    readonly clientSecret: string;
  };
  /** Absent only for local and test environments without a Turnstile secret. */
  readonly turnstile?: {
    readonly siteKey?: string;
    readonly secretKey: string;
  };
  readonly termsUrl?: string;
  readonly privacyUrl?: string;
}

const fail = (reason: Reason) => new SignInConfigurationError({ reason });

const nonEmpty = (value: string | undefined) => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);

const developmentEnvironment = (environment: string) =>
  environment === "local" || environment === "test";

/** Preview branches and staging keep a bootstrapped reviewer password beside magic link. */
export const reviewerPasswordEnabled = (
  bindings: Pick<Bindings, "DX_DEPLOYMENT_TARGET">,
  requirements: Pick<AuthenticationRequirements, "environment">,
) =>
  (requirements.environment === "preview" &&
    bindings.DX_DEPLOYMENT_TARGET === "branch") ||
  (requirements.environment === "staging" &&
    bindings.DX_DEPLOYMENT_TARGET === "staging");

/**
 * Deployments written before `DX_SIGN_IN_PROVIDERS` existed chose one mode:
 * a configured sender (or any hosted environment) meant magic link behind a
 * waitlist, and everything else meant email/password.
 */
const derivedProviders = (
  bindings: Bindings,
  requirements: Pick<AuthenticationRequirements, "environment">,
): ReadonlyArray<string> => {
  const magicLink =
    nonEmpty(bindings.DX_AUTH_EMAIL_FROM) !== undefined ||
    !(
      developmentEnvironment(requirements.environment) ||
      requirements.environment === "selfhost"
    );
  if (!magicLink) return ["email-password"];
  return reviewerPasswordEnabled(bindings, requirements)
    ? ["magic-link", "email-password"]
    : ["magic-link"];
};

const derivedAdmission = (
  bindings: Bindings,
  requirements: Pick<AuthenticationRequirements, "environment">,
  providers: ReadonlyArray<SignInProviderId>,
): SignInAdmission => {
  if (developmentEnvironment(requirements.environment)) return "open";
  if (providers.includes("magic-link")) return "waitlist";
  return bindings.DX_SIGNUP_ENABLED === "true" ? "open" : "invite";
};

const httpsUrl = (value: string | undefined) =>
  Effect.gen(function* () {
    const url = nonEmpty(value);
    if (url === undefined) return undefined;
    const parsed = yield* Effect.try({
      try: () => new URL(url),
      catch: () => fail("invalid_legal_url"),
    });
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return yield* fail("invalid_legal_url");
    return parsed.toString();
  });

/** Reads sign-in configuration from Worker bindings and fails closed on any gap. */
export const loadSignInConfiguration = Effect.fn("loadSignInConfiguration")(
  function* (
    bindings: Bindings,
    requirements: Pick<AuthenticationRequirements, "environment">,
  ) {
    const configured = list(bindings.DX_SIGN_IN_PROVIDERS);
    const providerNames =
      configured.length === 0
        ? derivedProviders(bindings, requirements)
        : configured;
    const providers: Array<SignInProviderId> = [];
    for (const name of providerNames) {
      const provider = yield* Schema.decodeUnknownEffect(SignInProviderId)(
        name,
      ).pipe(Effect.mapError(() => fail("invalid_provider")));
      if (!providers.includes(provider)) providers.push(provider);
    }
    if (providers.length === 0) return yield* fail("no_provider");

    const admissionName = nonEmpty(bindings.DX_SIGN_IN_ADMISSION);
    const admission =
      admissionName === undefined
        ? derivedAdmission(bindings, requirements, providers)
        : yield* Schema.decodeUnknownEffect(SignInAdmission)(
            admissionName,
          ).pipe(Effect.mapError(() => fail("invalid_admission")));

    const allowedEmailDomains: Array<string> = [];
    for (const domain of list(bindings.DX_SIGN_IN_ALLOWED_EMAIL_DOMAINS)) {
      const normalized = yield* Schema.decodeUnknownEffect(AllowedEmailDomain)(
        domain.toLowerCase(),
      ).pipe(Effect.mapError(() => fail("invalid_email_domain")));
      if (!allowedEmailDomains.includes(normalized))
        allowedEmailDomains.push(normalized);
    }

    const email = deploymentEmailSender(bindings);
    const development = developmentEnvironment(requirements.environment);
    if (providers.includes("magic-link") && email === undefined)
      return yield* fail("email_sender_required");
    // Public password sign-up must prove the address; only invite links and
    // the bootstrapped administrator may skip that.
    if (
      providers.includes("email-password") &&
      admission !== "invite" &&
      !development &&
      email === undefined
    )
      return yield* fail("email_sender_required");

    const clientId = nonEmpty(bindings.DX_GOOGLE_CLIENT_ID);
    const clientSecret = nonEmpty(bindings.DX_GOOGLE_CLIENT_SECRET);
    if (
      providers.includes("google") &&
      (clientId === undefined || clientSecret === undefined)
    )
      return yield* fail("google_credentials_required");

    const secretKey = nonEmpty(bindings.DX_TURNSTILE_SECRET_KEY);
    if (providers.includes("magic-link") && !development && !secretKey)
      return yield* fail("turnstile_required");
    const siteKey = nonEmpty(bindings.DX_TURNSTILE_SITE_KEY);

    const termsUrl = yield* httpsUrl(bindings.DX_TERMS_URL);
    const privacyUrl = yield* httpsUrl(bindings.DX_PRIVACY_URL);

    return {
      providers,
      admission,
      allowedEmailDomains,
      ...(email === undefined ? {} : { email }),
      emailVerification:
        providers.includes("email-password") &&
        email !== undefined &&
        !development,
      ...(providers.includes("google") &&
      clientId !== undefined &&
      clientSecret !== undefined
        ? { google: { clientId, clientSecret } }
        : {}),
      ...(secretKey === undefined
        ? {}
        : {
            turnstile: {
              secretKey,
              ...(siteKey === undefined ? {} : { siteKey }),
            },
          }),
      ...(termsUrl === undefined ? {} : { termsUrl }),
      ...(privacyUrl === undefined ? {} : { privacyUrl }),
    } satisfies SignInConfiguration;
  },
);
