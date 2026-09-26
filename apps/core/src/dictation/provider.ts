import { Effect, Option, Schema } from "effect";
import { SarvamAIClient } from "sarvamai";

const SDK_TIMEOUT_MILLIS = 30_000;
const MAX_TRANSCRIPT_BYTES = 256 * 1024;
const INPUT_FILENAME = "dictation.wav";
const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

type ProviderOptions = {
  readonly fetch?: typeof fetch;
  readonly signal?: AbortSignal;
};

const runtimeFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, init);

export class DictationProviderError extends Schema.TaggedError<DictationProviderError>()(
  "DictationProviderError",
  { reason: Schema.String },
) {}

const fail = (reason: string) => new DictationProviderError({ reason });

const validIdentifier = (value: unknown): value is string =>
  typeof value === "string" && identifier.test(value);

const signedUrl = (value: unknown): string => {
  if (typeof value !== "object" || value === null)
    throw fail("Invalid provider response");
  const candidate =
    (value as { file_url?: unknown; url?: unknown }).file_url ??
    (value as { url?: unknown }).url;
  if (typeof candidate !== "string") throw fail("Invalid provider response");
  const url = new URL(candidate);
  // Sarvam currently issues Azure Blob SAS URLs. This intentionally permits any
  // Azure public blob account, rather than claiming a fixed provider host allowlist.
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    !url.hostname.endsWith(".blob.core.windows.net")
  )
    throw fail("Invalid provider response");
  return url.href;
};

const providerFetch = (fetchImpl: typeof fetch): typeof fetch =>
  ((input: RequestInfo | URL, init?: RequestInit) => {
    const workerInit = { ...init, redirect: "manual" } as RequestInit & {
      duplex?: unknown;
    };
    delete workerInit.duplex;
    return fetchImpl(input, workerInit);
  }) as typeof fetch;

const requestSignal = (effectSignal: AbortSignal, supplied?: AbortSignal) =>
  supplied ? AbortSignal.any([effectSignal, supplied]) : effectSignal;

const requestFailure = (cause: unknown) => {
  const statusCode =
    typeof cause === "object" && cause !== null && "statusCode" in cause
      ? (cause as { statusCode?: unknown }).statusCode
      : undefined;
  const message =
    cause instanceof Error
      ? cause.message
          .replaceAll(/https?:\/\/\S+/g, "[url]")
          .replaceAll(/[A-Za-z0-9_-]{24,}/g, "[value]")
          .slice(0, 200)
      : "";
  return fail(
    typeof statusCode === "number"
      ? `Provider request failed (${statusCode})`
      : `Provider request failed (${cause instanceof Error ? cause.name : "unknown"}${message ? `: ${message}` : ""})`,
  );
};

const attempt = <A>(work: (signal: AbortSignal) => PromiseLike<A>) =>
  Effect.tryPromise({
    try: work,
    catch: requestFailure,
  });

const clientFor = (secret: string, options: ProviderOptions) => {
  if (secret.length === 0) throw fail("Provider key is unavailable");
  return new SarvamAIClient({
    apiSubscriptionKey: secret,
    maxRetries: 0,
    timeoutInSeconds: SDK_TIMEOUT_MILLIS / 1000,
    fetch: providerFetch(options.fetch ?? runtimeFetch),
  });
};

