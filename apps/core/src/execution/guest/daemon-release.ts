import { Config, ConfigProvider, Effect, Schema } from "effect";
import type { Bindings } from "../../http/types.js";

const MAX_RELEASE_BYTES = 32 * 1024 * 1024;
const Sha256 = Schema.String.check(
  Schema.isMinLength(64),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[0-9a-f]{64}$/),
);

const releaseConfiguration = Config.all({
  url: Config.string("DX_DXD_RELEASE_URL"),
  sha256: Config.string("DX_DXD_RELEASE_SHA256"),
});

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");

export const loadDaemonReleaseMetadata = (bindings: Bindings) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const value = yield* releaseConfiguration.parse(
        ConfigProvider.fromUnknown(bindings),
      );
      const sha256 = yield* Schema.decodeEffect(Sha256)(value.sha256);
      return { url: value.url, sha256 };
    }),
  );

export const loadDaemonRelease = async (
  bindings: Bindings,
  fetchRelease: typeof fetch = fetch,
) => {
  const configured = await loadDaemonReleaseMetadata(bindings);
  const response = await fetchRelease(configured.url);
  if (!response.ok) throw new Error("Daemon release download failed.");
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RELEASE_BYTES)
    throw new Error("Daemon release exceeds its size limit.");
  const reader = response.body?.getReader();
  if (reader === undefined) throw new Error("Daemon release has no body.");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    length += next.value.byteLength;
    if (length > MAX_RELEASE_BYTES) {
      await reader.cancel();
      throw new Error("Daemon release exceeds its size limit.");
    }
    chunks.push(next.value);
  }
  const binary = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    binary.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const actual = hex(await crypto.subtle.digest("SHA-256", binary));
  if (actual !== configured.sha256)
    throw new Error("Daemon release checksum mismatch.");
  return { binary, sha256: configured.sha256 };
};
