/**
 * Claude Code in an Orb calls Anthropic from the Orb's own network, and
 * Anthropic refuses some places Cloudflare runs containers: there claude.ai
 * answers the Claude Code installer with its "unavailable in region" page
 * and the API answers HTTP 403. From 2026-11-20 Cloudflare ran Orbs in Hong
 * Kong (hkg01, hkg12), and every Claude Code Thread there failed before its
 * first turn (thr_05ddbf21).
 *
 * A container runs where its Durable Object runs, and a new object starts
 * next to the code that first calls it. So an Orb object Core first calls
 * from such a place is created with a location hint for the nearest place
 * Anthropic serves. Anywhere else it gets no hint and stays next to the
 * person. A hint only places a new object; an existing one never moves.
 */

/**
 * Cloudflare locations (IATA codes) in places Anthropic refuses, and the
 * hint for the nearest place it serves. Only the colo decides: a Worker's
 * or Durable Object's trace and `request.cf` name the country of its
 * egress IP, not where it runs (on a preview, `colo=SIN` came with
 * `loc=US`), so a country would miss Hong Kong.
 */
const SERVED_NEAR: Readonly<Record<string, DurableObjectLocationHint>> = {
  HKG: "apac-se",
  MFM: "apac-se",
};

export interface CloudflareLocation {
  readonly colo?: string | undefined;
  /** Logged only: it names the egress IP's country. */
  readonly country?: string | undefined;
}

/** The hint for a new object first called from `at`, if it needs one. */
export const anthropicServedHint = (
  at: CloudflareLocation,
): DurableObjectLocationHint | undefined =>
  at.colo === undefined ? undefined : SERVED_NEAR[at.colo.toUpperCase()];

const TRACE_URL = "https://www.cloudflare.com/cdn-cgi/trace";
const TRACE_TIMEOUT_MS = 2_000;

/** Where this isolate runs, from Cloudflare's trace (`colo=HKG`, `loc=HK`). */
const readLocation = async (): Promise<CloudflareLocation> => {
  const response = await fetch(TRACE_URL, {
    signal: AbortSignal.timeout(TRACE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`trace answered ${response.status}`);
  const fields = new Map(
    (await response.text())
      .split("\n")
      .map((line) => line.split("=", 2) as [string, string | undefined]),
  );
  return { country: fields.get("loc"), colo: fields.get("colo") };
};

export interface OrbPlacement extends CloudflareLocation {
  readonly locationHint?: DurableObjectLocationHint | undefined;
}

/**
 * Where a new Orb object this isolate creates should start. It is read only
 * when an object is created, never on a wake. A location it cannot read
 * gives no hint: the Orb starts as it did before, never not at all.
 */
export const orbPlacement = async (): Promise<OrbPlacement | undefined> => {
  try {
    const at = await readLocation();
    return { ...at, locationHint: anthropicServedHint(at) };
  } catch {
    return undefined;
  }
};