export function dispatchSarvam(
  secret: string,
  wav: Uint8Array,
  providerJobCreated: (jobId: string) => Promise<boolean>,
  providerJobActive: (jobId: string) => Promise<boolean>,
  options: ProviderOptions = {},
): Effect.Effect<string, DictationProviderError> {
  return Effect.fn("dispatchSarvam")(function* () {
    const client = clientFor(secret, options);
    const initial = yield* attempt((signal) =>
      client.speechToTextJob.initialise(
        {
          job_parameters: {
            model: "saaras:v3",
            mode: "translate",
            language_code: "unknown",
          },
        },
        { abortSignal: requestSignal(signal, options.signal), maxRetries: 0 },
      ),
    );
    if (!validIdentifier(initial.job_id))
      yield* Effect.fail(fail("Invalid provider response"));
    const jobId = initial.job_id;
    if (!(yield* attempt(() => providerJobCreated(jobId))))
      yield* Effect.fail(fail("Dictation was canceled"));

    const links = yield* attempt((signal) =>
      client.speechToTextJob.getUploadLinks(
        { job_id: jobId, files: [INPUT_FILENAME] },
        { abortSignal: requestSignal(signal, options.signal), maxRetries: 0 },
      ),
    );
    if (!(yield* attempt(() => providerJobActive(jobId))))
      yield* Effect.fail(fail("Dictation was canceled"));
    const upload = signedUrl(links.upload_urls?.[INPUT_FILENAME]);
    const response = yield* attempt((signal) =>
      (options.fetch ?? runtimeFetch)(upload, {
        method: "PUT",
        body: wav.slice().buffer as ArrayBuffer,
        redirect: "manual",
        headers: {
          "content-type": "audio/wav",
          "x-ms-blob-type": "BlockBlob",
        },
        signal: requestSignal(signal, options.signal),
      }),
    );
    if (!response.ok) yield* Effect.fail(fail("Provider transfer failed"));
    if (!(yield* attempt(() => providerJobActive(jobId))))
      yield* Effect.fail(fail("Dictation was canceled"));
    yield* attempt((signal) =>
      client.speechToTextJob.start(
        jobId,
        {},
        { maxRetries: 0, abortSignal: requestSignal(signal, options.signal) },
      ),
    );
    return jobId;
  })();
}

export function pollSarvam(
  secret: string,
  jobId: string,
  options: ProviderOptions = {},
): Effect.Effect<
  "processing" | { text: string } | "failed",
  DictationProviderError
> {
  return Effect.fn("pollSarvam")(function* () {
    if (!validIdentifier(jobId))
      yield* Effect.fail(fail("Invalid provider job id"));
    const client = clientFor(secret, options);
    const status = yield* attempt((signal) =>
      client.speechToTextJob.getStatus(jobId, {
        abortSignal: requestSignal(signal, options.signal),
        maxRetries: 0,
      }),
    );
    if (
      ["Accepted", "Pending", "Running", "InProgress"].includes(
        status.job_state as string,
      )
    )
      return "processing" as const;
    if (
      (status.job_state as string) !== "Completed" ||
      !Array.isArray(status.job_details)
    )
      return "failed" as const;

    const matching = status.job_details.filter(
      (detail) =>
        detail.state === "Success" &&
        detail.inputs?.some((input) => input.file_name === INPUT_FILENAME),
    );
    const outputs = matching[0]?.outputs;
    if (
      matching.length !== 1 ||
      outputs?.length !== 1 ||
      !validIdentifier(outputs[0]?.file_name)
    )
      return "failed" as const;
    const filename = outputs[0].file_name;
    const links = yield* attempt((signal) =>
      client.speechToTextJob.getDownloadLinks(
        { job_id: jobId, files: [filename] },
        { abortSignal: requestSignal(signal, options.signal), maxRetries: 0 },
      ),
    );
    let download: string;
    try {
      download = signedUrl(links.download_urls?.[filename]);
    } catch {
      return "failed" as const;
    }
    const response = yield* attempt((signal) =>
      (options.fetch ?? runtimeFetch)(download, {
        redirect: "manual",
        signal: requestSignal(signal, options.signal),
      }),
    );
    if (!response.ok || !response.body) return "failed" as const;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const chunk = yield* attempt((signal) => {
        const abort = () => void reader.cancel().catch(() => undefined);
        signal.addEventListener("abort", abort, { once: true });
        return reader
          .read()
          .finally(() => signal.removeEventListener("abort", abort));
      });
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_TRANSCRIPT_BYTES) {
        yield* attempt(() => reader.cancel());
        return "failed" as const;
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return "failed" as const;
    }
    const decoded = Schema.decodeUnknownOption(
      Schema.Struct({ transcript: Schema.NonEmptyString }),
    )(body);
    return Option.isNone(decoded)
      ? ("failed" as const)
      : { text: decoded.value.transcript };
  })();
}
