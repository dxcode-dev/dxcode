import {
  MAX_PLUGIN_ARCHIVE_BYTES,
  PersistenceUnavailable,
  type PluginId,
  pluginPublisherDomain,
  SigningKeyRepository,
  type UserId,
} from "@dx/domain";
import { Context, Effect, Layer } from "effect";
import type { Bindings } from "../../../http/types.js";
import { requireManagedSigning } from "../../keys/backend.js";
import { decryptSigningPrivateKey } from "../../keys/encryption.js";
import { SigningKeyRepositoryD1 } from "../../keys/repository-d1.js";
import {
  canonicalizeSigningPublicKey,
  signSshPayload,
  verifySshSignature,
} from "../../keys/ssh-ed25519.js";
import { publisherTxtRecords } from "../catalogs/proof.js";
import { openBundleFolder } from "./bundle-reader.js";
import { PluginBundleRejected } from "./errors.js";
import type { ZipArchive } from "./zip.js";
import type { ZipFile } from "./zip-writer.js";

/**
 * Plugin signatures (plugin plan §7, M5). A plugin may carry `plugin.sig` at
 * its root: an SSH signature in the `dx-plugin` namespace over a listing of
 * every other file in the plugin folder, one `<sha256 hex>  <path>` line per
 * file sorted by path bytes, as stock tools print it in the plugin folder:
 *
 *   git ls-files -z . | grep -zv '^plugin.sig$' | LC_ALL=C sort -z |
 *     xargs -0 sha256sum > listing && ssh-keygen -Y sign -n dx-plugin listing
 *
 * Symlinks are left out, as Git and `find -type f` leave them out. Only Ed25519 keys. A
 * signature that doesn't match blocks the install; no signature is fine.
 *
 * A signer is named only by what proves it: the viewer's own Signing Keys
 * page keys ("you"), or the publisher domain the plugin's name claims when
 * that domain lists the key, as `dx-key=ssh-ed25519 …` TXT records at
 * `_dx-plugins.<domain>` or, for `io.github.<owner>.*`, in
 * `https://github.com/<owner>.keys`. Anything else is just its fingerprint.
 */

export const PLUGIN_SIGNATURE_FILE = "plugin.sig";
export const PLUGIN_SIGNATURE_NAMESPACE = "dx-plugin";

export interface PluginSignature {
  readonly fingerprint: string;
  readonly publicKey: string;
  /** The publisher domain that lists the key, checked at install. */
  readonly publisher?: string;
}

export type PluginSignatureCheck =
  | { readonly status: "unsigned" }
  | { readonly status: "invalid" }
  | ({ readonly status: "signed" } & PluginSignature);

export const INVALID_SIGNATURE_CONFLICT =
  "plugin.sig does not match the plugin's files, so it may have been changed after it was signed.";

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** The most uncompressed bytes dx hashes to check one signature. */
const MAX_SIGNED_PLUGIN_BYTES = MAX_PLUGIN_ARCHIVE_BYTES;

const utf8 = new TextEncoder();

