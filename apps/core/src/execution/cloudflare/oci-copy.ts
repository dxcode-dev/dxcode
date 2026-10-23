/**
 * Copies one linux/amd64 image from a public registry (the public Orb
 * image on GHCR) into a Cloudflare account's container registry, with the
 * OCI distribution API over `fetch`. A `durable_object` container may only
 * start from a digest-pinned image in its own account's registry, and
 * Cloudflare offers no server-side import.
 *
 * The copy runs in steps so that each fits one preparation alarm: a step
 * reads the source manifest once, then streams blobs in chunks, resuming
 * an upload where the last step stopped. Blobs the account already has are
 * skipped, so copying a new image version moves only changed layers.
 */

export interface OciImageSource {
  /** Registry host, e.g. `ghcr.io`. */
  readonly registry: string;
  /** Repository, e.g. `dxcode-dev/dx-orb`. */
  readonly repository: string;
  /** A tag or `sha256:` digest; an index resolves to its linux/amd64 image. */
  readonly reference: string;
}

export interface OciDestination {
  /** `registry.cloudflare.com` */
  readonly registry: string;
  /** `<account ID>/<name>` */
  readonly repository: string;
  /** Basic credentials for push and pull. */
  readonly username: string;
  readonly password: string;
}

interface Blob {
  readonly digest: string;
  readonly size: number;
}

/** Where a copy stands, kept in the connection's preparation state. */
export interface OciCopyState {
  /** The linux/amd64 manifest's digest; the copied image's reference. */
  readonly manifestDigest: string;
  readonly manifestMediaType: string;
  /** The manifest's exact bytes, so its digest holds at the destination. */
  readonly manifest: string;
  readonly blobs: ReadonlyArray<Blob>;
  /** Blobs before this index are in the destination. */
  readonly next: number;
  /** The upload in progress for `blobs[next]`. */
  readonly upload?: { readonly location: string; readonly offset: number };
  /** The manifest is pushed: the copy is done. */
  readonly pushed: boolean;
}

const MANIFEST_TYPES = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
];
const INDEX_TYPES = new Set(MANIFEST_TYPES.slice(0, 2));
/** Chunk size when the registry names no bounds (Cloudflare's: 5–100 MB). */
const DEFAULT_CHUNK_BYTES = 64 * 1024 * 1024;
/** A step stops starting new chunks after this long. */
const STEP_BUDGET_MS = 60_000;

export class OciCopyFailed extends Error {}

const sha256 = async (text: string) =>
  `sha256:${[
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;

type Fetch = typeof fetch;

/** An anonymous pull token, for registries that ask for one (GHCR). */
const sourceAuthorization = async (
  send: Fetch,
  source: OciImageSource,
): Promise<string | undefined> => {
  const probe = await send(
    `https://${source.registry}/v2/${source.repository}/manifests/${source.reference}`,
    { method: "HEAD", headers: { accept: MANIFEST_TYPES.join(", ") } },
  );
  if (probe.status !== 401) return undefined;
  const challenge = probe.headers.get("www-authenticate") ?? "";
  const realm = /realm="([^"]+)"/.exec(challenge)?.[1];
  const service = /service="([^"]+)"/.exec(challenge)?.[1];
  if (realm === undefined)
    throw new OciCopyFailed("The Orb image registry asked for credentials.");
  const url = new URL(realm);
  if (service !== undefined) url.searchParams.set("service", service);
  url.searchParams.set("scope", `repository:${source.repository}:pull`);
  const response = await send(url);
  const body = (await response.json().catch(() => ({}))) as {
    readonly token?: string;
    readonly access_token?: string;
  };
  const token = body.token ?? body.access_token;
  if (!response.ok || token === undefined)
    throw new OciCopyFailed(
      "The Orb image registry refused an anonymous pull.",
    );
  return `Bearer ${token}`;
};

const sourceGet = async (
  send: Fetch,
  source: OciImageSource,
  authorization: string | undefined,
  path: string,
  headers: Record<string, string> = {},
) => {
  const response = await send(
    `https://${source.registry}/v2/${source.repository}/${path}`,
    {
      headers: {
        ...headers,
        ...(authorization === undefined ? {} : { authorization }),
      },
      redirect: "manual",
    },
  );
  // Blob downloads redirect to signed storage URLs, fetched without the
  // registry token.
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("location");
    if (location === null) throw new OciCopyFailed("A blob redirect failed.");
    return send(new URL(location, response.url || undefined), { headers });
  }
  return response;
};

