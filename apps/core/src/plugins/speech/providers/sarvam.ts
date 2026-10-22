import {
  DICTATION_VOCABULARY_MAX_TERM_LENGTH,
  DICTATION_VOCABULARY_MAX_TERMS,
  type SpeechOptions,
  type SpeechProvider,
  SpeechProviderError,
  type SpeechSession,
} from "@dx/domain";
import { Option, Redacted, Schema } from "effect";

const API = "https://api.sarvam.ai";
// `saaras:v4` is the model that accepts `keyterms`.
const MODEL = "saaras:v4";
// Translate mode turns any spoken language into English text.
const MODE = "translate";
const BYTES_PER_SECOND = 32_000;
/** Sarvam's synchronous API rejects audio longer than 30 seconds. */
const MAX_CHUNK_BYTES = 29 * BYTES_PER_SECOND;
/** A long recording is cut at its quietest 50 ms in the last 4 s of a chunk. */
const CUT_SEARCH_BYTES = 4 * BYTES_PER_SECOND;
const CUT_FRAME_BYTES = 1_600;
/** Shorter than Sarvam's voice detection reacts to, so never speech. */
const MIN_CHUNK_BYTES = BYTES_PER_SECOND / 4;
const PARALLEL_CHUNKS = 4;
const REQUEST_TIMEOUT_MILLIS = 30_000;
/**
 * Sarvam's voice detection reports speech about 300 ms after it starts. After
 * the flush, a session waits this long for speech it has not reported yet.
 */
const SETTLE_QUIET_MILLIS = 350;
const FINISH_TIMEOUT_MILLIS = 8_000;

const fail = (reason: string) => new SpeechProviderError({ reason });

/**
 * The vocabulary as Sarvam's `keyterms`: a JSON array of at most 50 terms of
 * at most 64 characters, which both APIs reject otherwise. Undefined when
 * there is nothing to bias toward.
 */
const keytermsOf = (vocabulary: SpeechOptions["vocabulary"]) => {
  const terms = (vocabulary ?? [])
    .map((term) => term.trim())
    .filter(
      (term) =>
        term.length > 0 && term.length <= DICTATION_VOCABULARY_MAX_TERM_LENGTH,
    )
    .slice(0, DICTATION_VOCABULARY_MAX_TERMS);
  return terms.length === 0 ? undefined : JSON.stringify(terms);
};

const runtimeFetch: typeof fetch = (input, init) =>
  globalThis.fetch(input, init);

const TranscriptResponse = Schema.Struct({ transcript: Schema.String });
const decodeTranscript = Schema.decodeUnknownOption(TranscriptResponse);

const StreamMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("data"),
    data: Schema.Struct({ transcript: Schema.String }),
  }),
  Schema.Struct({
    type: Schema.Literal("events"),
    data: Schema.Struct({ signal_type: Schema.optional(Schema.String) }),
  }),
  Schema.Struct({ type: Schema.Literal("error") }),
]);
const decodeStreamMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(StreamMessage),
);

const wavOf = (pcm: Uint8Array) => {
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1)
      wav[offset + index] = value.charCodeAt(index);
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, BYTES_PER_SECOND, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  return wav;
};

/**
 * Splits PCM into chunks Sarvam's synchronous API accepts, cutting each at
 * its quietest frame so a word is rarely split.
 */
export const splitAtQuietPoints = (pcm: Uint8Array): Uint8Array[] => {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const chunks: Uint8Array[] = [];
  let start = 0;
  while (pcm.byteLength - start > MAX_CHUNK_BYTES) {
    const limit = start + MAX_CHUNK_BYTES;
    let cut = limit;
    let quietest = Number.POSITIVE_INFINITY;
    for (
      let frame = limit - CUT_SEARCH_BYTES;
      frame + CUT_FRAME_BYTES <= limit;
      frame += CUT_FRAME_BYTES
    ) {
      let energy = 0;
      for (let at = frame; at < frame + CUT_FRAME_BYTES; at += 2)
        energy += view.getInt16(at, true) ** 2;
      if (energy < quietest) {
        quietest = energy;
        cut = frame + CUT_FRAME_BYTES / 2;
      }
    }
    chunks.push(pcm.subarray(start, cut));
    start = cut;
  }
  chunks.push(pcm.subarray(start));
  return chunks.filter((chunk) => chunk.byteLength >= MIN_CHUNK_BYTES);
};

