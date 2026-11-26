import { sameOriginFetch } from "../../../shared/same-origin-fetch.js";
import type { LiveDictation } from "./dictation-stream.js";

/**
 * The live session's transcript when it has one; otherwise the recording is
 * uploaded and transcribed in one request.
 */
export const runDictation = async ({
  audio,
  id,
  live,
  signal,
}: {
  readonly audio: Blob;
  readonly id: string;
  readonly live?: LiveDictation;
  readonly signal: AbortSignal;
}) => {
  const streamed = await live?.finish(signal);
  signal.throwIfAborted();
  if (streamed !== undefined) {
    if (!streamed.trim()) throw new Error("Dictation returned no speech.");
    return streamed;
  }
  const deadline = AbortSignal.timeout(59 * 60 * 1_000);
  const combined = AbortSignal.any([signal, deadline]);
  const requests = await import("./dictation-mutations.js");
  let job = await requests.createDictation(id, audio, combined);
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
    job = await requests.readDictation(id, combined);
  }
  if (job.state === "failed") throw new Error(job.error);
  if (!job.text.trim()) throw new Error("Dictation returned no speech.");
  return job.text;
};

// Answers 204 without a body, which `dxClient.call` cannot read yet; the
// route stays legacy until it can.
export const cancelDictationJob = (id: string) =>
  sameOriginFetch(`/v1/dictation/${encodeURIComponent(id)}`, {
    method: "DELETE",
  }).catch(() => undefined);

export const dictationMutationOptions = () => ({
  mutationFn: runDictation,
  gcTime: 0,
});