/** Byte order of the UTF-8 paths, as `LC_ALL=C sort` orders them. */
const byteOrder = (left: string, right: string) => {
  const a = utf8.encode(left);
  const b = utf8.encode(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
};

const sortedListing = (
  lines: ReadonlyArray<{ readonly path: string; readonly line: string }>,
) =>
  [...lines]
    .sort((left, right) => byteOrder(left.path, right.path))
    .map(({ line }) => line)
    .join("");

/** The listing a signature covers: every file but plugin.sig, by path. */
export const pluginFileListing = Effect.fn("pluginFileListing")(function* (
  files: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>,
) {
  const lines: Array<{ path: string; line: string }> = [];
  for (const { path, bytes } of files) {
    if (path === PLUGIN_SIGNATURE_FILE) continue;
    const digest = yield* Effect.promise(() =>
      crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
    );
    lines.push({ path, line: `${hex(digest)}  ${path}\n` });
  }
  return sortedListing(lines);
});

/** Checks `plugin.sig` against the plugin folder at `root` in the archive. */
export const verifyPluginSignature = Effect.fn("verifyPluginSignature")(
  function* (archive: ZipArchive, root: string) {
    const folder = yield* openBundleFolder(archive, root);
    const signatureEntry = folder.files.get(PLUGIN_SIGNATURE_FILE);
    if (signatureEntry === undefined)
      return { status: "unsigned" } satisfies PluginSignatureCheck;
    const armored = yield* archive.readText(signatureEntry, 16_384);
    if (!armored.ok)
      return { status: "invalid" } satisfies PluginSignatureCheck;
    // Symlinks never install, and an author's `git ls-files` or `find -type
    // f` listing leaves them out too.
    const entries = [...folder.files].filter(
      ([path, entry]) => path !== PLUGIN_SIGNATURE_FILE && !entry.symlink,
    );
    // Bounded before inflating anything: a small archive must not make the
    // Worker inflate gigabytes just to check a signature.
    const total = entries.reduce((sum, [, entry]) => sum + entry.size, 0);
    if (total > MAX_SIGNED_PLUGIN_BYTES)
      return { status: "invalid" } satisfies PluginSignatureCheck;
    const lines: Array<{ path: string; line: string }> = [];
    for (const [path, entry] of entries) {
      const read = yield* archive.readBytes(entry, MAX_SIGNED_PLUGIN_BYTES);
      if (!read.ok) return { status: "invalid" } satisfies PluginSignatureCheck;
      const digest = yield* Effect.promise(() =>
        crypto.subtle.digest("SHA-256", Uint8Array.from(read.bytes)),
      );
      lines.push({ path, line: `${hex(digest)}  ${path}\n` });
    }
    const listing = sortedListing(lines);
    const signer = yield* Effect.promise(() =>
      verifySshSignature(
        armored.text,
        new TextEncoder().encode(listing),
        PLUGIN_SIGNATURE_NAMESPACE,
      ),
    );
    return signer === undefined
      ? ({ status: "invalid" } satisfies PluginSignatureCheck)
      : ({
          status: "signed",
          fingerprint: signer.fingerprint,
          publicKey: signer.publicKey,
        } satisfies PluginSignatureCheck);
  },
);

/** Canonical ssh-ed25519 key lines, ignoring anything that isn't one. */
const canonicalKeys = (lines: ReadonlyArray<string>) =>
  Effect.forEach(lines, (line) =>
    canonicalizeSigningPublicKey(line).pipe(
      Effect.map(({ publicKey }) => publicKey as string),
      Effect.orElseSucceed(() => undefined),
    ),
  ).pipe(Effect.map((keys) => keys.filter((key) => key !== undefined)));

/** The keys a publisher domain lists, from DNS or GitHub; empty on failure. */
export const publisherKeys = Effect.fn("publisherKeys")(function* (
  domain: string,
) {
  const github = /^([a-z0-9-]+)\.github\.io$/.exec(domain)?.[1];
  if (github !== undefined) {
    const lines = yield* Effect.tryPromise(async () => {
      const response = await fetch(`https://github.com/${github}.keys`, {
        headers: { "user-agent": "dx-plugin-signature" },
        signal: AbortSignal.timeout(5_000),
      });
      return response.ok ? (await response.text()).split("\n") : [];
    }).pipe(Effect.orElseSucceed(() => [] as Array<string>));
    return yield* canonicalKeys(lines);
  }
  const records = yield* publisherTxtRecords(domain);
  return yield* canonicalKeys(
    records.flatMap((record) =>
      record.startsWith("dx-key=") ? [record.slice("dx-key=".length)] : [],
    ),
  );
});

/** Adds the publisher a signed plugin's name claims, when it lists the key. */
export const withPublisher = Effect.fn("withPublisher")(function* (
  name: string,
  check: PluginSignatureCheck,
) {
  if (check.status !== "signed") return check;
  const domain = pluginPublisherDomain(name);
  if (domain === undefined) return check;
  const keys = yield* publisherKeys(domain);
  return keys.includes(check.publicKey)
    ? ({ ...check, publisher: domain } satisfies PluginSignatureCheck)
    : check;
});

/** Who signed it, as the person viewing it can tell. */
export type PluginSigner =
  | { readonly kind: "you" }
  | { readonly kind: "publisher"; readonly domain: string }
  | { readonly kind: "key" };

export const describeSignature = (
  signature: PluginSignature,
  viewerFingerprints: ReadonlySet<string>,
) => ({
  fingerprint: signature.fingerprint,
  publicKey: signature.publicKey,
  // A publisher's proof outranks a key the viewer pasted into Signing Keys.
  signer: (signature.publisher !== undefined
    ? { kind: "publisher", domain: signature.publisher }
    : viewerFingerprints.has(signature.fingerprint)
      ? { kind: "you" }
      : { kind: "key" }) satisfies PluginSigner,
});

interface PluginSignaturesShape {
  /** Keeps a version's verified signature; versions are immutable. */
  readonly record: (
    pluginId: PluginId,
    version: string,
    signature: PluginSignature,
  ) => Effect.Effect<void, PersistenceUnavailable>;
  /** The active versions' signatures of these installs, by plugin ID. */
  readonly forPlugins: (
    plugins: ReadonlyArray<{
      readonly id: PluginId;
      readonly version: string;
    }>,
  ) => Effect.Effect<
    ReadonlyMap<string, PluginSignature>,
    PersistenceUnavailable
  >;
  /** Fingerprints of a person's active Signing Keys page keys. */
  /** `forPlugins` for every install's active version of a target. */
  readonly forTarget: (target: {
    readonly scope: string;
    readonly id: string;
  }) => Effect.Effect<
    ReadonlyMap<string, PluginSignature>,
    PersistenceUnavailable
  >;
  readonly ownFingerprints: (
    userId: string,
  ) => Effect.Effect<ReadonlySet<string>, PersistenceUnavailable>;
}

export class PluginSignatures extends Context.Service<
  PluginSignatures,
  PluginSignaturesShape
>()("@dx/core/settings/plugins/PluginSignatures") {}

const unavailable = (operation: string) => (cause: unknown) =>
  PersistenceUnavailable.new({ operation }, cause);

export const PluginSignaturesD1 = (db: D1Database) =>
  Layer.succeed(
    PluginSignatures,
    PluginSignatures.of({
      record: (pluginId, version, signature) =>
        Effect.tryPromise({
          try: () =>
            db
              .prepare(
                `INSERT OR IGNORE INTO plugin_version_signature
                   (plugin_id, version, fingerprint, public_key, publisher, verified_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
              )
              .bind(
                pluginId,
                version,
                signature.fingerprint,
                signature.publicKey,
                signature.publisher ?? null,
                new Date().toISOString(),
              )
              .run(),
          catch: unavailable("pluginSignature.record"),
        }).pipe(Effect.asVoid),
      forTarget: (target) =>
        Effect.tryPromise({
          try: async () => {
            const rows = await db
              .prepare(
                `SELECT signature.plugin_id, signature.fingerprint,
                        signature.public_key, signature.publisher
                   FROM plugin_version_signature signature
                   JOIN trusted_plugin plugin
                     ON plugin.id = signature.plugin_id
                    AND plugin.active_version = signature.version
                  WHERE plugin.scope = ?1 AND plugin.target_id = ?2`,
              )
              .bind(target.scope, target.id)
              .all<{
                plugin_id: string;
                fingerprint: string;
                public_key: string;
                publisher: string | null;
              }>();
            return new Map(
              rows.results.map((row) => [
                row.plugin_id,
                {
                  fingerprint: row.fingerprint,
                  publicKey: row.public_key,
                  ...(row.publisher === null
                    ? {}
                    : { publisher: row.publisher }),
                } satisfies PluginSignature,
              ]),
            );
          },
          catch: unavailable("pluginSignature.forTarget"),
        }),
      forPlugins: (plugins) =>
        plugins.length === 0
          ? Effect.succeed(new Map())
          : Effect.tryPromise({
              try: async () => {
                const rows = await db
                  .prepare(
                    `SELECT signature.plugin_id, signature.fingerprint,
                            signature.public_key, signature.publisher
                       FROM plugin_version_signature signature
                       JOIN json_each(?) wanted
                         ON signature.plugin_id = json_extract(wanted.value, '$.id')
                        AND signature.version = json_extract(wanted.value, '$.version')`,
                  )
                  .bind(
                    JSON.stringify(
                      plugins.map(({ id, version }) => ({ id, version })),
                    ),
                  )
                  .all<{
                    plugin_id: string;
                    fingerprint: string;
                    public_key: string;
                    publisher: string | null;
                  }>();
                return new Map(
                  rows.results.map((row) => [
                    row.plugin_id,
                    {
                      fingerprint: row.fingerprint,
                      publicKey: row.public_key,
                      ...(row.publisher === null
                        ? {}
                        : { publisher: row.publisher }),
                    } satisfies PluginSignature,
                  ]),
                );
              },
              catch: unavailable("pluginSignature.forPlugins"),
            }),
      ownFingerprints: (userId) =>
        Effect.tryPromise({
          try: async () =>
            new Set(
              (
                await db
                  .prepare(
                    `SELECT fingerprint FROM personal_signing_key
                      WHERE user_id = ?1 AND status = 'active'
                     UNION
                     SELECT fingerprint FROM personal_verification_key
                      WHERE user_id = ?1 AND status = 'active'`,
                  )
                  .bind(userId)
                  .all<{ fingerprint: string }>()
              ).results.map(({ fingerprint }) => fingerprint),
            ),
          catch: unavailable("pluginSignature.ownFingerprints"),
        }),
    }),
  );

/** A preview's verified signature, as the viewer can tell its signer. */
export const previewSignature = Effect.fn("pluginPreviewSignature")(function* (
  check: PluginSignatureCheck,
  viewerUserId: string,
) {
  if (check.status !== "signed") return {};
  const own = yield* (yield* PluginSignatures).ownFingerprints(viewerUserId);
  return { signature: describeSignature(check, own) };
});

/**
 * Signs an export with the person's managed key from Settings → Signing
 * Keys, so a plugin written in dx installs elsewhere as signed by them.
 */
export const managedPluginSigner = Effect.fn("managedPluginSigner")(function* (
  bindings: Bindings,
  db: D1Database,
  userId: UserId,
) {
  const refuse = (reason: string) => new PluginBundleRejected({ reason });
  const keyring = yield* requireManagedSigning(bindings).pipe(
    Effect.mapError(() =>
      refuse(
        "This dx deployment doesn't keep signing keys, so it can't sign exports.",
      ),
    ),
  );
  const stored = yield* Effect.gen(function* () {
    return yield* (yield* SigningKeyRepository).findActiveManaged(userId);
  }).pipe(
    Effect.provide(SigningKeyRepositoryD1(db)),
    Effect.mapError(() =>
      refuse("dx could not read your signing key. Try again."),
    ),
  );
  if (stored === undefined)
    return yield* refuse(
      "Create a dx signing key in Settings → Signing Keys to sign exports.",
    );
  const privateKey = yield* decryptSigningPrivateKey(
    keyring,
    {
      id: stored.id,
      userId: stored.userId,
      publicKey: stored.publicKey,
      fingerprint: stored.fingerprint,
    },
    stored.privateKeyEnvelope,
  ).pipe(
    Effect.mapError(() => refuse("dx could not unlock your signing key.")),
  );
  return (files: ReadonlyArray<ZipFile>) =>
    Effect.gen(function* () {
      const listing = yield* pluginFileListing(
        files.map(({ path, content }) => ({
          path,
          bytes:
            typeof content === "string"
              ? new TextEncoder().encode(content)
              : content,
        })),
      );
      return yield* Effect.tryPromise({
        try: () =>
          signSshPayload(
            privateKey,
            stored.publicKey,
            new TextEncoder().encode(listing),
            PLUGIN_SIGNATURE_NAMESPACE,
          ),
        catch: () => refuse("dx could not sign the export. Try again."),
      });
    });
});
