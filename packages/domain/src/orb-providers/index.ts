import { Schema } from "effect";
import { cloudflareOrbProvider } from "./cloudflare.js";
import { dockerOrbProvider } from "./docker.js";
import { e2bOrbProvider } from "./e2b.js";
import { freestyleOrbProvider } from "./freestyle.js";
import { localOrbProvider } from "./local.js";

/**
 * Every Orb provider, in registry order (settings, the picker, and
 * precedence ties follow it). Adding a provider adds its descriptor here;
 * wiki/plugin-platform-direction.md "Adding an Orb provider" lists the rest.
 */
export const ORB_PROVIDERS = [
  e2bOrbProvider,
  cloudflareOrbProvider,
  freestyleOrbProvider,
  dockerOrbProvider,
  localOrbProvider,
] as const;

type OrbProviders = typeof ORB_PROVIDERS;
type Field<
  Descriptors extends ReadonlyArray<unknown>,
  Key extends PropertyKey,
> = {
  readonly [Index in keyof Descriptors]: Descriptors[Index] extends {
    readonly [K in Key]: infer Value;
  }
    ? Value
    : never;
};

export const ORB_PROVIDER_IDS = ORB_PROVIDERS.map(
  ({ id }) => id,
) as unknown as Field<OrbProviders, "id">;

export const OrbProviderId = Schema.Literals(ORB_PROVIDER_IDS);

export type OrbProviderId = typeof OrbProviderId.Type;

export const isOrbProviderId = (value: string): value is OrbProviderId =>
  (ORB_PROVIDER_IDS as ReadonlyArray<string>).includes(value);

export type AnyOrbProvider = OrbProviders[number];

export const findOrbProvider = (
  providerId: string,
): AnyOrbProvider | undefined =>
  ORB_PROVIDERS.find(({ id }) => id === providerId);

/** One runner-profile configuration, whichever provider it names. */
export const OrbRunnerProfileConfiguration = Schema.Union(
  ORB_PROVIDERS.map(({ profile }) => profile) as unknown as Field<
    OrbProviders,
    "profile"
  >,
);

export type OrbRunnerProfileConfiguration =
  typeof OrbRunnerProfileConfiguration.Type;

/** Every provider's own sizes, in registry order. */
export const ORB_PROVIDER_SIZES: ReadonlyArray<OrbRunnerProfileConfiguration> =
  ORB_PROVIDERS.flatMap(
    ({ sizes }) => sizes as ReadonlyArray<OrbRunnerProfileConfiguration>,
  );

/**
 * A size's profile with the target its Thread pinned from a connection;
 * unchanged for a provider that pins none.
 */
export const withPinnedOrbTarget = <
  Profile extends OrbRunnerProfileConfiguration,
>(
  profile: Profile,
  target: string,
): Profile => {
  const provider: { readonly withTarget?: unknown } | undefined =
    findOrbProvider(profile.adapter);
  const withTarget = provider?.withTarget as
    | ((profile: Profile, target: string) => Profile)
    | undefined;
  return withTarget === undefined ? profile : withTarget(profile, target);
};
