import {
  DictationErrorSchema,
  type DictationJob,
  DictationJobSchema,
} from "@dx/api";
import { Option, Schema } from "effect";
import { sameOriginFetch } from "../../../shared/same-origin-fetch.js";

const decodeJob = Schema.decodeUnknownPromise(DictationJobSchema);

const readJob = async (response: Response): Promise<DictationJob> => {
  if (!response.ok) {
    const failure = Schema.decodeUnknownOption(DictationErrorSchema)(
      await response.json().catch(() => undefined),
    );
    throw new Error(
      Option.isSome(failure)
        ? failure.value.error
        : "Dictation could not be completed.",
    );
  }
  const body: unknown = await response.json().catch(() => undefined);
  return decodeJob(body).catch(() => {
    throw new Error("Dictation returned an invalid response.");
  });
};

export const runDictation = async ({
  audio,
  id,
  signal,
}: {
  readonly audio: Blob;
  readonly id: string;
  readonly signal: AbortSignal;
}) => {
  const deadline = AbortSignal.timeout(59 * 60 * 1_000);
  const combined = AbortSignal.any([signal, deadline]);
  let job = await readJob(
    await sameOriginFetch(`/v1/dictation/${encodeURIComponent(id)}`, {
      method: "POST",
      body: audio,
      headers: { "content-type": "audio/wav", accept: "application/json" },
      signal: combined,
    }),
  );
  while (job.state === "processing") {
    await new Promise<void>((resolve, reject) => {
      combined.throwIfAborted();
      const timer = window.setTimeout(() => {
        combined.removeEventListener("abort", abort);
        resolve();
      }, 3_000);
      const abort = () => {
        clearTimeout(timer);
        reject(combined.reason);
      };
      combined.addEventListener("abort", abort, { once: true });
    });
    job = await readJob(
      await sameOriginFetch(`/v1/dictation/${encodeURIComponent(id)}`, {
        headers: { accept: "application/json" },
        signal: combined,
      }),
    );
  }
  if (job.state === "failed") throw new Error(job.error);
  if (!job.text.trim()) throw new Error("Dictation returned no speech.");
  return job.text;
};

export const cancelDictationJob = (id: string) =>
  sameOriginFetch(`/v1/dictation/${encodeURIComponent(id)}`, {
    method: "DELETE",
  }).catch(() => undefined);

export const dictationMutationOptions = () => ({
  mutationFn: runDictation,
  gcTime: 0,
});