const requestFailure = (cause: unknown) =>
  cause instanceof SpeechProviderError
    ? cause
    : fail(
        `Provider request failed (${cause instanceof Error ? cause.name : "unknown"})`,
      );

const transcribeChunk = async (
  key: string,
  transport: typeof fetch,
  pcm: Uint8Array,
  keyterms: string | undefined,
  signal: AbortSignal,
) => {
  const form = new FormData();
  form.append(
    "file",
    new Blob([wavOf(pcm)], { type: "audio/wav" }),
    "dictation.wav",
  );
  form.append("model", MODEL);
  form.append("mode", MODE);
  if (keyterms !== undefined) form.append("keyterms", keyterms);
  const response = await transport(`${API}/speech-to-text`, {
    method: "POST",
    headers: { "api-subscription-key": key },
    body: form,
    redirect: "manual",
    signal: AbortSignal.any([
      signal,
      AbortSignal.timeout(REQUEST_TIMEOUT_MILLIS),
    ]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw fail(`Provider request failed (${response.status})`);
  }
  const decoded = decodeTranscript(await response.json().catch(() => null));
  if (Option.isNone(decoded)) throw fail("Invalid provider response");
  return decoded.value.transcript.trim();
};

const transcribeRecording = async (
  key: string,
  transport: typeof fetch,
  wav: Uint8Array,
  { signal = new AbortController().signal, vocabulary }: SpeechOptions = {},
) => {
  const keyterms = keytermsOf(vocabulary);
  const chunks = splitAtQuietPoints(wav.subarray(44));
  const transcripts: string[] = Array(chunks.length).fill("");
  const failed = new AbortController();
  const combined = AbortSignal.any([signal, failed.signal]);
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const index = next++;
      transcripts[index] = await transcribeChunk(
        key,
        transport,
        chunks[index] as Uint8Array,
        keyterms,
        combined,
      );
    }
  };
  try {
    await Promise.all(
      Array.from({ length: Math.min(PARALLEL_CHUNKS, chunks.length) }, () =>
        worker().catch((cause: unknown) => {
          failed.abort();
          throw cause;
        }),
      ),
    );
  } catch (cause) {
    throw requestFailure(cause);
  }
  return transcripts.filter(Boolean).join(" ");
};

const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let at = 0; at < bytes.byteLength; at += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
};

const streamQuery = (vocabulary: SpeechOptions["vocabulary"]) => {
  const query = new URLSearchParams({
    "language-code": "unknown",
    model: MODEL,
    mode: MODE,
    sample_rate: "16000",
    input_audio_codec: "pcm_s16le",
    vad_signals: "true",
    flush_signal: "true",
  });
  const keyterms = keytermsOf(vocabulary);
  if (keyterms !== undefined) query.set("keyterms", keyterms);
  return query.toString();
};

/**
 * One Sarvam streaming session. Sarvam's voice detection reports each
 * stretch of speech (`START_SPEECH`, `END_SPEECH`) and sends its transcript
 * once the speech ends, so most of the text is ready before the user stops.
 * `finish` flushes and resolves once every reported stretch has its
 * transcript and no new speech was reported within the quiet window.
 */
