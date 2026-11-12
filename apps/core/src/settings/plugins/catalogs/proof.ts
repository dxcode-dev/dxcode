import {
  FIRST_PARTY_GITHUB_OWNER,
  isFirstPartyPluginDomain,
  MAX_PLUGIN_CATALOG_PUBLISHERS,
  type PluginCatalogEntry,
  type PluginCatalogProof,
  type PluginCatalogPublisher,
} from "@dx/domain";
import { Effect } from "effect";

/**
 * Proves that a catalog's publisher owns the domain its plugin names claim,
 * so nobody can list `com.acme.*` plugins without being Acme:
 *
 * - dx's own domain (`dev.dxcode.*`) only in a catalog under dx's GitHub
 *   owner, never by DNS.
 * - `<owner>.github.io` (`io.github.<owner>.*`) in a catalog under that
 *   GitHub owner, since GitHub already proves who the owner is.
 * - Any other domain by a TXT record at `_dx-plugins.<domain>` that says
 *   `dx-catalog=github.com/<owner>/<repo>`. One record per catalog; a domain
 *   may name several.
 */

export const DNS_PROOF_PREFIX = "_dx-plugins";

const dnsAnswer = (data: string) => {
  const quoted = [...data.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(
    ([, part]) => part ?? "",
  );
  return (quoted.length === 0 ? data : quoted.join("")).trim();
};

/** TXT values at a name over DNS over HTTPS; empty when there are none. */
const txtRecords = (name: string) =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=TXT`,
        {
          headers: { accept: "application/dns-json" },
          signal: AbortSignal.timeout(5_000),
        },
      );
      if (!response.ok) return [];
      const body: unknown = await response.json();
      const answers =
        typeof body === "object" &&
        body !== null &&
        Array.isArray((body as { Answer?: unknown }).Answer)
          ? (body as { Answer: Array<unknown> }).Answer
          : [];
      return answers.flatMap((answer) =>
        typeof answer === "object" &&
        answer !== null &&
        (answer as { type?: unknown }).type === 16 &&
        typeof (answer as { data?: unknown }).data === "string"
          ? [dnsAnswer((answer as { data: string }).data)]
          : [],
      );
    },
    catch: () => [] as Array<string>,
  }).pipe(Effect.orElseSucceed(() => [] as Array<string>));

/**
 * Every TXT value at `_dx-plugins.<domain>`, where a publisher keeps what
 * dx reads about it: `dx-catalog=github.com/<owner>/<repo>` for each catalog
 * it publishes through, and `dx-key=ssh-ed25519 …` for each signing key.
 * Empty when there are none or the lookup fails.
 */
export const publisherTxtRecords = (domain: string) =>
  txtRecords(`${DNS_PROOF_PREFIX}.${domain}`);

/** The TXT value that proves a domain for one catalog repository. */
export const dnsProofValue = (repository: string) =>
  `dx-catalog=github.com/${repository.toLowerCase()}`;

export const proveDomain = Effect.fn("proveCatalogDomain")(function* (
  domain: string,
  repository: string,
) {
  const owner = (repository.split("/")[0] ?? "").toLowerCase();
  if (isFirstPartyPluginDomain(domain)) {
    return (
      owner === FIRST_PARTY_GITHUB_OWNER ? "first-party" : "none"
    ) satisfies PluginCatalogProof;
  }
  if (domain.endsWith(".github.io") || domain === "github.io") {
    return (
      domain === `${owner}.github.io` ? "github" : "none"
    ) satisfies PluginCatalogProof;
  }
  const records = yield* publisherTxtRecords(domain);
  const expected = dnsProofValue(repository);
  return (
    records.some((record) => record.toLowerCase() === expected) ? "dns" : "none"
  ) satisfies PluginCatalogProof;
});

/** Proves every publisher domain a catalog's entries claim. */
export const provePublishers = Effect.fn("provePublishers")(function* (
  entries: ReadonlyArray<PluginCatalogEntry>,
  repository: string,
) {
  const domains = [
    ...new Set(entries.flatMap(({ publisher }) => publisher ?? [])),
  ].slice(0, MAX_PLUGIN_CATALOG_PUBLISHERS);
  return yield* Effect.forEach(
    domains,
    (domain) =>
      proveDomain(domain, repository).pipe(
        Effect.map((proof): PluginCatalogPublisher => ({ domain, proof })),
      ),
    { concurrency: 5 },
  );
});
