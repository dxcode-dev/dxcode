import { OrbIcon } from "./orb-icon.js";

const LOGOS = import.meta.glob<string>("./orb-provider-logos/*.{svg,png}", {
  eager: true,
  query: "?url",
  import: "default",
});

/** The Orb provider's bundled logo URL, when dx has one. */
const orbProviderLogo = (id: string): string | undefined =>
  LOGOS[`./orb-provider-logos/${id}.svg`] ??
  LOGOS[`./orb-provider-logos/${id}.png`];

/**
 * An Orb provider's logo (Cloudflare, E2B, …), else the Orb, for a provider
 * dx has no logo for. Decorative: the caller names the provider.
 */
export function OrbProviderLogo({
  providerId,
  className,
}: {
  readonly providerId: string;
  readonly className?: string;
}) {
  const logo = orbProviderLogo(providerId);
  return logo === undefined ? (
    <OrbIcon aria-hidden="true" className={className} />
  ) : (
    <img
      src={logo}
      alt=""
      width={16}
      height={16}
      className={className}
      data-orb-provider-logo={providerId}
    />
  );
}