const openSarvamSession = (
  key: string,
  transport: typeof fetch,
  { signal, vocabulary }: SpeechOptions = {},
): SpeechSession => {
  const queued: string[] = [];
  const transcripts: string[] = [];
  const closer = new AbortController();
  let socket: WebSocket | undefined;
  let broken: SpeechProviderError | undefined;
  let speaking = false;
  let ended = 0;
  let received = 0;
  let flushedAt: number | undefined;
  let speakingAtFlush = false;
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let finishing:
    | {
        readonly resolve: (text: string) => void;
        readonly reject: (error: SpeechProviderError) => void;
      }
    | undefined;

  const release = () => {
    clearTimeout(quietTimer);
    clearTimeout(deadline);
    closer.abort();
    const open = socket;
    socket = undefined;
    try {
      open?.close(1000, "done");
    } catch {}
  };
  const breakWith = (error: SpeechProviderError) => {
    broken ??= error;
    const waiting = finishing;
    finishing = undefined;
    release();
    waiting?.reject(broken);
  };
  const deliver = (message: string) => {
    if (broken) return;
    if (socket) socket.send(message);
    else queued.push(message);
  };
  const flush = () => {
    flushedAt = Date.now();
    speakingAtFlush = speaking;
    deliver(JSON.stringify({ type: "flush" }));
    settle();
  };
  const settle = () => {
    if (!finishing || flushedAt === undefined || !socket) return;
    if (speaking || received < ended) return;
    const quietFor = Date.now() - flushedAt;
    if (speakingAtFlush || quietFor >= SETTLE_QUIET_MILLIS) {
      const done = finishing;
      finishing = undefined;
      release();
      done.resolve(transcripts.join(" "));
      return;
    }
    clearTimeout(quietTimer);
    quietTimer = setTimeout(settle, SETTLE_QUIET_MILLIS - quietFor);
  };
  const receive = (raw: unknown) => {
    if (typeof raw !== "string") return;
    const decoded = decodeStreamMessage(raw);
    if (Option.isNone(decoded)) return;
    const message = decoded.value;
    if (message.type === "error") {
      breakWith(fail("Provider stream failed"));
      return;
    }
    if (message.type === "data") {
      received += 1;
      const text = message.data.transcript.trim();
      if (text) transcripts.push(text);
    } else if (message.data.signal_type === "START_SPEECH") {
      speaking = true;
      // Speech reported after the flush is not covered by it.
      if (flushedAt !== undefined) {
        speakingAtFlush = true;
        deliver(JSON.stringify({ type: "flush" }));
      }
    } else if (message.data.signal_type === "END_SPEECH") {
      speaking = false;
      ended += 1;
    }
    settle();
  };

  signal?.addEventListener(
    "abort",
    () => breakWith(fail("Dictation was canceled")),
    {
      once: true,
    },
  );
  void (async () => {
    const response = await transport(
      `${API}/speech-to-text/ws?${streamQuery(vocabulary)}`,
      {
        headers: { upgrade: "websocket", "api-subscription-key": key },
        signal: closer.signal,
      },
    );
    const upstream = response.webSocket;
    if (response.status !== 101 || !upstream) {
      await response.body?.cancel();
      throw fail(`Provider request failed (${response.status})`);
    }
    upstream.accept();
    if (broken) {
      upstream.close(1000, "done");
      return;
    }
    upstream.addEventListener("message", (event) => receive(event.data));
    upstream.addEventListener("close", () =>
      breakWith(fail("Provider stream closed")),
    );
    upstream.addEventListener("error", () =>
      breakWith(fail("Provider stream failed")),
    );
    socket = upstream;
    for (const message of queued.splice(0)) upstream.send(message);
    settle();
  })().catch((cause: unknown) => breakWith(requestFailure(cause)));

  return {
    send: (pcm) => {
      if (flushedAt === undefined && pcm.byteLength > 0)
        deliver(
          JSON.stringify({
            audio: {
              data: base64(pcm),
              sample_rate: 16_000,
              encoding: "audio/wav",
            },
          }),
        );
    },
    finish: () =>
      new Promise<string>((resolve, reject) => {
        if (broken) return reject(broken);
        if (finishing || flushedAt !== undefined)
          return reject(fail("Session already finished"));
        finishing = { resolve, reject };
        deadline = setTimeout(
          () => breakWith(fail("Provider timed out")),
          FINISH_TIMEOUT_MILLIS,
        );
        flush();
      }),
    close: () => breakWith(fail("Dictation was canceled")),
  };
};

/**
 * Sarvam implements the Speech plugin's API (`speech.transcribe`) with
 * `saaras:v4` in translate mode, so any spoken language becomes English text,
 * biased toward the dictation vocabulary through `keyterms`:
 * its streaming API for live dictation and its synchronous API, in parallel
 * chunks of at most 29 s, for a saved recording. One API key; no retries.
 */
export const createSarvamSpeechProvider = (
  key: Redacted.Redacted<string>,
  transport: typeof fetch = runtimeFetch,
): SpeechProvider => {
  const secret = () => {
    const value = Redacted.value(key);
    if (value.length === 0) throw fail("Provider key is unavailable");
    return value;
  };
  return {
    transcribe: async (wav, options) =>
      transcribeRecording(secret(), transport, wav, options),
    openSession: (options) => openSarvamSession(secret(), transport, options),
  };
};