/** Reads the source's linux/amd64 manifest and the blobs it names. */
export const startOciCopy = async (
  source: OciImageSource,
  send: Fetch = fetch,
): Promise<OciCopyState> => {
  const authorization = await sourceAuthorization(send, source);
  const read = async (reference: string) => {
    const response = await sourceGet(
      send,
      source,
      authorization,
      `manifests/${reference}`,
      { accept: MANIFEST_TYPES.join(", ") },
    );
    if (!response.ok)
      throw new OciCopyFailed(
        `The Orb image manifest is unavailable (${response.status}).`,
      );
    const text = await response.text();
    const mediaType =
      (JSON.parse(text) as { readonly mediaType?: string }).mediaType ??
      response.headers.get("content-type")?.split(";")[0] ??
      "";
    return { text, mediaType };
  };
  let manifest = await read(source.reference);
  if (INDEX_TYPES.has(manifest.mediaType)) {
    const index = JSON.parse(manifest.text) as {
      readonly manifests: ReadonlyArray<{
        readonly digest: string;
        readonly platform?: {
          readonly os?: string;
          readonly architecture?: string;
        };
      }>;
    };
    const image = index.manifests.find(
      ({ platform }) =>
        platform?.os === "linux" && platform.architecture === "amd64",
    );
    if (image === undefined)
      throw new OciCopyFailed("The Orb image has no linux/amd64 build.");
    manifest = await read(image.digest);
  }
  const parsed = JSON.parse(manifest.text) as {
    readonly config: Blob;
    readonly layers: ReadonlyArray<Blob>;
  };
  return {
    manifestDigest: await sha256(manifest.text),
    manifestMediaType: manifest.mediaType,
    manifest: manifest.text,
    blobs: [parsed.config, ...parsed.layers].map(({ digest, size }) => ({
      digest,
      size,
    })),
    next: 0,
    pushed: false,
  };
};

const destinationHeaders = (destination: OciDestination) => ({
  authorization: `Basic ${btoa(`${destination.username}:${destination.password}`)}`,
});

const destinationUrl = (destination: OciDestination, path: string) =>
  `https://${destination.registry}/v2/${destination.repository}/${path}`;

/** Streams `length` bytes of the source into a request body of that length. */
const fixedLength = (body: ReadableStream<Uint8Array>, length: number) => {
  const stream = new FixedLengthStream(length);
  void body.pipeTo(stream.writable);
  return stream.readable;
};

/**
 * Copies blobs and finally pushes the manifest, until the copy is done or
 * this step's time is up. Returns the state to resume from.
 */
export const advanceOciCopy = async (
  source: OciImageSource,
  destination: OciDestination,
  state: OciCopyState,
  send: Fetch = fetch,
  now: () => number = Date.now,
): Promise<OciCopyState> => {
  const started = now();
  const authorization = await sourceAuthorization(send, source);
  const auth = destinationHeaders(destination);
  let current = state;
  while (current.next < current.blobs.length) {
    if (now() - started > STEP_BUDGET_MS) return current;
    const blob = current.blobs[current.next] as Blob;
    let upload: OciCopyState["upload"] = current.upload;
    if (upload === undefined) {
      const exists = await send(
        destinationUrl(destination, `blobs/${blob.digest}`),
        {
          method: "HEAD",
          headers: auth,
        },
      );
      if (exists.ok) {
        current = { ...current, next: current.next + 1 };
        continue;
      }
      const opened = await send(destinationUrl(destination, "blobs/uploads/"), {
        method: "POST",
        headers: auth,
      });
      const location = opened.headers.get("location");
      if (opened.status !== 202 || location === null)
        throw new OciCopyFailed(
          `Your Cloudflare registry refused an upload (${opened.status}).`,
        );
      upload = {
        location: new URL(
          location,
          `https://${destination.registry}`,
        ).toString(),
        offset: 0,
      };
      current = { ...current, upload };
    }
    while (upload.offset < blob.size) {
      if (now() - started > STEP_BUDGET_MS) return { ...current, upload };
      const end: number =
        Math.min(blob.size, upload.offset + DEFAULT_CHUNK_BYTES) - 1;
      const length = end - upload.offset + 1;
      const chunk = await sourceGet(
        send,
        source,
        authorization,
        `blobs/${blob.digest}`,
        { range: `bytes=${upload.offset}-${end}` },
      );
      if ((chunk.status !== 206 && chunk.status !== 200) || chunk.body === null)
        throw new OciCopyFailed(
          `The Orb image blob is unavailable (${chunk.status}).`,
        );
      if (chunk.status === 200 && (upload.offset !== 0 || length !== blob.size))
        throw new OciCopyFailed("The Orb image registry ignored a range read.");
      const patched: Response = await send(upload.location, {
        method: "PATCH",
        headers: {
          ...auth,
          "content-type": "application/octet-stream",
          "content-range": `${upload.offset}-${end}`,
        },
        body: fixedLength(chunk.body, length),
      });
      const location: string | null = patched.headers.get("location");
      if (patched.status !== 202 || location === null)
        throw new OciCopyFailed(
          `Your Cloudflare registry refused an image chunk (${patched.status}).`,
        );
      upload = {
        location: new URL(location, upload.location).toString(),
        offset: end + 1,
      };
      current = { ...current, upload };
    }
    const finish = new URL(upload.location);
    finish.searchParams.set("digest", blob.digest);
    const finished = await send(finish, {
      method: "PUT",
      headers: { ...auth, "content-length": "0" },
    });
    if (finished.status !== 201)
      throw new OciCopyFailed(
        `Your Cloudflare registry refused an image blob (${finished.status}).`,
      );
    const { upload: _done, ...rest } = current;
    current = { ...rest, next: current.next + 1 };
  }
  if (!current.pushed) {
    const pushed = await send(
      destinationUrl(destination, `manifests/${current.manifestDigest}`),
      {
        method: "PUT",
        headers: { ...auth, "content-type": current.manifestMediaType },
        body: current.manifest,
      },
    );
    if (pushed.status !== 201)
      throw new OciCopyFailed(
        `Your Cloudflare registry refused the Orb image (${pushed.status}).`,
      );
    current = { ...current, pushed: true };
  }
  return current;
};
